// spec: docs/00 §6 (packages/shared — 클라·서버 공유 단일 원천), WT-M1-01
//
// 배럴 export. 판정 엔진(country-matcher)과 공용 타입을 클라·서버가 동일 번들한다.
// scoring/protocol/auth는 WT-M1-02~04에서 이 배럴에 추가된다.

export type {
  CountryId,
  Continent,
  DifficultyTier,
  Country,
  CountriesDataset,
} from './types/country';
export type {
  GameMode,
  MatchState,
  PerCountryStat,
  RunStats,
  RunVerdict,
} from './types/game';

export { normalizeEn, normalizeKo } from './country-matcher/normalize';
export { toJamoSeq } from './country-matcher/hangul';
export {
  compileTargets,
  matchInput,
  matchInputDetail,
  commonPrefixLen,
  type CompiledTarget,
  type MatchDetail,
} from './country-matcher/match';
