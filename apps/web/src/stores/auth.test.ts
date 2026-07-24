// @vitest-environment jsdom
//
// spec: docs/03 §4.3(6번째 스토어), docs/00 §11-D68 + WT-AUTH-03.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthPersistError,
  selectIsLoggedIn,
  useAuthStore,
  verifyAccountSession,
  __resetAccountVerifyForTests,
  type AccountSession,
} from './auth';
import { __resetSessionForTests, apiClient, getAuthToken } from '../net/api-client';

const FUTURE = Date.now() + 60_000;

function session(over: Partial<AccountSession> = {}): AccountSession {
  return {
    token: 'wt1.acct',
    playerId: 'p-acct',
    nickname: 'Traveler',
    expiresAt: FUTURE,
    geo: 'KR',
    profile: { name: 'Traveler', picture: 'https://lh3.googleusercontent.com/a/x.png', email: 't@example.com' },
    ...over,
  };
}

describe('auth store (WT-AUTH-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('login sets state, writes the raw wt:authtoken, and reports logged-in', () => {
    useAuthStore.getState().login(session());
    const s = useAuthStore.getState();
    expect(s.playerId).toBe('p-acct');
    expect(s.nickname).toBe('Traveler');
    expect(s.profile?.picture).toBe('https://lh3.googleusercontent.com/a/x.png');
    expect(getAuthToken()).toBe('wt1.acct');
    expect(selectIsLoggedIn(s)).toBe(true);
  });

  it('logout clears state and removes the raw token', () => {
    useAuthStore.getState().login(session());
    useAuthStore.getState().logout();
    const s = useAuthStore.getState();
    expect(s.playerId).toBeNull();
    expect(s.profile).toBeNull();
    expect(getAuthToken()).toBeNull();
    expect(selectIsLoggedIn(s)).toBe(false);
  });

  it('selectIsLoggedIn is false once expiresAt has passed', () => {
    useAuthStore.getState().login(session({ expiresAt: Date.now() - 1 }));
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  it('openLogin/closeLogin drive the modal reason', () => {
    useAuthStore.getState().openLogin('ranking');
    expect(useAuthStore.getState().loginReason).toBe('ranking');
    useAuthStore.getState().openLogin(); // default general
    expect(useAuthStore.getState().loginReason).toBe('general');
    useAuthStore.getState().closeLogin();
    expect(useAuthStore.getState().loginReason).toBeNull();
  });

  it('persists profile/nickname/expiresAt under wt:auth — never the token or loginReason', () => {
    useAuthStore.getState().login(session());
    useAuthStore.getState().openLogin('multi');
    const raw = JSON.parse(localStorage.getItem('wt:auth') as string) as { state: Record<string, unknown> };
    expect(raw.state.nickname).toBe('Traveler');
    expect(raw.state.expiresAt).toBe(FUTURE);
    expect((raw.state.profile as { picture: string }).picture).toBe('https://lh3.googleusercontent.com/a/x.png');
    expect(raw.state.token).toBeUndefined();
    expect(raw.state.loginReason).toBeUndefined();
  });

  it('a 401 LOGIN_REQUIRED response opens the login modal via the global signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'LOGIN_REQUIRED', message: 'nope' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.getState().closeLogin();

    await expect(apiClient.post('/rooms')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(useAuthStore.getState().loginReason).toBe('general');
  });
});

// ───────────────────────── 인증 상태 split-brain 봉인(§11-D86) ─────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const SESSION_ME_OK = { playerId: 'p-acct', nickname: 'Traveler', status: 'active', geo: 'KR' };

