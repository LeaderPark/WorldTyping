// spec: docs/05 §3 (vitest 필수 케이스 ①~④), WT-M1-03 acceptance(스냅샷 커밋)
import { describe, expect, it } from 'vitest';
import type { Continent, Country, DifficultyTier } from '../types/country';
import { buildRaceSet, mulberry32, rngFromSeedHex, seededShuffle } from './seeding';

function mkCountry(id: string, continent: Continent, tier: DifficultyTier): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo: id,
    nameEn: id,
    aliasesKo: [],
    aliasesEn: [],
    continent,
    subregion: 'Test Region',
    difficultyTier: tier,
    capitalKo: 'Cap',
    capitalEn: 'Cap',
    flagEmoji: '🏳️',
    population: 1_000_000,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [id],
    acceptedInputsEn: [id],
  };
}

// tier1 x8, tier2 x7, tier3 x6 — pick(1,6)/pick(2,5)/pick(3,4)에 여유를 두어
// 셔플 결과가 어떤 순서로 나오든 픽 로직이 정확히 동작하는지 검증한다.
const tier1 = Array.from({ length: 8 }, (_, i) => mkCountry(`T1_${i}`, 'asia', 1));
const tier2 = Array.from({ length: 7 }, (_, i) => mkCountry(`T2_${i}`, 'europe', 2));
const tier3 = Array.from({ length: 6 }, (_, i) => mkCountry(`T3_${i}`, 'africa', 3));
// south-america 풀: 정확히 12개 (docs/05 §2.5 south-america=12)
const southAmerica = Array.from({ length: 12 }, (_, i) => mkCountry(`SA_${i}`, 'south-america', 4));

const fixtureCountries: readonly Country[] = [...tier1, ...tier2, ...tier3, ...southAmerica];

describe('mulberry32', () => {
  it('is deterministic for a fixed seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('returns values in [0, 1)', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('rngFromSeedHex', () => {
  const seedHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('same seed + streamId → same sequence', () => {
    const a = rngFromSeedHex(seedHex, 1);
    const b = rngFromSeedHex(seedHex, 1);
    expect(Array.from({ length: 10 }, () => a())).toEqual(Array.from({ length: 10 }, () => b()));
  });

  it('different streamId → different sequence (independent streams)', () => {
    const a = rngFromSeedHex(seedHex, 1);
    const b = rngFromSeedHex(seedHex, 2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('seededShuffle', () => {
  it('is a permutation of the input (same multiset)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = seededShuffle(input, mulberry32(7));
    expect(shuffled).toHaveLength(input.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3];
    const copy = [...input];
    seededShuffle(input, mulberry32(7));
    expect(input).toEqual(copy);
  });
});

describe('buildRaceSet — race-mixed', () => {
  const seedHex = '0'.repeat(32);

  it('① same seed → same array (1,000 repeats)', () => {
    const first = buildRaceSet(seedHex, 'race-mixed', null, fixtureCountries);
    for (let i = 0; i < 1000; i++) {
      expect(buildRaceSet(seedHex, 'race-mixed', null, fixtureCountries)).toEqual(first);
    }
  });

  it('② different seed → mismatched array', () => {
    // 주의: 4개 32-bit 청크를 단순 XOR-폴드하므로(rngFromSeedHex), 청크가 서로 대칭적인 hex
    // (예: 'aa..'.repeat 류)는 우연히 같은 state로 접힐 수 있다. crypto.getRandomValues로
    // 생성한 실제 seed에는 그런 대칭이 없으므로, 테스트도 비대칭(random) hex 두 개를 쓴다.
    const a = buildRaceSet('c42a8f7f14e57bd39a63590ba6582363', 'race-mixed', null, fixtureCountries);
    const b = buildRaceSet('643c960787d8cff8db9a573c15ddf28f', 'race-mixed', null, fixtureCountries);
    expect(a).not.toEqual(b);
  });

  it('③ returns 15 unique ids with tier distribution 6/5/4', () => {
    const set = buildRaceSet(seedHex, 'race-mixed', null, fixtureCountries);
    expect(set).toHaveLength(15);
    expect(new Set(set).size).toBe(15);

    const byId = new Map(fixtureCountries.map((c) => [c.id, c] as const));
    const counts = { 1: 0, 2: 0, 3: 0 } as Record<1 | 2 | 3, number>;
    for (const id of set) {
      const tier = byId.get(id)?.difficultyTier;
      if (tier === 1 || tier === 2 || tier === 3) counts[tier]++;
    }
    expect(counts[1]).toBe(6);
    expect(counts[2]).toBe(5);
    expect(counts[3]).toBe(4);
  });

  it('snapshot — regression guard for set reproducibility', () => {
    const set = buildRaceSet('0'.repeat(32), 'race-mixed', null, fixtureCountries);
    expect(set).toMatchSnapshot();
  });
});

describe('buildRaceSet — race-continent', () => {
  it('④ south-america pool (12 < 15) returns all 12', () => {
    const set = buildRaceSet('3'.repeat(32), 'race-continent', 'south-america', fixtureCountries);
    expect(set).toHaveLength(12);
    expect(new Set(set).size).toBe(12);
    expect(new Set(set)).toEqual(new Set(southAmerica.map((c) => c.id)));
  });

  it('same seed → same array for race-continent', () => {
    const a = buildRaceSet('4'.repeat(32), 'race-continent', 'south-america', fixtureCountries);
    const b = buildRaceSet('4'.repeat(32), 'race-continent', 'south-america', fixtureCountries);
    expect(a).toEqual(b);
  });
});

describe('buildRaceSet — race-tier', () => {
  it('returns only ids from the requested tier', () => {
    const set = buildRaceSet('5'.repeat(32), 'race-tier', '1', fixtureCountries);
    const byId = new Map(fixtureCountries.map((c) => [c.id, c] as const));
    for (const id of set) {
      expect(byId.get(id)?.difficultyTier).toBe(1);
    }
  });
});
