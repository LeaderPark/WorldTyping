// spec: docs/02 §1·§10 Step 7-a, WT-M1-05
import { describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import { CountrySchema, CountriesDatasetSchema, ContinentSchema, DifficultyTierSchema } from './schema';

const VALID: Country = {
  id: 'KR', iso3: 'KOR', nameKo: '대한민국', nameEn: 'South Korea',
  aliasesKo: ['한국'], aliasesEn: ['Korea'],
  continent: 'asia', subregion: 'Eastern Asia', difficultyTier: 1,
  capitalKo: '서울', capitalEn: 'Seoul', flagEmoji: '🇰🇷',
  population: 51712619, latlng: [37, 127.5], mapFeatureId: '410',
  acceptedInputsKo: ['대한민국', '한국'], acceptedInputsEn: ['southkorea', 'korea'],
};

describe('CountrySchema', () => {
  it('유효 레코드를 통과', () => {
    expect(CountrySchema.parse(VALID)).toEqual(VALID);
  });
  it('mapFeatureId null 허용', () => {
    expect(() => CountrySchema.parse({ ...VALID, mapFeatureId: null })).not.toThrow();
  });
  it('초과 키를 거부(.strict — 스키마가 곧 API)', () => {
    expect(() => CountrySchema.parse({ ...VALID, extra: 1 })).toThrow();
  });
  it('잘못된 id 형식 거부', () => {
    expect(() => CountrySchema.parse({ ...VALID, id: 'kor' })).toThrow();
  });
  it('티어 범위 밖 거부', () => {
    expect(() => CountrySchema.parse({ ...VALID, difficultyTier: 6 })).toThrow();
  });
  it('음수/0 인구 거부', () => {
    expect(() => CountrySchema.parse({ ...VALID, population: 0 })).toThrow();
    expect(() => CountrySchema.parse({ ...VALID, population: -1 })).toThrow();
  });
  it('acceptedInputs 비면 거부', () => {
    expect(() => CountrySchema.parse({ ...VALID, acceptedInputsKo: [] })).toThrow();
  });
  it('mapFeatureId 3자리 아니면 거부', () => {
    expect(() => CountrySchema.parse({ ...VALID, mapFeatureId: '41' })).toThrow();
  });
});

describe('ContinentSchema / DifficultyTierSchema', () => {
  it('대륙 enum', () => {
    expect(ContinentSchema.parse('oceania')).toBe('oceania');
    expect(() => ContinentSchema.parse('mars')).toThrow();
  });
  it('티어 리터럴 유니온', () => {
    expect(DifficultyTierSchema.parse(3)).toBe(3);
    expect(() => DifficultyTierSchema.parse(0)).toThrow();
  });
});

describe('CountriesDatasetSchema', () => {
  it('유효 데이터셋 통과', () => {
    const ds = {
      schemaVersion: 2 as const,
      builtAt: '2026-07-21T00:00:00.000Z',
      sources: { worldCountries: '5.1.0', worldAtlas: '2.0.2' },
      countries: [VALID],
    };
    expect(() => CountriesDatasetSchema.parse(ds)).not.toThrow();
  });
  it('schemaVersion 불일치 거부', () => {
    expect(() =>
      CountriesDatasetSchema.parse({
        schemaVersion: 1,
        builtAt: 'x',
        sources: { worldCountries: 'a', worldAtlas: 'b' },
        countries: [],
      }),
    ).toThrow();
  });
});
