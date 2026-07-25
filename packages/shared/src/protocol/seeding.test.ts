// spec: docs/05 §3 (vitest 필수 케이스 ①~④), WT-M1-03 acceptance(스냅샷 커밋),
//       docs/00 §11-D5(티어 세트)·§11-D107(T4·T5 가중 샘플링, WT-TIER-DIFFICULTY)
import { describe, expect, it } from 'vitest';
import type { Continent, Country, DifficultyTier } from '../types/country';
import { requiredKeystrokes } from '../scoring/keystrokes';
import {
  buildRaceSet,
  buildTierSet,
  mulberry32,
  nextUint32,
  rngFromSeedHex,
  seededShuffle,
  tierSamplingWeight,
  TIER_SET_SIZE,
} from './seeding';

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

// ─────────────────────────────────────────────────────────────────────────────
// 티어 서바이벌 세트 — §11-D5(일일 시드 20개국) + §11-D107(T4·T5 긴 이름 가중 샘플링)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 티어 풀 픽스처. ko/en 이름 길이를 서로 독립적으로 흔들어(en 3~20자, ko 1~8음절=2~16자모)
 * "가중치가 lang에 따라 달라진다"까지 검증 가능하게 한다. id는 오름차순(생성물 계약과 동일).
 */
function mkTierPool(tier: DifficultyTier, n = 30): Country[] {
  return Array.from({ length: n }, (_, i) => {
    const enLen = 3 + ((i * 7) % 18); // 3..20
    const koSyllables = 1 + ((i * 5) % 8); // 1..8음절
    return {
      ...mkCountry(`P${tier}_${String(i).padStart(2, '0')}`, 'asia', tier),
      nameEn: 'a'.repeat(enLen),
      nameKo: '가'.repeat(koSyllables),
    };
  });
}

const TIER3_POOL = mkTierPool(3);
const TIER4_POOL = mkTierPool(4);
const TIER5_POOL = mkTierPool(5);
const TIER_FIXTURE: readonly Country[] = [...TIER3_POOL, ...TIER4_POOL, ...TIER5_POOL];

// 골든 벡터(§11-D107 결정성 잠금). seed='b7c1d2e3f4a5960718293a4b5c6d7e8f' 고정.
// 이 값이 바뀌면 = 세트 생성이 바뀌었다는 뜻이다 — 이미 발급된 runToken의 setHash 재현이
// 깨지므로(제출 시 set_mismatch) 의도적 변경일 때만 갱신하고 §11 결정 행을 함께 남길 것.
const GOLDEN_T3: readonly string[] = [
  'P3_21', 'P3_15', 'P3_04', 'P3_06', 'P3_24', 'P3_20', 'P3_00', 'P3_01', 'P3_28', 'P3_14',
  'P3_22', 'P3_27', 'P3_23', 'P3_17', 'P3_13', 'P3_05', 'P3_16', 'P3_03', 'P3_09', 'P3_18',
];
const GOLDEN_T4: readonly string[] = [
  'P4_08', 'P4_10', 'P4_27', 'P4_17', 'P4_16', 'P4_15', 'P4_28', 'P4_02', 'P4_04', 'P4_13',
  'P4_19', 'P4_09', 'P4_25', 'P4_03', 'P4_01', 'P4_22', 'P4_06', 'P4_05', 'P4_23', 'P4_21',
];
const GOLDEN_T5: readonly string[] = [
  'P5_06', 'P5_28', 'P5_23', 'P5_14', 'P5_10', 'P5_19', 'P5_09', 'P5_24', 'P5_25', 'P5_13',
  'P5_02', 'P5_20', 'P5_04', 'P5_22', 'P5_05', 'P5_15', 'P5_12', 'P5_17', 'P5_07', 'P5_29',
];

/** 세트의 평균 L_i(판정 자모열 길이). 가중 샘플링이 실제로 긴 이름을 당겼는지 재는 척도. */
function meanKeystrokes(ids: readonly string[], lang: 'ko' | 'en'): number {
  const byId = new Map(TIER_FIXTURE.map((c) => [c.id, c] as const));
  const sum = ids.reduce((a, id) => a + requiredKeystrokes(byId.get(id)!, lang), 0);
  return sum / ids.length;
}

