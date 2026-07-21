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

// scoring (WT-M1-02): 점수·등급·제한시간 순수 함수. 클라·서버 공용 단일 원천.
export { requiredKeystrokes, type KeystrokeSource } from './scoring/keystrokes';
export {
  computePI,
  gradeFromPI,
  computeGrade,
  DEFAULT_GRADE_CONFIG,
  type Grade,
  type GradeConfig,
} from './scoring/grade';
export {
  timeLimitMs,
  DEFAULT_TIME_LIMIT_CONFIG,
  type TimeLimitConfig,
  type TimeLimitSource,
} from './scoring/time-limit';
export {
  computeScore,
  type RunResult,
  type ScoreConfig,
  type ScoreCountry,
} from './scoring/score';

// protocol (WT-M1-03): WS 메시지 전문 + zod 스키마 + 결정적 시딩 + 상수. 클라·서버 공용 단일 원천.
export type {
  C2S_Hello,
  C2S_Join,
  C2S_Ready,
  C2S_Start,
  C2S_Chat,
  C2S_BotAccept,
  C2S_Progress,
  C2S_Complete,
  C2S_TimeSync,
  C2S_Rematch,
  C2S_Leave,
  ClientMessage,
  PlayerPublic,
  S2C_Welcome,
  S2C_RoomState,
  S2C_Countdown,
  S2C_Start,
  S2C_ProgressTick,
  S2C_CountryAccepted,
  S2C_CountryRejected,
  S2C_PlayerFinished,
  S2C_RaceFinished,
  ResultRow,
  S2C_Results,
  S2C_RematchState,
  S2C_RaceSync,
  S2C_TimeSync,
  S2C_BotOffer,
  S2C_Chat,
  S2C_RoomClosed,
  S2C_Error,
  ServerMessage,
} from './protocol/messages';
export {
  HelloSchema,
  JoinSchema,
  ReadySchema,
  StartSchema,
  ChatSchema,
  BotAcceptSchema,
  ProgressSchema,
  CompleteSchema,
  TimeSyncSchema,
  RematchSchema,
  LeaveSchema,
  ClientMessageSchema,
  parseClientMessage,
  type ParseClientMessageResult,
} from './protocol/schemas';
export {
  mulberry32,
  rngFromSeedHex,
  seededShuffle,
  buildRaceSet,
  type RaceMode,
} from './protocol/seeding';
export {
  TICK_MS,
  PROGRESS_THROTTLE_MS,
  GRACE_MS,
  HARDCAP_MS,
  PER_COUNTRY_LIMIT_MS,
  REACTION_FLOOR_MS,
  MAX_KPS,
  REMATCH_VOTE_MS,
  AUTOSTART_WAIT_MS,
  BOT_OFFER_MS,
} from './protocol/constants';
