// spec: docs/05 §4.2 (TypeScript 타입 전문, packages/protocol/src/messages.ts → @wt/shared 내부로 경로 조정),
//       docs/00 §11-D7(05 §4.2가 유일한 원천 — 03·04의 commit+inputHash 메시지 정의는 폐기),
//       WT-M1-03
//
// 클라·서버가 공유하는 WS 메시지 전문. 자구 그대로 전사(§4.2) — import 경로만 조정했다.
// zod 스키마(파싱용)는 ./schemas.ts, 시딩은 ./seeding.ts, 상수는 ./constants.ts.

import type { CountryId } from '../types/country';

// ───────────────────────── Client → Server ─────────────────────────

/** 연결 직후 1회. 인증 + (재접속 시) 세션 복구 요청 */
export interface C2S_Hello {
  v: 1;
  type: 'hello';
  seq: number;
  auth: { kind: 'guest'; guestId: string } | { kind: 'session'; token: string };
  /** 재접속: welcome에서 받았던 값. 최초 접속이면 생략 */
  resume?: { playerId: string; resumeKey: string };
  /** 클라가 로드한 데이터 버전(manifest 해시 앞 8자) — 불일치 시 서버가 error DATA_VERSION */
  dataVersion: string;
}

/** 대기실 입장 (hello→welcome 후) */
export interface C2S_Join {
  v: 1;
  type: 'join';
  seq: number;
  nickname: string; // 1~16자, 서버에서 트림·금칙어 필터
  passportCover: string;
  joinTicket?: string; // 퀵매치 배정 티켓 (비공개 방은 불필요)
}

export interface C2S_Ready {
  v: 1;
  type: 'ready';
  seq: number;
  ready: boolean;
}
export interface C2S_Start {
  v: 1;
  type: 'start';
  seq: number;
} // 호스트 전용
export interface C2S_Chat {
  v: 1;
  type: 'chat';
  seq: number;
  text: string;
} // ≤120자, WAITING/FINISHED에서만
export interface C2S_BotAccept {
  v: 1;
  type: 'bot-accept';
  seq: number;
  accept: boolean;
}

/** 진행 상황 신고. 클라 스로틀 최대 10Hz(100ms) + 내용 변화 시에만 전송 */
export interface C2S_Progress {
  v: 1;
  type: 'progress';
  seq: number;
  idx: number; // 현재 타이핑 중인 국가 인덱스 (0-base)
  ks: number; // 현재 국가에서 입력한 유효 자모/문자 수 (프리픽스 길이)
  err: number; // 이번 레이스 누적 오타 keystroke
}

/** 국가 완료 주장 — 서버 검증 대상 */
export interface C2S_Complete {
  v: 1;
  type: 'complete';
  seq: number;
  idx: number; // 완료했다고 주장하는 인덱스
  input: string; // 실제 입력한 문자열(정규화 전 원문). 서버가 matchInput 재실행
  ct: number; // clientTime: 레이스 상대시간 ms (클라 performance 기준, §6 보정 참고값)
  errThis: number; // 이 국가에서 발생한 오타 수
}

export interface C2S_TimeSync {
  v: 1;
  type: 'timesync';
  seq: number;
  t0: number;
} // t0 = 클라 performance.now()
export interface C2S_Rematch {
  v: 1;
  type: 'rematch';
  seq: number;
  vote: boolean;
}
export interface C2S_Leave {
  v: 1;
  type: 'leave';
  seq: number;
}

export type ClientMessage =
  | C2S_Hello
  | C2S_Join
  | C2S_Ready
  | C2S_Start
  | C2S_Chat
  | C2S_BotAccept
  | C2S_Progress
  | C2S_Complete
  | C2S_TimeSync
  | C2S_Rematch
  | C2S_Leave;

// ───────────────────────── Server → Client ─────────────────────────

export interface PlayerPublic {
  playerId: string;
  nickname: string;
  passportCover: string;
  bestPi: number | null;
  isHost: boolean;
  isBot: boolean;
  ready: boolean;
  connState: 'connected' | 'grace' | 'left' | 'spectator';
}

/** hello 성공 응답 (해당 연결에만) */
export interface S2C_Welcome {
  v: 1;
  type: 'welcome';
  ack: number;
  playerId: string;
  resumeKey: string; // 최초 접속 시 신규 발급, 재접속 시 동일값 재확인
  serverTime: number; // epoch ms — 클라 오프셋 초기 추정
  resumed: boolean; // true면 곧바로 race-sync가 따라온다
}

/** 방 전체 스냅샷. 멤버십/설정/phase 변화마다 전원 브로드캐스트 */
export interface S2C_RoomState {
  v: 1;
  type: 'room-state';
  phase: 'WAITING' | 'COUNTDOWN' | 'RACING' | 'FINISHED';
  roomCode: string;
  config: { lang: 'ko' | 'en'; mode: string; poolParam: string | null; maxPlayers: number; isPublic: boolean };
  players: PlayerPublic[];
  hostId: string;
  /** quickMatch 자동 시작 타이머가 돌고 있으면 그 마감 서버시각 */
  autoStartAt: number | null;
}

export interface S2C_Countdown {
  v: 1;
  type: 'countdown';
  startAt: number; // 서버 epoch ms. 클라는 (startAt − offset)에 로컬 출발
  raceId: string; // ULID — 이 레이스의 영속 키
}

