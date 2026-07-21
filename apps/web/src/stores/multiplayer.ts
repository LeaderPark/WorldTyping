// spec: docs/03 §4.3(MultiplayerState 전문), §6.4(latencyMs EWMA)·§6.5(opponents Map 참조 동일성)·
//       §6.6(raceResult = 서버 권위 유일 진실), docs/00 §11-D7(메시지 스키마는 shared/protocol이
//       유일 원천), WT-M2-05
//
// RoomPlayer/OpponentProgress/ServerRaceResult는 자체 재정의하지 않고 shared/protocol/messages의
// 타입을 그대로 재사용/파생한다(판정·프로토콜 이중 원천 금지 원칙과 동일한 취지).

import { create } from 'zustand';
import type { PlayerPublic, S2C_ProgressTick, S2C_Results } from '@wt/shared';

export type RoomPlayer = PlayerPublic;
export type ServerRaceResult = S2C_Results;

/** progress-tick 엔트리 + 클라 전용 연출 플래그(missFlash, §6.5 심리전 흔들림 연출). */
export type OpponentProgress = S2C_ProgressTick['players'][number] & { missFlash?: boolean };

export interface RoomState {
  code: string;
  hostId: string;
  lang: 'ko' | 'en';
  players: RoomPlayer[];
  phase: 'waiting' | 'countdown' | 'racing' | 'result';
}

export interface ServerAck {
  index: number;
  serverTime: number;
}

export interface MultiplayerState {
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';
  latencyMs: number;
  room: RoomState | null;
  opponents: Map<string, OpponentProgress>;
  myServerAck: ServerAck | null;
  raceResult: ServerRaceResult | null;

  setConnection(c: MultiplayerState['connection']): void;
  setLatency(ms: number): void;
  setRoom(room: RoomState | null): void;
  /** 변경된 엔트리만 새 객체로 교체하고 나머지 Map 엔트리는 참조 동일성을 유지한다(§6.5) —
   *  개별 트랙 컴포넌트가 자기 플레이어만 구독해도 불필요한 리렌더가 없도록 하기 위함. */
  upsertOpponent(id: string, patch: Partial<OpponentProgress>): void;
  clearOpponents(): void;
  setServerAck(ack: ServerAck | null): void;
  setRaceResult(result: ServerRaceResult | null): void;
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
  opponents: new Map(),
  myServerAck: null,
  raceResult: null,

  setConnection: (c) => set({ connection: c }),
  setLatency: (ms) => set({ latencyMs: ms }),
  setRoom: (room) => set({ room }),
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
  reset: () =>
    set({
      connection: 'idle',
      latencyMs: 0,
      room: null,
      opponents: new Map(),
      myServerAck: null,
      raceResult: null,
    }),
}));
