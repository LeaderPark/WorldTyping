// spec: docs/03 §4.3(MultiplayerState 전문), §6.4(latencyMs EWMA)·§6.5(opponents Map 참조 동일성)·
//       §6.6(raceResult = 서버 권위 유일 진실), docs/00 §11-D7(메시지 스키마는 shared/protocol이
//       유일 원천), WT-M2-05, WT-M4-04(로비/대기실/레이스 UI 배선 — 채팅·리매치·봇 제안·에러 캐시
//       필드 추가)
//
// RoomPlayer/OpponentProgress/ServerRaceResult는 자체 재정의하지 않고 shared/protocol/messages의
// 타입을 그대로 재사용/파생한다(판정·프로토콜 이중 원천 금지 원칙과 동일한 취지).

import { create } from 'zustand';
import type {
  PlayerPublic,
  S2C_BotOffer,
  S2C_ProgressTick,
  S2C_RaceFinished,
  S2C_RaceSync,
  S2C_RematchState,
  S2C_Results,
  S2C_RoomClosed,
  S2C_Start,
} from '@wt/shared';

export type RoomPlayer = PlayerPublic;
export type ServerRaceResult = S2C_Results;

/** progress-tick 엔트리 + 클라 전용 연출 플래그(missFlash, §6.5 심리전 흔들림 연출). */
export type OpponentProgress = S2C_ProgressTick['players'][number] & { missFlash?: boolean };

/** RaceView가 로컬 엔진을 구성할 원천(WT-M4-04). 'start'(최초) 또는 'race-sync'(재접속) 중
 *  가장 최근 수신분을 그대로 캐시해, attachRace가 새로 붙은 RaceClient에 재생(replay)할 수 있게
 *  한다 — attachRace는 엔진이 만들어진 *뒤*에야 호출 가능해 최초 'start' 수신 시점엔 아직
 *  RaceClient가 없다(닭-달걀 문제, useMultiplayer.ts attachRace 주석 참조). */
export type RaceReplayMessage = S2C_Start | S2C_RaceSync;

/** RaceReplayMessage에서 실제 S2C_Start(countries/startAt/hardCapAt 등)를 뽑아낸다. */
export function extractRaceStart(m: RaceReplayMessage): S2C_Start {
  return m.type === 'start' ? m : m.start;
}

export interface ChatEntry {
  playerId: string;
  text: string;
  at: number;
}

/** 채팅 로그 상한(무한 성장 방지) — 화면은 최근 N개만 스크롤 표시. */
const CHAT_LOG_MAX = 50;

export interface RoomState {
  code: string;
  hostId: string;
  lang: 'ko' | 'en';
  players: RoomPlayer[];
  phase: 'waiting' | 'countdown' | 'racing' | 'result';
  /** S2C_RoomState.config에서 그대로 옮겨온다(WT-M4-04) — WaitingRoom 슬롯 수·공개 배지 표시용.
   *  connectWithGrant 직후(room-state 수신 전) 임시값은 null. */
  maxPlayers: number | null;
  isPublic: boolean;
  /** 퀵매치 자동 시작 타이머 마감(서버 epoch ms). null이면 타이머 없음. */
  autoStartAt: number | null;
}

export interface ServerAck {
  index: number;
  serverTime: number;
}

export interface MultiplayerState {
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';
  latencyMs: number;
  room: RoomState | null;
  /** hello→welcome 응답의 playerId(WT-M4-04) — WaitingRoom/RaceView가 "이건 나"를 판정하는 원천. */
  myPlayerId: string | null;
  opponents: Map<string, OpponentProgress>;
  myServerAck: ServerAck | null;
  raceResult: ServerRaceResult | null;
  /** RaceView 엔진 구성 원천(위 RaceReplayMessage 주석 참조). */
  raceReplay: RaceReplayMessage | null;
  chatLog: ChatEntry[];
  rematchState: S2C_RematchState | null;
  botOffer: S2C_BotOffer | null;
  lastError: { code: string; message: string } | null;
  roomClosedReason: S2C_RoomClosed['reason'] | null;
  raceFinishedReason: S2C_RaceFinished['reason'] | null;

  setConnection(c: MultiplayerState['connection']): void;
  setLatency(ms: number): void;
  setRoom(room: RoomState | null): void;
  setMyPlayerId(id: string | null): void;
  /** 변경된 엔트리만 새 객체로 교체하고 나머지 Map 엔트리는 참조 동일성을 유지한다(§6.5) —
   *  개별 트랙 컴포넌트가 자기 플레이어만 구독해도 불필요한 리렌더가 없도록 하기 위함. */
  upsertOpponent(id: string, patch: Partial<OpponentProgress>): void;
  clearOpponents(): void;
  setServerAck(ack: ServerAck | null): void;
  setRaceResult(result: ServerRaceResult | null): void;
  setRaceReplay(m: RaceReplayMessage | null): void;
  pushChat(entry: ChatEntry): void;
  setRematchState(s: S2C_RematchState | null): void;
  setBotOffer(o: S2C_BotOffer | null): void;
  setLastError(e: { code: string; message: string } | null): void;
  setRoomClosedReason(r: S2C_RoomClosed['reason'] | null): void;
  setRaceFinishedReason(r: S2C_RaceFinished['reason'] | null): void;
  reset(): void;
}

const INITIAL_OPPONENT: Omit<OpponentProgress, 'id'> = {
  idx: 0,
  ksPct: 0,
  combo: 0,
  state: 'racing',
  rank: null,
};

export const useMultiplayerStore = create<MultiplayerState>()((set, get) => ({
  connection: 'idle',
  latencyMs: 0,
  room: null,
  myPlayerId: null,
  opponents: new Map(),
  myServerAck: null,
  raceResult: null,
  raceReplay: null,
  chatLog: [],
  rematchState: null,
  botOffer: null,
  lastError: null,
  roomClosedReason: null,
  raceFinishedReason: null,

  setConnection: (c) => set({ connection: c }),
  setLatency: (ms) => set({ latencyMs: ms }),
  setRoom: (room) => set({ room }),
  setMyPlayerId: (id) => set({ myPlayerId: id }),
  upsertOpponent: (id, patch) => {
    const prevMap = get().opponents;
    const prevEntry = prevMap.get(id);
    const nextMap = new Map(prevMap);
    nextMap.set(id, { id, ...INITIAL_OPPONENT, ...prevEntry, ...patch });
    set({ opponents: nextMap });
  },
  clearOpponents: () => set({ opponents: new Map() }),
  setServerAck: (ack) => set({ myServerAck: ack }),
  setRaceResult: (result) => set({ raceResult: result }),
  setRaceReplay: (m) => set({ raceReplay: m }),
  pushChat: (entry) =>
    set((s) => ({ chatLog: [...s.chatLog, entry].slice(-CHAT_LOG_MAX) })),
  setRematchState: (s) => set({ rematchState: s }),
  setBotOffer: (o) => set({ botOffer: o }),
  setLastError: (e) => set({ lastError: e }),
  setRoomClosedReason: (r) => set({ roomClosedReason: r }),
  setRaceFinishedReason: (r) => set({ raceFinishedReason: r }),
  reset: () =>
    set({
      connection: 'idle',
      latencyMs: 0,
      room: null,
      myPlayerId: null,
      opponents: new Map(),
      myServerAck: null,
      raceResult: null,
      raceReplay: null,
      chatLog: [],
      rematchState: null,
      botOffer: null,
      lastError: null,
      roomClosedReason: null,
      raceFinishedReason: null,
    }),
}));
