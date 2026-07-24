// spec: docs/03 §8.4(pendingSubmission 큐), docs/07 WT-M3-06
//
// idb-keyval은 jsdom에 IndexedDB가 없어 인메모리 Map으로 목킹한다(로직 검증이 목적 — 실제
// IndexedDB 연동은 idb-keyval 라이브러리 자신의 책임 범위).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn((k: string) => Promise.resolve(mem.get(k))),
  set: vi.fn((k: string, v: unknown) => {
    mem.set(k, v);
    return Promise.resolve();
  }),
  del: vi.fn((k: string) => {
    mem.delete(k);
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve([...mem.keys()])),
}));

const startRunMock = vi.fn();
const submitRunMock = vi.fn();
// [WT-AUTH-04] flush의 게스트→계정 브리지(§11-D68-④)가 참조하는 현재 세션 상태 자리표시자.
// 기본은 게스트(getAuthToken null)로 두고, 브리지 테스트에서만 계정으로 전환한다.
const getAuthTokenMock = vi.fn<() => string | null>(() => null);
const getSessionTokenMock = vi.fn<() => string | null>(() => 'wt1.guest-session-token');
vi.mock('./api-client', () => ({
  startRun: (...args: unknown[]) => startRunMock(...args),
  submitRun: (...args: unknown[]) => submitRunMock(...args),
  getAuthToken: () => getAuthTokenMock(),
  getSessionToken: () => getSessionTokenMock(),
}));

import {
  enqueuePending,
  flushPendingQueue,
  listPending,
  registerPendingQueueAutoFlush,
  removePending,
  __resetPendingQueueAutoFlushForTests,
  type PendingEntry,
} from './pending-queue';

function mkEntry(over: Partial<Omit<PendingEntry, 'id' | 'queuedAt'>> = {}): Omit<PendingEntry, 'id' | 'queuedAt'> {
  return {
    mode: 'continent',
    continent: 'south-america',
    lang: 'ko',
    platform: 'desktop',
    result: {
      elapsedMs: 1000,
      totalKeystrokes: 10,
      correctKeystrokes: 10,
      maxCombo: 3,
      countriesCleared: 3,
      countriesSkipped: 0,
      livesLost: 0,
      finished: true,
      perCountry: [],
    },
    clientScore: 100,
    inputDigest: { n: 1, mean: 100, stdev: 0, p10: 100, p50: 100, p90: 100, burstMax: 1 },
    ...over,
  };
}

