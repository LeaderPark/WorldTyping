// @vitest-environment jsdom
// 세션 부트스트랩(ensureSession)이 localStorage에 토큰을 저장하므로 jsdom이 필요하다(그 외
// 순수 fetch 목 테스트는 jsdom 여부와 무관하게 동일하게 통과한다).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiClient,
  ApiError,
  buildBoardKey,
  ensureSession,
  fetchDailyMe,
  fetchDailyToday,
  fetchLbMe,
  fetchLbPage,
  getAuthToken,
  getSessionToken,
  modeKeyFor,
  onAccountTokenRejected,
  onLoginRequired,
  setAuthToken,
  startRun,
  submitRun,
  __resetSessionForTests,
} from './api-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('apiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET resolves with parsed JSON on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiClient.get<{ ok: boolean }>('/config');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/config',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
    );
  });

  it('POST sends a JSON body and method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.post('/runs/start', { mode: 'tier' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runs/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'tier' }) }),
    );
  });

  it('throws ApiError with the server error envelope on non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'slow down', retryAfterSec: 5 } },
        { status: 429, statusText: 'Too Many Requests' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/leaderboard')).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
      retryAfterSec: 5,
    });
  });

  it('falls back to UNKNOWN code when the error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    let err: ApiError | undefined;
    try {
      await apiClient.get('/config');
    } catch (e) {
      err = e as ApiError;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(502);
    expect(err?.code).toBe('UNKNOWN');
  });

  it('returns undefined for 204 No Content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiClient.post('/session');
    expect(result).toBeUndefined();
  });
});

describe('board_key / modeKey 조립(docs/06 §1.1)', () => {
  it('modeKeyFor: 대륙/티어/세계일주/데일리', () => {
    expect(modeKeyFor('continent', 'europe')).toBe('continent:europe');
    expect(modeKeyFor('tier', '3')).toBe('tier:3');
    expect(modeKeyFor('worldtour', '')).toBe('worldtour');
    expect(modeKeyFor('daily', '2026-07-21')).toBe('daily:2026-07-21');
    expect(modeKeyFor('race', '')).toBe('multi');
  });

  it('buildBoardKey: 4파트 파이프 조립', () => {
    expect(buildBoardKey('worldtour', 'ko', 'desktop', 'all')).toBe('worldtour|ko|desktop|all');
    expect(buildBoardKey('tier:1', 'en', 'mobile', 'd:2026-07-21')).toBe('tier:1|en|mobile|d:2026-07-21');
  });
});