describe('auth split-brain 봉인 (§11-D86)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    __resetAccountVerifyForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionForTests();
    __resetAccountVerifyForTests();
  });

  // F1 — 로그인 판정이 유효 계정 토큰 실존에 종속
  it('프로필이 살아있어도 계정 토큰이 없으면 selectIsLoggedIn=false (버그 Z2)', () => {
    useAuthStore.getState().login(session());
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
    localStorage.removeItem('wt:authtoken'); // 토큰만 소실(탭 간 로그아웃/축출 시뮬레이션)
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  // F4 — setItem 실패 시 로그인 성립 거부
  it('setItem이 throw하면 login이 AuthPersistError를 던지고 프로필/토큰을 세우지 않는다', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => useAuthStore.getState().login(session())).toThrow(AuthPersistError);
    setItemSpy.mockRestore();
    expect(useAuthStore.getState().playerId).toBeNull();
    expect(getAuthToken()).toBeNull();
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  // F4 — read-back 불일치(조용한 무시)도 거부
  it('setItem 후 read-back이 불일치하면 login이 거부된다', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    expect(() => useAuthStore.getState().login(session())).toThrow(AuthPersistError);
    getItemSpy.mockRestore();
    expect(useAuthStore.getState().playerId).toBeNull();
  });

  // F1b — 크로스탭 로그아웃 전파(storage 이벤트)
  it('다른 탭 로그아웃(storage 이벤트) → 이 탭도 로그아웃된다', () => {
    useAuthStore.getState().login(session());
    localStorage.removeItem('wt:authtoken');
    window.dispatchEvent(new StorageEvent('storage', { key: 'wt:authtoken', newValue: null }));
    expect(useAuthStore.getState().playerId).toBeNull();
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  // F1b — 크로스탭 로그인 전파(두 키 기록 + storage 이벤트 → rehydrate)
  it('다른 탭 로그인(두 키 기록 + storage 이벤트) → 이 탭도 로그인된다', async () => {
    expect(useAuthStore.getState().playerId).toBeNull();
    localStorage.setItem('wt:authtoken', 'wt1.acct');
    localStorage.setItem(
      'wt:auth',
      JSON.stringify({
        state: { playerId: 'p-acct', nickname: 'Traveler', profile: { name: 'Traveler', picture: null, email: null }, geo: 'KR', expiresAt: FUTURE },
        version: 0,
      }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'wt:authtoken', newValue: 'wt1.acct' }));
    await useAuthStore.persist.rehydrate(); // reconcile이 건 void rehydrate()가 정착하도록 명시 await(멱등)
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
    expect(useAuthStore.getState().playerId).toBe('p-acct');
  });

  // F1b — 재포커스 회수(이벤트 유실된 축출을 focus에서 회수)
  it('재포커스(focus 이벤트) + 토큰 소실 → 로그아웃 회수', () => {
    useAuthStore.getState().login(session());
    localStorage.removeItem('wt:authtoken');
    window.dispatchEvent(new Event('focus'));
    expect(useAuthStore.getState().playerId).toBeNull();
  });

  // F1 — 부팅 rehydrate 고아 토큰 소거(프로필 없이 토큰만)
  it('부팅 rehydrate: 프로필 없이 계정 토큰만 남으면 토큰을 소거한다', async () => {
    localStorage.setItem('wt:authtoken', 'wt1.orphan'); // 'wt:auth'는 playerId null(beforeEach logout)
    await useAuthStore.persist.rehydrate();
    expect(getAuthToken()).toBeNull();
  });
});

describe('verifyAccountSession (§11-D86 F2a)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    __resetAccountVerifyForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
    __resetAccountVerifyForTests();
  });

  it('200이면 로그인 상태를 유지한다', async () => {
    useAuthStore.getState().login(session());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SESSION_ME_OK));
    vi.stubGlobal('fetch', fetchMock);
    await verifyAccountSession();
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401이면 로그아웃으로 강등한다', async () => {
    useAuthStore.getState().login(session());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'INVALID_TOKEN', message: 'bad' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await verifyAccountSession();
    expect(useAuthStore.getState().playerId).toBeNull();
  });

  it('네트워크 실패/5xx면 강등하지 않는다(가용성 우선)', async () => {
    useAuthStore.getState().login(session());
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await verifyAccountSession();
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
  });

  it('60s 메모: 연속 2회 호출 시 fetch는 1회만 나간다', async () => {
    useAuthStore.getState().login(session());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SESSION_ME_OK));
    vi.stubGlobal('fetch', fetchMock);
    await verifyAccountSession();
    await verifyAccountSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('게스트(계정 토큰 없음)는 fetch 없이 no-op이다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await verifyAccountSession();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('onAccountTokenRejected 배선 (§11-D86 F2b)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('계정 토큰 첨부 요청의 401 INVALID_TOKEN → 즉시 로그아웃 정합화', async () => {
    useAuthStore.getState().login(session()); // 계정 토큰 'wt1.acct' 기록
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'INVALID_TOKEN', message: 'bad' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiClient.get('/config')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(useAuthStore.getState().playerId).toBeNull();
    expect(getAuthToken()).toBeNull();
  });
});
