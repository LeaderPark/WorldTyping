// spec: docs/09 §6.1(모듈 배치), docs/00 §11-D90·D91. "골드 러너"(chase) 심·선택지·상수 공개 배럴.
// 클라 표시·서버 검증·runs/submit 재계산이 이 모듈들을 동일하게 import한다(판정·점수 패리티 확장, Gotcha 3).

export type {
  ChaseConstants,
  ChaseConstantsOverride,
  EscapeReductionConstants,
  PoliceConstants,
  GoldConstants,
  ChaseScoreConstants,
  GoldRing,
  PoliceKind,
} from './constants';
export {
  DEFAULT_CHASE_CONSTANTS,
  CHASE_CONSTANTS_VERSION,
  ChaseConstantsOverrideSchema,
  mergeChaseConstants,
  parseChaseConstants,
} from './constants';

export type { ChaseGraph, ChaseGraphNode, ChaseWorld, CompiledChaseGraph } from './graph';
export {
  compileGraph,
  compareId,
  nextGreedyStep,
  bfsPath,
  hopDistanceMap,
} from './graph';

export type { CandidateContext } from './candidates';
export { generateCandidates, candidatesAreValid } from './candidates';

export type {
  MoveLogEntry,
  ChaseInput,
  ChaseState,
  ChaseEvent,
  StarChangeReason,
  PoliceUnit,
  Gold,
  CarriedGold,
  RngSnapshot,
  ChaseVerifyResult,
} from './simulate';
export { simulateChase, advanceChase, verifyMoveLog } from './simulate';