describe('pending-queue', () => {
  beforeEach(() => {
    mem.clear();
    startRunMock.mockReset();
    submitRunMock.mockReset();
    getAuthTokenMock.mockReset().mockReturnValue(null);
    getSessionTokenMock.mockReset().mockReturnValue('wt1.guest-session-token');
    __resetPendingQueueAutoFlushForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enqueue → listPending에 노출, remove 후 사라짐', async () => {
    await enqueuePending(mkEntry());
    const pending = await listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.mode).toBe('continent');

    await removePending(pending[0]!.id);
    expect(await listPending()).toHaveLength(0);
  });

  it('listPending은 queuedAt 오름차순(FIFO)으로 정렬한다', async () => {
    await enqueuePending(mkEntry());
    await new Promise((r) => setTimeout(r, 2));
    await enqueuePending(mkEntry({ mode: 'worldtour', continent: undefined }));
    const pending = await listPending();
    expect(pending[0]!.queuedAt).toBeLessThanOrEqual(pending[1]!.queuedAt);
  });

  it('offline(navigator.onLine=false)이면 flush를 건너뛴다', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await enqueuePending(mkEntry());

    const res = await flushPendingQueue();
    expect(res).toEqual({ flushed: 0, remaining: 1 });
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('runToken 없음(오프라인 출발) → flush 시 start+submit을 새로 태운다', async () => {
    await enqueuePending(mkEntry());
    startRunMock.mockResolvedValue({ runToken: 'fresh-token', runId: 'r1', serverStartTs: 1, countryIds: [], seed: 's' });
    submitRunMock.mockResolvedValue({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true });

    const res = await flushPendingQueue();
    expect(res).toEqual({ flushed: 1, remaining: 0 });
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(submitRunMock).toHaveBeenCalledWith(expect.objectContaining({ runToken: 'fresh-token' }));
  });

  it('runToken이 TTL 내에서 신선하면 재시작 없이 그 토큰으로 submit한다', async () => {
    await enqueuePending(mkEntry({ runToken: 'still-good', runTokenIssuedAt: Date.now() }));
    submitRunMock.mockResolvedValue({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true });

    const res = await flushPendingQueue();
    expect(res).toEqual({ flushed: 1, remaining: 0 });
    expect(startRunMock).not.toHaveBeenCalled();
    expect(submitRunMock).toHaveBeenCalledWith(expect.objectContaining({ runToken: 'still-good' }));
  });

  it('runToken이 만료(TTL 경과)됐으면 재시작 후 새 토큰으로 submit한다', async () => {
    const longAgo = Date.now() - 31 * 60 * 1000; // RUN_TOKEN_TTL_MS(30분) 초과
    await enqueuePending(mkEntry({ runToken: 'stale', runTokenIssuedAt: longAgo }));
    startRunMock.mockResolvedValue({ runToken: 'renewed', runId: 'r2', serverStartTs: 1, countryIds: [], seed: 's' });
    submitRunMock.mockResolvedValue({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true });

    await flushPendingQueue();
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(submitRunMock).toHaveBeenCalledWith(expect.objectContaining({ runToken: 'renewed' }));
  });

  // ── 게스트→계정 브리지(WT-AUTH-04, §11-D68-④) ──────────────────────────────
  describe('게스트→계정 브리지', () => {
    it('계정 세션 + 기존 runToken 재사용(tokenFresh) → 현재 게스트 세션 토큰을 guestToken으로 함께 보낸다', async () => {
      getAuthTokenMock.mockReturnValue('wt1.acct-token'); // flush 시점에 계정으로 로그인된 상태.
      await enqueuePending(mkEntry({ runToken: 'still-good', runTokenIssuedAt: Date.now() }));
      submitRunMock.mockResolvedValue({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true });

      const res = await flushPendingQueue();
      expect(res).toEqual({ flushed: 1, remaining: 0 });
      expect(startRunMock).not.toHaveBeenCalled();
      expect(submitRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ runToken: 'still-good', guestToken: 'wt1.guest-session-token' }),
      );
    });

    it('게스트 세션(비로그인)이면 토큰을 재사용해도 guestToken을 싣지 않는다', async () => {
      getAuthTokenMock.mockReturnValue(null); // 여전히 게스트.
      await enqueuePending(mkEntry({ runToken: 'still-good', runTokenIssuedAt: Date.now() }));
      submitRunMock.mockResolvedValue({ verdict: 'practice', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: null, total: null, isPersonalBest: null });

      await flushPendingQueue();
      expect(submitRunMock).toHaveBeenCalledWith(expect.objectContaining({ runToken: 'still-good', guestToken: undefined }));
    });

    it('계정 세션이어도 토큰을 새로 발급받는 경우(!tokenFresh)엔 guestToken을 싣지 않는다(신규 토큰이 이미 계정 pid로 발급됨)', async () => {
      getAuthTokenMock.mockReturnValue('wt1.acct-token');
      const longAgo = Date.now() - 31 * 60 * 1000; // TTL 경과 → 재시작 분기.
      await enqueuePending(mkEntry({ runToken: 'stale', runTokenIssuedAt: longAgo }));
      startRunMock.mockResolvedValue({ runToken: 'renewed', runId: 'r3', serverStartTs: 1, countryIds: [], seed: 's' });
      submitRunMock.mockResolvedValue({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true });

      await flushPendingQueue();
      expect(submitRunMock).toHaveBeenCalledWith(expect.objectContaining({ runToken: 'renewed', guestToken: undefined }));
    });
  });

  it('서버가 응답(예: rejected)하면 큐에서 제거한다 — 영구 재시도 대상 아님', async () => {
    await enqueuePending(mkEntry({ runToken: 'tok', runTokenIssuedAt: Date.now() }));
    submitRunMock.mockResolvedValue({ verdict: 'rejected', score: 0, pi: 0, cpm: 0, accMilli: 0, grade: 'D', completed: false, rank: null, total: null, isPersonalBest: null });

    const res = await flushPendingQueue();
    expect(res).toEqual({ flushed: 1, remaining: 0 });
  });

  it('네트워크 실패 항목에서 중단하고 뒤 항목은 큐에 남긴다(순서 보존)', async () => {
    await enqueuePending(mkEntry({ runToken: 'tok1', runTokenIssuedAt: Date.now() }));
    await new Promise((r) => setTimeout(r, 2));
    await enqueuePending(mkEntry({ runToken: 'tok2', runTokenIssuedAt: Date.now() }));
    submitRunMock.mockRejectedValue(new Error('network down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await flushPendingQueue();
    expect(res).toEqual({ flushed: 0, remaining: 2 });
    expect(submitRunMock).toHaveBeenCalledTimes(1); // 두 번째는 시도조차 안 함
    warnSpy.mockRestore();
  });

  it('registerPendingQueueAutoFlush는 online 리스너를 1회만 등록한다(멱등)', () => {
    const addSpy = vi.fn();
    vi.stubGlobal('window', { addEventListener: addSpy });

    registerPendingQueueAutoFlush();
    registerPendingQueueAutoFlush();

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
  });
});
