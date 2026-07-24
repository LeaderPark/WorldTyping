// spec: docs/05 §1.2(phase 열거형과 저장 스키마 — RoomPhase/RoomConfig/PlayerRecord 전문),
//       docs/00 §11-D7(05 프로토콜이 유일 원천) + WT-M4-01
//
// MatchRoom DO의 영속 상태 타입. §1.2 전문(RoomPhase·RoomConfig·PlayerRecord)을 자구 그대로
// 옮기고, 서버 전용 보조 타입(RaceState·PlayerMeta)만 추가했다. 이 파일은 순수 타입/팩토리라
// DOM/네트워크 의존이 없다(DO 본체는 MatchRoom.ts).
//
// 저장 키(§1.2 "storage 키 설계"): config·phase·players(맵)·order·hostId·finishCounter·race·
//   rematchVotes·alarms·dataVersion·timings·playerMeta·pendingPersist. ≤8인 방이라 players는
//   per-key 대신 단일 맵으로 원자 스냅샷(하이드레이션 단순화) — 키 파티셔닝은 §1.2의 예시이고
//   타입/전이 계약이 본질이다.

export type RoomPhase = 'CREATED' | 'WAITING' | 'COUNTDOWN' | 'RACING' | 'FINISHED' | 'CLOSED';

export type RoomLang = 'ko' | 'en';

/** v1 UI는 race-mixed만 노출(§11-D23). continent/tier는 프로토콜 예약. */
export type RoomMode = 'race-mixed' | 'race-continent' | 'race-tier';

export interface RoomConfig {
  roomCode: string; // "KX73QP" (표시할 때만 "KX7-3QP"로 하이픈 삽입)
  lang: RoomLang;
  mode: RoomMode;
  poolParam: string | null; // race-continent → 'asia' 등 / race-tier → '3' / mixed → null
  maxPlayers: number; // 기본 8, 호스트가 2~8 설정
  isPublic: boolean; // 공개 방 목록 노출 여부
  createdAt: number;
  quickMatch: boolean; // Matchmaker가 만든 방인가 (자동 시작 규칙 적용)
  // 로비 카드 표시용 방 제목(§11-D68-⑧). 서버 내부 상태(KV 레지스트리·room-status)로만 노출하고
  // WS room-state 메시지에는 싣지 않는다(D7 프로토콜 불변). 미지정 방은 null.
  title: string | null;
}

export type ConnState = 'connected' | 'grace' | 'left' | 'spectator';

/**
 * 봇(고스트) 재생 근거(§2.3-5). startCountdown이 세트 확정 후 이 근거로 국가별 누적 스플릿을
 * 파생한다(lib/ghost.ts buildGhostCumSplits). recording = 과거 클린 완주자 수집분, builtin = F11 폴백.
 */
export type GhostSource =
  | { kind: 'builtin'; targetPi: number }
  | { kind: 'recording'; cumSplitsMs: number[] };

export interface PlayerRecord {
  playerId: string; // 서버 발급. 세션 간 불변(게스트는 클라 guestId 기반)
  nickname: string;
  passportCover: string; // 코스메틱 id
  bestPi: number | null;
  isHost: boolean;
  isBot: boolean; // GHOST 봇 (§2.4)
  ready: boolean;
  // --- 레이스 중 권위 상태 (서버만 쓴다) ---
  nextIndex: number; // 다음에 완료해야 할 국가 인덱스 (0-base). 완주 시 == set.length
  lastAcceptAt: number; // 직전 country-complete 승인 서버 시각(ms)
  correctKeystrokes: number; // 승인된 국가들의 필요 타수 누계 (서버 계산)
  errorKeystrokes: number; // 클라 신고 오타 누계 (표시용, 순위에 미사용)
  combo: number;
  finishedAt: number | null; // 서버 시각. null = 미완주
  rank: number | null;
  connState: ConnState;
  graceDeadline: number | null; // grace 진입 시 now + 15_000
  resumeKey: string; // 재접속 인증용 hex (welcome으로 1회 전달)
  suspicionFlags: string[]; // §9 안티치트 누적 플래그
  // --- 고스트 수집·재생(§2.3-5, WT-M4-05) ---
  splits: number[]; // 완료(accept+자동스킵)마다 누적 serverElapsedMs push — 클린 완주자 고스트 수집 원천
  botCumSplits: number[] | null; // 봇 재생 스케줄(국가별 누적 ms). 비봇은 null
  botSource: GhostSource | null; // 봇 재생 근거(리매치·세트 변경 시 재파생용). 비봇은 null
}

/**
 * 레이스 인스턴스 상태(storage 'race'). §1.2는 seed·countryIds·startAt·raceId를 든다 —
 * 검증·리플레이에 필요한 hardCapAt·dataVersion·perCountryLimitMs·rematchOf를 함께 보관한다.
 */
export interface RaceState {
  raceId: string;
  seed: string; // 32-hex
  countryIds: string[]; // 권위 시퀀스
  startAt: number; // 서버 epoch ms
  hardCapAt: number; // startAt + HARDCAP_MS
  dataVersion: string;
  perCountryLimitMs: number;
  rematchOf: string | null; // 직전 raceId (리매치 체인)
}

/** 서버 전용 메타(§10.1 D1 컬럼 is_guest·avg_rtt_ms·지표 산정용). 와이어에는 실리지 않는다. */
export interface PlayerMeta {
  isGuest: boolean;
  /** timesync 왕복 최소 RTT(ms). 없으면 null(v1 클라는 서버로 RTT를 신고하지 않음 — §8-5). */
  rttMs: number | null;
  /** 이 레이스에서 10초 초과 자동 스킵된 국가 수(countriesCleared = nextIndex − skipped). */
  skipped: number;
  /** 이탈 확정 서버 시각(activeMs 산정). null = 미이탈. */
  leftAt: number | null;
}

/** 새 플레이어 레코드(대기실 join 시점). 레이스 필드는 전부 초기값. */
export function createPlayerRecord(args: {
  playerId: string;
  nickname: string;
  passportCover: string;
  bestPi: number | null;
  isHost: boolean;
  isBot: boolean;
  resumeKey: string;
}): PlayerRecord {
  return {
    playerId: args.playerId,
    nickname: args.nickname,
    passportCover: args.passportCover,
    bestPi: args.bestPi,
    isHost: args.isHost,
    isBot: args.isBot,
    ready: false,
    nextIndex: 0,
    lastAcceptAt: 0,
    correctKeystrokes: 0,
    errorKeystrokes: 0,
    combo: 0,
    finishedAt: null,
    rank: null,
    connState: 'connected',
    graceDeadline: null,
    resumeKey: args.resumeKey,
    suspicionFlags: [],
    splits: [],
    botCumSplits: null,
    botSource: null,
  };
}

/** 레이스 시작(COUNTDOWN 진입/리매치) 시 플레이어의 레이스 필드를 초기화한다(멤버십은 유지). */
export function resetRaceFields(p: PlayerRecord): void {
  p.nextIndex = 0;
  p.lastAcceptAt = 0;
  p.correctKeystrokes = 0;
  p.errorKeystrokes = 0;
  p.combo = 0;
  p.finishedAt = null;
  p.rank = null;
  p.suspicionFlags = [];
  p.splits = [];
  // botSource/botCumSplits는 여기서 건드리지 않는다 — 봇 스케줄은 startCountdown이 세트 확정 후
  // botSource로 botCumSplits를 재파생한다(세트가 매 레이스 달라 재계산이 필수).
  // ready는 다음 대기실로 넘어갈 때만 의미가 있으므로 여기서 건드리지 않는다.
}
