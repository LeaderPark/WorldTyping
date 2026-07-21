import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardKey } from './leaderboard';
import { useLeaderboardStore } from './leaderboard';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('leaderboard store', () => {
  beforeEach(() => {
    useLeaderboardStore.setState({ boards: new Map() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const key: BoardKey = 'alltime:worldtour:ko:desktop';

  it('fetch() populates the board on success', async () => {
    const entries = [
      { rank: 1, playerId: 'p1', nickname: 'A', score: 100, pi: 300, cpm: 400, accuracy: 0.98, elapsedMs: 1000, createdAt: '2026-01-01' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries, nextCursor: null, snapshotAt: 'now' }));
    vi.stubGlobal('fetch', fetchMock);

    await useLeaderboardStore.getState().fetch(key);

    const board = useLeaderboardStore.getState().boards.get(key);
    expect(board?.rows).toEqual(entries);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetch() skips refetching while the cached entry is still fresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [], nextCursor: null, snapshotAt: 'now' }));
    vi.stubGlobal('fetch', fetchMock);

    await useLeaderboardStore.getState().fetch(key);
    await useLeaderboardStore.getState().fetch(key);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetch() swallows network/API errors and keeps previous state', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(useLeaderboardStore.getState().fetch(key)).resolves.toBeUndefined();
    expect(useLeaderboardStore.getState().boards.has(key)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