describe('세션 부트스트랩(ensureSession)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('성공 시 토큰을 저장하고 이후 호출은 in-flight/캐시를 재사용한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ token: 'wt1.tok', playerId: 'p1', nickname: 'GUEST_0001', expiresAt: '2026-08-01T00:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await ensureSession('device-1');
    expect(res?.token).toBe('wt1.tok');
    expect(getSessionToken()).toBe('wt1.tok');

    // 두 번째 호출은 캐시된 프라미스를 반환 — fetch 재호출 없음.
    await ensureSession('device-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('실패(오프라인) 시 null을 반환하고 캐시를 비워 재시도 가능하게 한다', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await ensureSession('device-1');
    expect(res).toBeNull();
    expect(getSessionToken()).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('runs/lb/daily/nickname 타입드 래퍼', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('startRun/submitRun이 올바른 경로·바디로 호출된다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ runToken: 'rt', runId: 'r1', serverStartTs: 1, countryIds: ['CO'], seed: 's' }))
      .mockResolvedValueOnce(
        jsonResponse({ verdict: 'valid', score: 100, pi: 10, cpm: 200, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 2, isPersonalBest: true }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const start = await startRun({ mode: 'continent', lang: 'ko', platform: 'desktop', continent: 'south-america' });
    expect(start.runToken).toBe('rt');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/runs/start', expect.objectContaining({ method: 'POST' }));

    const submit = await submitRun({
      runToken: 'rt',
      result: {
        elapsedMs: 1,
        totalKeystrokes: 1,
        correctKeystrokes: 1,
        maxCombo: 1,
        countriesCleared: 1,
        countriesSkipped: 0,
        livesLost: 0,
        finished: true,
        perCountry: [],
      },
      clientScore: 100,
      inputDigest: { n: 0, mean: 0, stdev: 0, p10: 0, p50: 0, p90: 0, burstMax: 0 },
    });
    expect(submit.verdict).toBe('valid');
    expect(submit.rank).toBe(1);
  });

  it('daily today/me, lb page/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ dailyNo: 1, dateKst: '2026-07-21', seed: 's', countryIds: ['CO'] }))
      .mockResolvedValueOnce(jsonResponse({ dateKst: '2026-07-21', alreadyPlayed: false, streakDaily: 2 }))
      .mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null, total: 0 }))
      .mockResolvedValueOnce(jsonResponse({ rank: null, total: 0, percentile: null, onBoard: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDailyToday()).resolves.toMatchObject({ dailyNo: 1 });
    await expect(fetchDailyMe()).resolves.toMatchObject({ alreadyPlayed: false });
    await expect(fetchLbPage('worldtour|ko|desktop|all')).resolves.toMatchObject({ total: 0 });
    await expect(fetchLbMe('worldtour|ko|desktop|all')).resolves.toMatchObject({ onBoard: false });

    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/lb?board=worldtour%7Cko%7Cdesktop%7Call', expect.anything());
  });

  it('Authorization 헤더는 저장된 토큰이 없으면 첨부되지 않는다', async () => {
    __resetSessionForTests(); // localStorage 토큰 제거
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.get('/daily/today');
    const [, initNoAuth] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((initNoAuth.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

// ───────────────────────── 계정 토큰 + LOGIN_REQUIRED 시그널(WT-AUTH-03) ─────────────────────────
describe('계정 토큰 우선순위 & LOGIN_REQUIRED 시그널', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  function authHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (init.headers as Record<string, string>).Authorization;
  }

  it('계정 토큰(wt:authtoken)이 게스트 세션 토큰보다 우선한다', async () => {
    localStorage.setItem('wt:sessiontoken', 'guest-tok');
    setAuthToken('acct-tok');
    expect(getAuthToken()).toBe('acct-tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.get('/config');
    expect(authHeader(fetchMock)).toBe('Bearer acct-tok');
  });

  it('계정 토큰이 없으면 게스트 세션 토큰으로 폴백한다', async () => {
    __resetSessionForTests();
    localStorage.setItem('wt:sessiontoken', 'guest-tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.get('/config');
    expect(authHeader(fetchMock)).toBe('Bearer guest-tok');
  });

  it('onLoginRequired는 401 LOGIN_REQUIRED에서만 발화하고 해제할 수 있다', async () => {
    const handler = vi.fn();
    const off = onLoginRequired(handler);
    // 매 호출마다 새 Response(바디는 1회만 소비 가능하므로 인스턴스 재사용 금지).
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'LOGIN_REQUIRED', message: 'nope' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.post('/rooms')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    await expect(apiClient.post('/rooms')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(handler).toHaveBeenCalledTimes(1); // 해제 후 미발화
  });

  it('다른 401(INVALID_TOKEN)에서는 LOGIN_REQUIRED 시그널이 발화하지 않는다', async () => {
    const handler = vi.fn();
    const off = onLoginRequired(handler);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'INVALID_TOKEN', message: 'bad' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/config')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});

// ───────────────────────── setAuthToken 원자화 + 계정 토큰 거부 시그널(§11-D86) ─────────────────────────
describe('setAuthToken 원자화(§11-D86 F4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetSessionForTests();
  });

  it('저장 성공 시 true를 반환하고, null 삭제도 true다', () => {
    expect(setAuthToken('acct-tok')).toBe(true);
    expect(getAuthToken()).toBe('acct-tok');
    expect(setAuthToken(null)).toBe(true);
    expect(getAuthToken()).toBeNull();
  });

  it('setItem이 throw하면 false(쿼터/사생활 모드 등 저장 실패를 신호로 승격)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(setAuthToken('acct-tok')).toBe(false);
    spy.mockRestore();
  });

  it('setItem은 성공해도 read-back이 불일치하면 false(조용한 무시)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    expect(setAuthToken('acct-tok')).toBe(false);
    spy.mockRestore();
  });
});

describe('onAccountTokenRejected 시그널(§11-D86 F2b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('계정 토큰을 첨부한 요청의 401 INVALID_TOKEN에서만 발화하고 해제할 수 있다', async () => {
    setAuthToken('acct-tok');
    const handler = vi.fn();
    const off = onAccountTokenRejected(handler);
    // 매 호출마다 새 Response(바디 1회 소비).
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'INVALID_TOKEN', message: 'bad' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/config')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    await expect(apiClient.get('/config')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(handler).toHaveBeenCalledTimes(1); // 해제 후 미발화
  });

  it('계정 토큰이 없고 게스트 토큰만 있을 때의 401 INVALID_TOKEN에서는 발화하지 않는다', async () => {
    __resetSessionForTests();
    localStorage.setItem('wt:sessiontoken', 'guest-tok'); // 계정 토큰 부재 = ensureSession 재부트스트랩 영역
    const handler = vi.fn();
    const off = onAccountTokenRejected(handler);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'INVALID_TOKEN', message: 'bad' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/config')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it('401 LOGIN_REQUIRED에서는 onAccountTokenRejected가 발화하지 않는다(onLoginRequired 전용 시그널)', async () => {
    setAuthToken('acct-tok');
    const acctHandler = vi.fn();
    const off = onAccountTokenRejected(acctHandler);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'LOGIN_REQUIRED', message: 'nope' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.post('/rooms')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(acctHandler).not.toHaveBeenCalled();
    off();
  });
});
