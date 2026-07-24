// spec: docs/00 §6 (packages/data — 콘텐츠 데이터), docs/02 §10, WT-M1-05, WT-CH-01(docs/09 §5.1)
//
// 런타임 안전 배럴. 빌드 산출 상수(COUNTRIES, CHASE_GRAPH)와 검증 스키마·타입만 노출한다.
// build/* 는 world-countries(devDep)에 의존하므로 값은 여기서 export 하지 않는다(클라·서버 번들에
// 소스 데이터가 새어들지 않게 한다) — 단 ChaseGraphDataset 등 타입은 `export type`(erasable, 런타임
// import 0)이라 예외적으로 재노출한다. 산출물은 손편집 금지.
// CHASE_GRAPH는 chase(골드 러너) 심(WT-CH-02, packages/shared/src/chase/)의 골든 벡터 오라클로
// devDependency 한정 소비된다 — shared 자체는 이 값을 파라미터로만 주입받는다(런타임 의존 0 유지).

export { COUNTRIES } from './generated/countries';
export { CHASE_GRAPH } from './generated/chase-graph';
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
export type {
  ChaseGraphDataset,
  ChaseGraphNode,
  ChaseGraphNearestEntry,
} from './build/chase-graph';
