import { beforeEach, describe, expect, it } from 'vitest';
import { useMultiplayerStore } from './multiplayer';

describe('multiplayer store', () => {
  beforeEach(() => {
    useMultiplayerStore.getState().reset();
  });

  it('starts idle with no room/opponents', () => {
    const s = useMultiplayerStore.getState();
    expect(s.connection).toBe('idle');
    expect(s.room).toBeNull();
    expect(s.opponents.size).toBe(0);
  });

  it('upsertOpponent creates a new Map but preserves untouched entry references (§6.5)', () => {
    const store = useMultiplayerStore;
    store.getState().upsertOpponent('p1', { idx: 2, ksPct: 40 });
    store.getState().upsertOpponent('p2', { idx: 1, ksPct: 10 });

    const mapBefore = store.getState().opponents;
    const p1Before = mapBefore.get('p1');
    const p2Before = mapBefore.get('p2');

    store.getState().upsertOpponent('p1', { ksPct: 55 });

    const mapAfter = store.getState().opponents;
    expect(mapAfter).not.toBe(mapBefore); // Map 자체는 새 참조
    expect(mapAfter.get('p2')).toBe(p2Before); // 변경 없는 엔트리는 참조 동일성 유지
    expect(mapAfter.get('p1')).not.toBe(p1Before); // 변경된 엔트리만 새 객체
    expect(mapAfter.get('p1')).toMatchObject({ id: 'p1', idx: 2, ksPct: 55 });
  });

  it('clearOpponents empties the map', () => {
    useMultiplayerStore.getState().upsertOpponent('p1', {});
    useMultiplayerStore.getState().clearOpponents();
    expect(useMultiplayerStore.getState().opponents.size).toBe(0);
  });

  it('setRoom/setConnection/setLatency/setServerAck/setRaceResult set the expected fields', () => {
    const store = useMultiplayerStore;
    store.getState().setConnection('open');
    store.getState().setLatency(42);
    store.getState().setRoom({ code: 'ABC123', hostId: 'p1', lang: 'ko', players: [], phase: 'waiting', maxPlayers: 8, isPublic: false, autoStartAt: null });
    store.getState().setServerAck({ index: 3, serverTime: 1000 });

    const s = store.getState();
    expect(s.connection).toBe('open');
    expect(s.latencyMs).toBe(42);
    expect(s.room?.code).toBe('ABC123');
    expect(s.myServerAck).toEqual({ index: 3, serverTime: 1000 });
  });

  it('reset clears everything back to defaults', () => {
    const store = useMultiplayerStore;
    store.getState().setConnection('open');
    store.getState().upsertOpponent('p1', {});
    store.getState().reset();
    const s = store.getState();
    expect(s.connection).toBe('idle');
    expect(s.opponents.size).toBe(0);
    expect(s.room).toBeNull();
  });

  it('setMyPlayerId/setRaceReplay/setRematchState/setBotOffer/setLastError/setRoomClosedReason/setRaceFinishedReason set the expected fields (WT-M4-04)', () => {
    const store = useMultiplayerStore;
    const startMsg = {
      v: 1 as const,
      type: 'start' as const,
      raceId: 'r1',
      seed: 'ab'.repeat(16),
      countries: ['KOR', 'USA'],
      dataVersion: 'abcd1234',
      startAt: 1000,
      hardCapAt: 181000,
      perCountryLimitMs: 10000,
    };
    store.getState().setMyPlayerId('p1');
    store.getState().setRaceReplay(startMsg);
    store.getState().setRematchState({ v: 1, type: 'rematch-state', votes: [{ playerId: 'p1', vote: true }], deadline: 5000 });
    store.getState().setBotOffer({ v: 1, type: 'bot-offer', expiresAt: 6000 });
    store.getState().setLastError({ code: 'ROOM_FULL', message: 'full' });
    store.getState().setRoomClosedReason('idle');
    store.getState().setRaceFinishedReason('hardcap');

    const s = store.getState();
    expect(s.myPlayerId).toBe('p1');
    expect(s.raceReplay).toEqual(startMsg);
    expect(s.rematchState?.deadline).toBe(5000);
    expect(s.botOffer?.expiresAt).toBe(6000);
    expect(s.lastError).toEqual({ code: 'ROOM_FULL', message: 'full' });
    expect(s.roomClosedReason).toBe('idle');
    expect(s.raceFinishedReason).toBe('hardcap');
  });

  it('pushChat appends and caps the log at 50 entries', () => {
    const store = useMultiplayerStore;
    for (let i = 0; i < 55; i++) {
      store.getState().pushChat({ playerId: 'p1', text: `msg${i}`, at: i });
    }
    const log = store.getState().chatLog;
    expect(log.length).toBe(50);
    expect(log[0]?.text).toBe('msg5');
    expect(log[log.length - 1]?.text).toBe('msg54');
  });
});
