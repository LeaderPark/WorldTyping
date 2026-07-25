// spec: docs/00 §6, docs/03 §2·§5 (packages/engine — 프레임워크 독립 게임 엔진 배럴).
// WT-M2-01: 입력 컨트롤러 + 타수 계상기. WT-M2-02: 세션 FSM + 모드 규칙 5종 + 리플레이 로그.
// React/DOM import 금지(input-controller.ts만 DOM 타입 허용 — eslint no-restricted-imports).

export const ENGINE_PACKAGE_NAME = "@wt/engine" as const;

export { KeystrokeAccountant, type KeystrokeDelta } from "./accountant";
export { TypingInputController, type TypingEvent } from "./input-controller";

// WT-M2-02: 세션 상태머신 + finished 결과.
export {
  GameSessionEngine,
  COUNTDOWN_MS,
  RETRY_COUNTDOWN_MS,
  STATS_TICK_MS,
  type SessionPhase,
  type EngineEvent,
  type EngineDeps,
  type EngineSnapshot,
  type RunResult,
} from "./session";

// WT-M2-02: 모드 규칙 전략 객체 5종 + 팩토리. WT-CH-04: chase 어댑터(chaseRules) 추가.
export {
  createModeRules,
  continentRules,
  tierRules,
  worldtourRules,
  dailyRules,
  raceRules,
  chaseRules,
  type ModeRules,
  type MutableRunState,
} from "./rules";

// WT-CH-04: "골드 러너"(chase) 세션 오케스트레이션 + 3-타깃 입력(docs/09 §6.2, §11-D97).
export {
  ChaseSessionEngine,
  type ChaseEngineEvent,
  type ChaseEngineDeps,
  type ChaseSnapshot,
  type ChaseRunSubmission,
  type ChaseOutcome,
  type CandidateView,
  type PoliceView,
} from "./chase-session";

// WT-M2-02: 리플레이 로그(ring buffer) + 제출 페이로드 조립.
export {
  RunLog,
  RUN_LOG_CAPACITY,
  type ReplayEntry,
  type InputDigest,
  type SubmissionCountry,
  type RunSubmission,
} from "./replay";
