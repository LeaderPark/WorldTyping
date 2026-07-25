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
  __resetAuthHydrationForTests,
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
  // [WT-FIX-CROSSTAB-TOKEN] 이 스윕은 이제 "최초 부팅" 1회로 게이트된다(크로스탭 rehydrate 도중엔
  // 지우면 안 됨 — 아래 별도 describe 참조). 이 테스트가 검증하려는 건 정확히 "최초 부팅" 시나리오이므로
  // 리셋 헬퍼로 명시적으로 재현한다(이 describe의 앞선 테스트들이 이미 rehydrate()를 호출해 플래그를
  // 소비했을 수 있어, 리셋 없이는 이 테스트 하나만으로 "최초 부팅"을 보장할 수 없다).
  it('부팅 rehydrate: 프로필 없이 계정 토큰만 남으면 토큰을 소거한다', async () => {
    __resetAuthHydrationForTests();
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

// ───────────────────────── 크로스탭 rehydrate 고아 스윕 게이트 (WT-FIX-CROSSTAB-TOKEN, §11-D109 예정) ─────────────────────────
// RCA(2026-07-25 라이브 장애): 로그인 탭이 wt:authtoken → wt:auth 순서로 두 원시 키를 기록하는 사이,
// 다른(로그아웃 상태) 탭이 wt:authtoken의 storage 이벤트를 먼저 받아 reconcileAuthWithStorage()가
// persist.rehydrate()를 건다. 그 순간 wt:auth는 아직 구값(playerId null)이라 기존의 무조건적 고아
// 토큰 스윕(onRehydrateStorage의 else-if)이 방금 발급된 토큰을 지웠고, 그 삭제가 storage 이벤트로
// 로그인 탭까지 전파돼 연쇄 로그아웃됐다(3/3 재현). 스윕은 "최초 부팅 하이드레이션 1회"로만 게이트해야
// 한다 — 아래 R1~R4가 수정 전/후 경계를 고정한다.
const STALE_LOGGED_OUT_AUTH_JSON = JSON.stringify({
  state: { playerId: null, nickname: null, profile: null, geo: null, expiresAt: null },
  version: 0,
});

describe('크로스탭 rehydrate 고아 스윕 게이트 (WT-FIX-CROSSTAB-TOKEN)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionForTests();
  });

  it('R1(재현): 로그인 후 관전 탭의 rehydrate 시퀀스를 재연해도 토큰이 살아남아야 한다', async () => {
    // 앱이 이미 정상 부팅된(=최초 하이드레이션이 소비된) 상태를 보장 — 이 테스트는 "부팅"이 아니라
    // "크로스탭 도중"의 재현이어야 한다.
    await useAuthStore.persist.rehydrate();
    useAuthStore.getState().login(session());
    expect(getAuthToken()).toBe('wt1.acct');

    // 로그인 탭의 두 번째 기록(wt:auth)이 아직 도착하지 않은 순간을 재연: 관전 탭이 wt:authtoken
    // storage 이벤트를 받고 rehydrate()를 걸었을 때 wt:auth가 여전히 구값(로그아웃)인 상황.
    localStorage.setItem('wt:auth', STALE_LOGGED_OUT_AUTH_JSON);
    await useAuthStore.persist.rehydrate();

    // 수정 전: 고아 스윕이 무조건 발동해 토큰이 삭제됨(버그) — 수정 후: 게이트로 스킵되어 생존.
    expect(getAuthToken()).toBe('wt1.acct');
  });

  it('R2(원 의도 보존): 최초 부팅 시뮬레이션 — 프로필 없이 토큰만 있으면 스윕이 토큰을 소거한다', async () => {
    __resetAuthHydrationForTests(); // "최초 부팅"을 명시적으로 재현.
    localStorage.setItem('wt:authtoken', 'wt1.orphan'); // wt:auth 없음(=playerId null, beforeEach logout)
    await useAuthStore.persist.rehydrate();
    expect(getAuthToken()).toBeNull();
  });

  it('R3(크로스탭 로그아웃 전파 불변): 프로필이 살아있는데 토큰이 사라지면 rehydrate 경로에서도 로그아웃된다', async () => {
    await useAuthStore.persist.rehydrate(); // 최초 하이드레이션 소비(게이트가 잠긴 상태 재현).
    useAuthStore.getState().login(session());
    localStorage.removeItem('wt:authtoken');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().playerId).toBeNull();
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  it('R4(자연 수화): R1 시퀀스 이후 신값 wt:auth가 도착하면 프로필이 수화되고 로그인 판정된다', async () => {
    await useAuthStore.persist.rehydrate();
    useAuthStore.getState().login(session());
    localStorage.setItem('wt:auth', STALE_LOGGED_OUT_AUTH_JSON);
    await useAuthStore.persist.rehydrate(); // 토큰만 신값인 과도기(R1과 동일 지점).
    expect(getAuthToken()).toBe('wt1.acct');

    // 로그인 탭의 두 번째 기록(wt:auth 신값)이 뒤이어 도착.
    localStorage.setItem(
      'wt:auth',
      JSON.stringify({
        state: {
          playerId: 'p-acct',
          nickname: 'Traveler',
          profile: session().profile,
          geo: 'KR',
          expiresAt: FUTURE,
        },
        version: 0,
      }),
    );
    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState().playerId).toBe('p-acct');
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
  });
});
