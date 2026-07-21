// spec: docs/02 §10·§11·§4.3·§5.1, docs/00 §11-D1·D3·D22, WT-M1-05
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Country } from '../index';
import { assemble, buildDataset, loadInputs, type PipelineInputs } from './pipeline';

const result = buildDataset();
const byId = new Map(result.dataset.countries.map((c) => [c.id, c]));

describe('레코드 수·세트(§1, §11-D1)', () => {
  it('총 198 레코드', () => {
    expect(result.dataset.countries.length).toBe(198);
    expect(result.stats.total).toBe(198);
  });
  it('un195 필터 시 195, extended 3', () => {
    expect(result.stats.un195).toBe(195);
    expect(result.stats.extended).toBe(3);
  });
  it('id 오름차순 정렬', () => {
    const ids = result.dataset.countries.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
  it('schemaVersion=2, sources 기록', () => {
    expect(result.dataset.schemaVersion).toBe(2);
    expect(result.dataset.sources.worldCountries).toBe('5.1.0');
    expect(result.dataset.sources.worldAtlas).toBe('2.0.2');
  });
});

describe('§11 샘플 10개 — 필드 단위 명시 일치', () => {
  const samples: Country[] = [
    {
      id: 'KR', iso3: 'KOR', nameKo: '대한민국', nameEn: 'South Korea',
      aliasesKo: ['한국', '남한'], aliasesEn: ['Korea', 'Republic of Korea', 'ROK'],
      continent: 'asia', subregion: 'Eastern Asia', difficultyTier: 1,
      capitalKo: '서울', capitalEn: 'Seoul', flagEmoji: '🇰🇷',
      population: 51712619, latlng: [37, 127.5], mapFeatureId: '410',
      acceptedInputsKo: ['대한민국', '한국', '남한'],
      acceptedInputsEn: ['southkorea', 'korea', 'republicofkorea', 'rok'],
    },
    {
      id: 'US', iso3: 'USA', nameKo: '미국', nameEn: 'United States',
      aliasesKo: ['미합중국'], aliasesEn: ['USA', 'United States of America', 'America', 'US'],
      continent: 'north-america', subregion: 'North America', difficultyTier: 1,
      capitalKo: '워싱턴 D.C.', capitalEn: 'Washington, D.C.', flagEmoji: '🇺🇸',
      population: 341000000, latlng: [38, -97], mapFeatureId: '840',
      acceptedInputsKo: ['미국', '미합중국'],
      acceptedInputsEn: ['unitedstates', 'usa', 'unitedstatesofamerica', 'america', 'us'],
    },
    {
      id: 'JP', iso3: 'JPN', nameKo: '일본', nameEn: 'Japan',
      aliasesKo: [], aliasesEn: ['Nippon'],
      continent: 'asia', subregion: 'Eastern Asia', difficultyTier: 1,
      capitalKo: '도쿄', capitalEn: 'Tokyo', flagEmoji: '🇯🇵',
      population: 123294513, latlng: [36, 138], mapFeatureId: '392',
      acceptedInputsKo: ['일본'], acceptedInputsEn: ['japan', 'nippon'],
    },
    {
      id: 'FR', iso3: 'FRA', nameKo: '프랑스', nameEn: 'France',
      aliasesKo: ['불란서'], aliasesEn: ['French Republic'],
      continent: 'europe', subregion: 'Western Europe', difficultyTier: 1,
      capitalKo: '파리', capitalEn: 'Paris', flagEmoji: '🇫🇷',
      population: 68170228, latlng: [46, 2], mapFeatureId: '250',
      acceptedInputsKo: ['프랑스', '불란서'], acceptedInputsEn: ['france', 'frenchrepublic'],
    },
    {
      id: 'DE', iso3: 'DEU', nameKo: '독일', nameEn: 'Germany',
      aliasesKo: ['독일연방공화국'], aliasesEn: ['Deutschland', 'Federal Republic of Germany'],
      continent: 'europe', subregion: 'Western Europe', difficultyTier: 1,
      capitalKo: '베를린', capitalEn: 'Berlin', flagEmoji: '🇩🇪',
      population: 84482267, latlng: [51, 9], mapFeatureId: '276',
      acceptedInputsKo: ['독일', '독일연방공화국'],
      acceptedInputsEn: ['germany', 'deutschland', 'federalrepublicofgermany'],
    },
    {
      id: 'BR', iso3: 'BRA', nameKo: '브라질', nameEn: 'Brazil',
      aliasesKo: [], aliasesEn: ['Brasil', 'Federative Republic of Brazil'],
      continent: 'south-america', subregion: 'South America', difficultyTier: 1,
      capitalKo: '브라질리아', capitalEn: 'Brasília', flagEmoji: '🇧🇷',
      population: 216422446, latlng: [-10, -55], mapFeatureId: '076',
      acceptedInputsKo: ['브라질'],
      acceptedInputsEn: ['brazil', 'brasil', 'federativerepublicofbrazil'],
    },
    {
      id: 'EG', iso3: 'EGY', nameKo: '이집트', nameEn: 'Egypt',
      aliasesKo: [], aliasesEn: ['Arab Republic of Egypt'],
      continent: 'africa', subregion: 'Northern Africa', difficultyTier: 2,
      capitalKo: '카이로', capitalEn: 'Cairo', flagEmoji: '🇪🇬',
      population: 112716598, latlng: [27, 30], mapFeatureId: '818',
      acceptedInputsKo: ['이집트'], acceptedInputsEn: ['egypt', 'arabrepublicofegypt'],
    },
    {
      id: 'KZ', iso3: 'KAZ', nameKo: '카자흐스탄', nameEn: 'Kazakhstan',
      aliasesKo: [], aliasesEn: ['Republic of Kazakhstan'],
      continent: 'asia', subregion: 'Central Asia', difficultyTier: 4,
      capitalKo: '아스타나', capitalEn: 'Astana', flagEmoji: '🇰🇿',
      population: 19606633, latlng: [48, 68], mapFeatureId: '398',
      acceptedInputsKo: ['카자흐스탄'], acceptedInputsEn: ['kazakhstan', 'republicofkazakhstan'],
    },
    {
      id: 'CI', iso3: 'CIV', nameKo: '코트디부아르', nameEn: 'Ivory Coast',
      aliasesKo: ['아이보리코스트'], aliasesEn: ["Côte d'Ivoire", "Republic of Côte d'Ivoire"],
      continent: 'africa', subregion: 'Western Africa', difficultyTier: 4,
      capitalKo: '야무수크로', capitalEn: 'Yamoussoukro', flagEmoji: '🇨🇮',
      population: 28873034, latlng: [8, -5], mapFeatureId: '384',
      acceptedInputsKo: ['코트디부아르', '아이보리코스트'],
      acceptedInputsEn: ['ivorycoast', 'cotedivoire', 'republicofcotedivoire'],
    },
    {
      id: 'VU', iso3: 'VUT', nameKo: '바누아투', nameEn: 'Vanuatu',
      aliasesKo: [], aliasesEn: ['Republic of Vanuatu'],
      continent: 'oceania', subregion: 'Melanesia', difficultyTier: 5,
      capitalKo: '포트빌라', capitalEn: 'Port Vila', flagEmoji: '🇻🇺',
      population: 334506, latlng: [-16, 167], mapFeatureId: '548',
      acceptedInputsKo: ['바누아투'], acceptedInputsEn: ['vanuatu', 'republicofvanuatu'],
    },
  ];

  for (const sample of samples) {
    it(`${sample.id} 전 필드 일치`, () => {
      expect(byId.get(sample.id)).toEqual(sample);
    });
  }
});

describe('대륙 카운트(§5.1, §11-D3)', () => {
  it('un195: asia47/europe45/africa54/NA23/SA12/OC14', () => {
    expect(result.stats.continentCounts).toEqual({
      asia: 47, europe: 45, africa: 54, 'north-america': 23, 'south-america': 12, oceania: 14,
    });
  });
});

describe('티어(§4.2·§4.3)', () => {
  it('분포가 목표 ±5 이내', () => {
    const target: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 20, 2: 30, 3: 45, 4: 55, 5: 48 };
    for (const t of [1, 2, 3, 4, 5] as const) {
      expect(Math.abs(result.stats.tierDistribution[t] - target[t])).toBeLessThanOrEqual(5);
    }
  });
  it('§4.3 대표 30개국 최종 티어 일치', () => {
    const expected: Record<string, number> = {
      US: 1, JP: 1, CN: 1, GB: 1, FR: 1, DE: 1, KR: 1, IT: 1, AU: 1, BR: 1,
      IN: 1, CA: 1, RU: 1, MX: 1, TH: 2, VN: 2, TR: 2, EG: 2, AR: 2, ES: 1,
      PL: 3, PT: 2, KZ: 4, PE: 3, MA: 3, KE: 3, UZ: 4, BF: 4, TV: 5, KM: 5,
    };
    for (const [id, tier] of Object.entries(expected)) {
      expect(byId.get(id)?.difficultyTier, id).toBe(tier);
    }
  });
});

describe('mapFeatureId 바인딩(§7)', () => {
  it('매칭 + 서클폴백 합 = 198', () => {
    expect(result.stats.mapMatched + result.stats.mapCircleFallback).toBe(198);
  });
  it('mapFeatureId 는 3자리 문자열 또는 null', () => {
    for (const c of result.dataset.countries) {
      if (c.mapFeatureId !== null) expect(c.mapFeatureId).toMatch(/^\d{3}$/);
    }
  });
  it('코소보(XK)는 properties.name geom 에 id 부재 → null', () => {
    expect(byId.get('XK')?.mapFeatureId).toBeNull();
  });
});

describe('전역 유일성(§10 Step 7-b·c)', () => {
  it('ko acceptedInputs 전역 유일', () => {
    const seen = new Map<string, string>();
    for (const c of result.dataset.countries)
      for (const i of c.acceptedInputsKo) {
        expect(seen.has(i) ? seen.get(i) : c.id, `dup ${i}`).toBe(c.id);
        seen.set(i, c.id);
      }
  });
  it('en acceptedInputs 전역 유일', () => {
    const seen = new Map<string, string>();
    for (const c of result.dataset.countries)
      for (const i of c.acceptedInputsEn) {
        expect(seen.has(i) ? seen.get(i) : c.id, `dup ${i}`).toBe(c.id);
        seen.set(i, c.id);
      }
  });
  it('"콩고" 단독은 CG의 EXACT(§3.4 note)', () => {
    expect(byId.get('CG')?.acceptedInputsKo).toContain('콩고');
    expect(byId.get('CD')?.acceptedInputsKo).not.toContain('콩고');
  });
});

describe('결정성(§10 Step 8)', () => {
  it('두 번 연속 빌드 결과가 바이트 동일', () => {
    const a = buildDataset();
    const b = buildDataset();
    expect(a.countriesJson).toBe(b.countriesJson);
    expect(a.generatedTs).toBe(b.generatedTs);
    expect(a.topojsonJson).toBe(b.topojsonJson);
    expect(a.manifestJson).toBe(b.manifestJson);
  });
  it('커밋된 산출물이 신선(fresh build와 동일)', () => {
    const committed = readFileSync(
      new URL('../../../../apps/web/public/data/countries.json', import.meta.url),
      'utf8',
    );
    expect(committed).toBe(result.countriesJson);
    const committedTs = readFileSync(
      new URL('../generated/countries.ts', import.meta.url),
      'utf8',
    );
    expect(committedTs).toBe(result.generatedTs);
  });
  it('manifest 에 SHA-256 기록', () => {
    const m = JSON.parse(result.manifestJson);
    expect(m.countries.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.map.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.countries.count).toBe(198);
  });
});

describe('예외 계약(§10 — 누락은 throw)', () => {
  const base = loadInputs();
  const cloneSource = (mut: (id: string, s: PipelineInputs['source'][number]) => PipelineInputs['source'][number]) =>
    base.source.map((s) => mut(s.cca2, s));

  it('content-set id 가 world-countries 에 없으면 throw', () => {
    const bad = { ...base, contentSets: { ...base.contentSets, un195: [...base.contentSets.un195, 'ZZ'] } };
    expect(() => assemble(bad)).toThrow(/not in world-countries/);
  });
  it('nameKo 부재(override·source 둘 다 없음)면 throw', () => {
    const src = cloneSource((id, s) => (id === 'JP' ? { ...s, translations: undefined } : s));
    const names = { ...base.namesKo };
    delete names.JP;
    expect(() => assemble({ ...base, source: src, namesKo: names })).toThrow(/missing nameKo/);
  });
  it('capitalKo 부재면 throw', () => {
    const caps = { ...base.capitalsKo };
    delete caps.KR;
    expect(() => assemble({ ...base, capitalsKo: caps })).toThrow(/missing capitalKo/);
  });
  it('population 부재면 throw', () => {
    const pop = { ...base.population };
    delete pop.KR;
    expect(() => assemble({ ...base, population: pop })).toThrow(/missing population/);
  });
  it('recognition 부재면 throw', () => {
    const rec = { ...base.recognition };
    delete rec.KR;
    expect(() => assemble({ ...base, recognition: rec })).toThrow(/missing recognition/);
  });
  it('대륙 카운트 이탈이면 throw', () => {
    const un195 = base.contentSets.un195.filter((id) => id !== 'JP'); // asia 46
    expect(() => assemble({ ...base, contentSets: { ...base.contentSets, un195 } })).toThrow(/continent count mismatch/);
  });
  it('ko acceptedInput 충돌이면 throw', () => {
    const aliases = { ...base.aliases, JP: { ko: ['미국'], en: [] } }; // JP 가 US의 "미국"과 충돌
    expect(() => assemble({ ...base, aliases })).toThrow(/ko acceptedInput collision/);
  });
  it('ko 자모 시퀀스 충돌이면 throw(문자열은 달라도)', () => {
    // "가"(음절)와 "ㄱㅏ"(낱자모)는 문자열이 다르지만 자모 시퀀스가 동일 → 자모 충돌
    const aliases = { ...base.aliases, CN: { ko: ['가'], en: [] }, JP: { ko: ['ㄱㅏ'], en: [] } };
    expect(() => assemble({ ...base, aliases })).toThrow(/jamo collision/);
  });
  it('en acceptedInput 충돌이면 throw', () => {
    const aliases = { ...base.aliases, JP: { ko: [], en: ['United States'] } };
    expect(() => assemble({ ...base, aliases })).toThrow(/en acceptedInput collision/);
  });
  it('capital 이 비면 capitalEn 은 nameEn 으로 폴백', () => {
    const src = cloneSource((id, s) => (id === 'KR' ? { ...s, capital: [] } : s));
    const r = assemble({ ...base, source: src });
    const kr = r.dataset.countries.find((c) => c.id === 'KR')!;
    expect(kr.capitalEn).toBe('South Korea');
  });
});