/** 세트 공개. countdown과 함께(또는 직후) 전송 */
export interface S2C_Start {
  v: 1;
  type: 'start';
  raceId: string;
  seed: string; // 32-hex
  countries: CountryId[]; // 권위 시퀀스 (클라는 이 배열을 그대로 사용)
  dataVersion: string;
  startAt: number; // countdown과 동일값 재통지
  hardCapAt: number; // startAt + 180_000
  perCountryLimitMs: number; // 10_000 고정 (GDD §7.1)
}

/** 코얼레싱 진행 브로드캐스트 — RACING 중 250ms 간격, 변화가 있을 때만 */
export interface S2C_ProgressTick {
  v: 1;
  type: 'progress-tick';
  at: number; // 서버 epoch ms
  players: {
    id: string;
    idx: number; // 서버 권위 nextIndex
    ksPct: number; // 현재 국가 내 진행률 0~100 (클라 신고 기반, 표시용)
    combo: number;
    state: 'racing' | 'finished' | 'grace' | 'left';
    rank: number | null; // 완주자만
  }[];
}

/** complete 승인 (해당 연결에만) */
export interface S2C_CountryAccepted {
  v: 1;
  type: 'country-accepted';
  ack: number;
  idx: number;
  nextIdx: number; // == idx + 1, 완주 시 == countries.length
  serverElapsedMs: number; // 권위 누적 시간 (startAt 기준)
  combo: number;
  finished: boolean;
  rank: number | null; // finished일 때 확정 순위
}

/** complete 거부 (해당 연결에만) — 클라는 authoritative로 롤백 */
export interface S2C_CountryRejected {
  v: 1;
  type: 'country-rejected';
  ack: number;
  idx: number;
  reason: 'WRONG_INDEX' | 'NOT_EXACT' | 'TOO_FAST' | 'NOT_RACING' | 'ALREADY_FINISHED';
  authoritative: { nextIdx: number; serverElapsedMs: number; combo: number };
}

export interface S2C_PlayerFinished {
  v: 1;
  type: 'player-finished'; // 전원 브로드캐스트 (결승 연출용)
  playerId: string;
  rank: number;
  elapsedMs: number;
  photoFinish: boolean; // 직전 순위와 1000ms 이내
}

export interface S2C_RaceFinished {
  v: 1;
  type: 'race-finished';
  reason: 'all-finished' | 'hardcap' | 'all-left';
}

export interface ResultRow {
  playerId: string;
  nickname: string;
  isBot: boolean;
  rank: number;
  finished: boolean;
  countriesCleared: number;
  elapsedMs: number | null;
  cpm: number;
  acc: number;
  pi: number;
  disconnected: boolean;
}
export interface S2C_Results {
  v: 1;
  type: 'results';
  raceId: string;
  rows: ResultRow[]; // rank 오름차순
  rematchDeadline: number; // 서버 epoch ms
}

export interface S2C_RematchState {
  v: 1;
  type: 'rematch-state';
  votes: { playerId: string; vote: boolean | null }[];
  deadline: number;
}

/** 재접속 시 전체 재동기 (해당 연결에만, welcome 직후) */
export interface S2C_RaceSync {
  v: 1;
  type: 'race-sync';
  phase: 'COUNTDOWN' | 'RACING' | 'FINISHED';
  start: S2C_Start; // seed·countries 포함 전체 재전송
  me: { nextIdx: number; serverElapsedMs: number; combo: number; errorKeystrokes: number };
  tick: S2C_ProgressTick; // 최신 상대 진행 스냅샷
}

export interface S2C_TimeSync {
  v: 1;
  type: 'timesync';
  ack: number;
  t0: number;
  t1: number;
} // t1 = 서버 수신 epoch ms
export interface S2C_BotOffer {
  v: 1;
  type: 'bot-offer';
  expiresAt: number;
}
export interface S2C_Chat {
  v: 1;
  type: 'chat';
  playerId: string;
  text: string;
  at: number;
}
export interface S2C_RoomClosed {
  v: 1;
  type: 'room-closed';
  reason: 'idle' | 'empty' | 'rematch-declined' | 'error';
}

export interface S2C_Error {
  v: 1;
  type: 'error';
  ack?: number;
  code:
    | 'BAD_MESSAGE'
    | 'ROOM_FULL'
    | 'ROOM_NOT_FOUND'
    | 'WRONG_PHASE'
    | 'NOT_HOST'
    | 'DATA_VERSION'
    | 'RATE_LIMIT'
    | 'AUTH_FAILED'
    | 'NICKNAME_INVALID';
  message: string; // 사람용 (i18n 키가 아닌 영어 원문, 클라가 code로 i18n)
}

export type ServerMessage =
  | S2C_Welcome
  | S2C_RoomState
  | S2C_Countdown
  | S2C_Start
  | S2C_ProgressTick
  | S2C_CountryAccepted
  | S2C_CountryRejected
  | S2C_PlayerFinished
  | S2C_RaceFinished
  | S2C_Results
  | S2C_RematchState
  | S2C_RaceSync
  | S2C_TimeSync
  | S2C_BotOffer
  | S2C_Chat
  | S2C_RoomClosed
  | S2C_Error;
