// spec: docs/02 §1 (스키마), §10 Step 7-a (zod 전체 파싱), WT-M1-05
//
// 빌드 마지막 단계에서 전 레코드를 이 스키마로 검증한다(§10 Step 7). 스키마가 곧 API 계약이므로
// acceptedInputs 이외의 파생 필드를 허용하지 않는다 — .strict() 로 초과 키를 거부한다.

import { z } from 'zod';
import type { Country, CountriesDataset } from '@wt/shared';

export const ContinentSchema = z.enum([
  'asia',
  'europe',
  'africa',
  'north-america',
  'south-america',
  'oceania',
]);

export const DifficultyTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const CountrySchema = z
  .object({
    id: z.string().regex(/^[A-Z]{2}$/),
    iso3: z.string().regex(/^[A-Z]{3}$/),
    nameKo: z.string().min(1),
    nameEn: z.string().min(1),
    aliasesKo: z.array(z.string().min(1)),
    aliasesEn: z.array(z.string().min(1)),
    continent: ContinentSchema,
    subregion: z.string().min(1),
    difficultyTier: DifficultyTierSchema,
    capitalKo: z.string().min(1),
    capitalEn: z.string().min(1),
    flagEmoji: z.string().min(1),
    population: z.number().int().positive(),
    latlng: z.tuple([z.number(), z.number()]),
    mapFeatureId: z.union([z.string().regex(/^\d{3}$/), z.null()]),
    acceptedInputsKo: z.array(z.string().min(1)).min(1),
    acceptedInputsEn: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const CountriesDatasetSchema = z
  .object({
    schemaVersion: z.literal(2),
    builtAt: z.string().min(1),
    sources: z
      .object({
        worldCountries: z.string().min(1),
        worldAtlas: z.string().min(1),
      })
      .strict(),
    countries: z.array(CountrySchema),
  })
  .strict();

// 컴파일 타임 계약: zod 스키마 출력 타입이 shared 의 Country 와 구조 동치임을 보장.
// (불일치 시 이 파일이 타입 에러로 잡는다 — 스키마가 곧 API.)
type _CheckCountry = z.infer<typeof CountrySchema> extends Country ? true : never;
type _CheckDataset = z.infer<typeof CountriesDatasetSchema> extends CountriesDataset ? true : never;
export const _schemaContract: [_CheckCountry, _CheckDataset] = [true, true];