describe('nextUint32 (가중 샘플링의 정수 어댑터)', () => {
  it('mulberry32 원본 u32를 오차 없이 복원한다(2의 거듭제곱 나눗셈은 정확)', () => {
    const a = mulberry32(0xdeadbeef);
    const b = mulberry32(0xdeadbeef);
    for (let i = 0; i < 200; i++) {
      const expected = Math.round(a() * 4294967296);
      const got = nextUint32(b);
      expect(got).toBe(expected);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('tierSamplingWeight (§11-D107 — 정수 가중치)', () => {
  it('T5 = L², T4 = L×floor(100√L), T1~T3 = 1 (전부 정수)', () => {
    expect(tierSamplingWeight(10, 5)).toBe(100);
    expect(tierSamplingWeight(16, 5)).toBe(256);
    expect(tierSamplingWeight(4, 4)).toBe(4 * 200); // floor(100·√4)=200
    expect(tierSamplingWeight(9, 4)).toBe(9 * 300);
    expect(tierSamplingWeight(10, 4)).toBe(10 * 316); // floor(100·√10)=316
    for (const tier of [1, 2, 3] as const) {
      expect(tierSamplingWeight(20, tier)).toBe(1);
    }
    for (let l = 1; l <= 40; l++) {
      expect(Number.isInteger(tierSamplingWeight(l, 4))).toBe(true);
      expect(Number.isInteger(tierSamplingWeight(l, 5))).toBe(true);
    }
  });

  it('L=0(빈 이름)도 가중치 ≥ 1 — 풀 전체 가중치 0으로 무너지지 않는다', () => {
    expect(tierSamplingWeight(0, 5)).toBe(1);
    expect(tierSamplingWeight(0, 4)).toBe(100);
  });

  it('L에 대해 단조 증가한다(긴 이름일수록 더 자주 뽑힌다)', () => {
    for (const tier of [4, 5] as const) {
      for (let l = 1; l < 30; l++) {
        expect(tierSamplingWeight(l + 1, tier)).toBeGreaterThan(tierSamplingWeight(l, tier));
      }
    }
  });
});

describe('buildTierSet — 공통 계약(§11-D5)', () => {
  const seedHex = 'b7c1d2e3f4a5960718293a4b5c6d7e8f';

  it('요청 티어의 국가만, 중복 없이 TIER_SET_SIZE개', () => {
    const byId = new Map(TIER_FIXTURE.map((c) => [c.id, c] as const));
    for (const tier of [3, 4, 5] as const) {
      const set = buildTierSet(seedHex, tier, TIER_FIXTURE, 'ko');
      expect(set).toHaveLength(TIER_SET_SIZE);
      expect(new Set(set).size).toBe(TIER_SET_SIZE);
      for (const id of set) expect(byId.get(id)!.difficultyTier).toBe(tier);
    }
  });

  it('같은 (seed, tier, lang) → 항상 같은 배열 (클라·서버 재현성, 500회)', () => {
    for (const tier of [3, 4, 5] as const) {
      const first = buildTierSet(seedHex, tier, TIER_FIXTURE, 'ko');
      for (let i = 0; i < 500; i++) {
        expect(buildTierSet(seedHex, tier, TIER_FIXTURE, 'ko')).toEqual(first);
      }
    }
  });

  it('다른 seed → 다른 세트', () => {
    const a = buildTierSet('c42a8f7f14e57bd39a63590ba6582363', 5, TIER_FIXTURE, 'ko');
    const b = buildTierSet('643c960787d8cff8db9a573c15ddf28f', 5, TIER_FIXTURE, 'ko');
    expect(a).not.toEqual(b);
  });

  it('풀이 size보다 작으면 풀 전체를 반환한다(부족분 패딩 없음)', () => {
    const small = TIER5_POOL.slice(0, 7);
    const set = buildTierSet(seedHex, 5, small, 'en');
    expect(set).toHaveLength(7);
    expect(new Set(set)).toEqual(new Set(small.map((c) => c.id)));
  });
});

describe('buildTierSet — T1~T3 균등(현행 유지)', () => {
  const seedHex = 'b7c1d2e3f4a5960718293a4b5c6d7e8f';

  it('종전 로직(seededShuffle 스트림 1 → 앞 20개)과 비트 동일 — 기존 세트 무회귀', () => {
    const legacy = seededShuffle(
      TIER_FIXTURE.filter((c) => c.difficultyTier === 3).map((c) => c.id),
      rngFromSeedHex(seedHex, 1),
    ).slice(0, TIER_SET_SIZE);
    expect(buildTierSet(seedHex, 3, TIER_FIXTURE, 'ko')).toEqual(legacy);
  });

  it('lang과 무관하게 동일 세트(가중치 미적용 티어)', () => {
    expect(buildTierSet(seedHex, 3, TIER_FIXTURE, 'ko')).toEqual(
      buildTierSet(seedHex, 3, TIER_FIXTURE, 'en'),
    );
  });

  it('골든 벡터 — T3 / seed=b7c1…7e8f / ko', () => {
    expect(buildTierSet(seedHex, 3, TIER_FIXTURE, 'ko')).toEqual(GOLDEN_T3);
  });
});

describe('buildTierSet — T4·T5 긴 이름 가중 샘플링(§11-D107)', () => {
  const seedHex = 'b7c1d2e3f4a5960718293a4b5c6d7e8f';

  it('골든 벡터 — T4 / seed=b7c1…7e8f / en', () => {
    expect(buildTierSet(seedHex, 4, TIER_FIXTURE, 'en')).toEqual(GOLDEN_T4);
  });

  it('골든 벡터 — T5 / seed=b7c1…7e8f / en', () => {
    expect(buildTierSet(seedHex, 5, TIER_FIXTURE, 'en')).toEqual(GOLDEN_T5);
  });

  it('T5 세트의 평균 L이 균등 샘플링 대비 유의미하게 길다(동일 seed 비교)', () => {
    const weighted = buildTierSet(seedHex, 5, TIER_FIXTURE, 'en');
    const uniform = seededShuffle(
      TIER5_POOL.map((c) => c.id),
      rngFromSeedHex(seedHex, 1),
    ).slice(0, TIER_SET_SIZE);
    const w = meanKeystrokes(weighted, 'en');
    const u = meanKeystrokes(uniform, 'en');
    expect(w).toBeGreaterThan(u * 1.15); // 15%+ 상승 = "유의미"의 조작적 정의
  });

  it('편향 강도 T5 > T4 > 균등 (10개 시드 평균 — 고정 시드라 결정적)', () => {
    const seeds = Array.from({ length: 10 }, (_, i) => String(i).repeat(32).slice(0, 32));
    const mean = (f: (s: string) => readonly string[]) =>
      seeds.reduce((a, s) => a + meanKeystrokes(f(s), 'en'), 0) / seeds.length;
    const uniform = mean((s) =>
      seededShuffle(TIER5_POOL.map((c) => c.id), rngFromSeedHex(s, 1)).slice(0, TIER_SET_SIZE),
    );
    const t4 = mean((s) => buildTierSet(s, 4, TIER_FIXTURE, 'en'));
    const t5 = mean((s) => buildTierSet(s, 5, TIER_FIXTURE, 'en'));
    expect(t5).toBeGreaterThan(t4);
    expect(t4).toBeGreaterThan(uniform);
  });

  it('lang에 따라 세트가 갈린다(L_i가 ko/en에서 다른 픽스처)', () => {
    expect(buildTierSet(seedHex, 5, TIER_FIXTURE, 'ko')).not.toEqual(
      buildTierSet(seedHex, 5, TIER_FIXTURE, 'en'),
    );
    // ko 세트도 ko 기준으로는 균등 대비 길다(언어별로 자기 기준의 편향이 성립).
    const koWeighted = meanKeystrokes(buildTierSet(seedHex, 5, TIER_FIXTURE, 'ko'), 'ko');
    const koUniform = meanKeystrokes(
      seededShuffle(TIER5_POOL.map((c) => c.id), rngFromSeedHex(seedHex, 1)).slice(0, TIER_SET_SIZE),
      'ko',
    );
    expect(koWeighted).toBeGreaterThan(koUniform);
  });

  it('출제 순서는 길이에 편향되지 않는다(뽑기 후 순서 재셔플 — 앞 5개 vs 뒤 5개)', () => {
    // 가중 추출의 draw 순서를 그대로 쓰면 앞쪽에 최장국이 몰린다. 스트림 2 재셔플이 그걸 푼다.
    const seeds = Array.from({ length: 12 }, (_, i) => `${i}`.repeat(32).slice(0, 32));
    let head = 0;
    let tail = 0;
    for (const s of seeds) {
      const set = buildTierSet(s, 5, TIER_FIXTURE, 'en');
      head += meanKeystrokes(set.slice(0, 5), 'en');
      tail += meanKeystrokes(set.slice(-5), 'en');
    }
    expect(Math.abs(head - tail) / seeds.length).toBeLessThan(2.0); // 평균 L 차이 2타 미만
  });
});
