// spec: docs/00 §6 (packages/data — 콘텐츠 데이터), docs/02 §10, WT-M1-05
//
// 런타임 안전 배럴. 빌드 산출 상수(COUNTRIES)와 검증 스키마·타입만 노출한다.
// build/* 는 world-countries(devDep)에 의존하므로 여기서 export 하지 않는다
// (클라·서버 번들에 소스 데이터가 새어들지 않게 한다). 산출물은 손편집 금지.

export { COUNTRIES } from './generated/countries';
export {
  CountrySchema,
  CountriesDatasetSchema,
  ContinentSchema,
  DifficultyTierSchema,
} from './schema';
export type {
  Country,
  CountriesDataset,
  CountryId,
  Continent,
  DifficultyTier,
} from '@wt/shared';
