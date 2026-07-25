// @vitest-environment jsdom
//
// spec: WT-AUTH-REDIRECT — GIS ux_mode:'redirect' 착지 처리(부트 1회 authcode 교환).
// net/api-client의 exchangeAuthCode만 목킹하고 로그인 성립 경로(useAuthStore.login → setAuthToken
// read-back 검증, §11-D86 F4)는 실물을 그대로 태운다 — "기존 경로 재사용"이 이 태스크의 계약이라
// 목으로 우회하면 검증 의미가 없다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  exchangeAuthCode,
  getAuthToken,
  __resetSessionForTests,
  type AuthExchangeRes,
} from '../../net/api-client';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';
import {
  consumeAuthRedirect,
  rememberLoginReturnTo,
  takeAuthRedirectError,
  LOGIN_RETURN_TO_KEY,
  __resetAuthRedirectErrorForTests,
} from './authcode-boot';

// exchangeAuthCode(네트워크)만 갈아끼우고 나머지(setAuthToken read-back 등)는 실물 유지.
vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return { ...actual, exchangeAuthCode: vi.fn() };
});

const exchangeMock = vi.mocked(exchangeAuthCode);

const CODE = '0123456789abcdef0123456789abcdef';

function exchangeRes(): AuthExchangeRes {
  return {
    token: 'wt1.acct.redirect',
    user: {
      playerId: 'pid-redirect',
      nickname: 'RedirUser',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      geo: 'KR',
      acct: true,
      email: 'redir@example.com',
      name: 'Redir Fullname',
      picture: 'https://lh3.googleusercontent.com/a',
    },
  };
}

function setUrl(search: string, path = '/lobby'): void {
  window.history.replaceState(null, '', `${path}${search}`);
}

describe('authcode-boot — GIS redirect 착지 처리 (WT-AUTH-REDIRECT)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetSessionForTests();
    __resetAuthRedirectErrorForTests();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('쿼리가 없으면 완전한 no-op(네트워크 호출 0, URL 불변)', async () => {
    setUrl('?tab=all');
    await consumeAuthRedirect();

    expect(exchangeMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=all');
    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
  });

  it('authcode → 교환 후 기존 login() 경로로 로그인 성립(토큰 영속 포함) + URL에서 코드 제거', async () => {
    exchangeMock.mockResolvedValue(exchangeRes());
    setUrl(`?authcode=${CODE}&tab=all`);

    await consumeAuthRedirect();

    expect(exchangeMock).toHaveBeenCalledWith(CODE);
    const state = useAuthStore.getState();
    expect(state.playerId).toBe('pid-redirect');
    expect(state.nickname).toBe('RedirUser');
    expect(state.profile).toEqual({
      name: 'Redir Fullname',
      picture: 'https://lh3.googleusercontent.com/a',
      email: 'redir@example.com',
    });
    // 토큰은 스토어 persist가 아니라 원시 키(wt:authtoken)에 — login()이 소유하는 경로 그대로.
    expect(getAuthToken()).toBe('wt1.acct.redirect');
    expect(selectIsLoggedIn(state)).toBe(true);

    // authcode만 제거하고 다른 쿼리·경로는 보존.
    expect(window.location.pathname).toBe('/lobby');
    expect(window.location.search).toBe('?tab=all');
  });

  it('교환 실패(401 만료/재사용)는 조용히 무시하고 URL만 정리한다(모달을 열지 않는다)', async () => {
    exchangeMock.mockRejectedValue(new ApiError(401, 'INVALID_CODE', 'expired'));
    setUrl(`?authcode=${CODE}`);

    await consumeAuthRedirect();

    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false);
    expect(useAuthStore.getState().loginReason).toBeNull();
    expect(takeAuthRedirectError()).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('URL 정리는 네트워크 왕복 전에 끝난다(코드가 주소창에 남는 창이 없다)', async () => {
    let searchAtCall = 'not-called';
    exchangeMock.mockImplementation(async () => {
      searchAtCall = window.location.search;
      return exchangeRes();
    });
    setUrl(`?authcode=${CODE}`);

    await consumeAuthRedirect();
    expect(searchAtCall).toBe('');
  });

  it('authError=1 → 로그인 모달을 열고 1회성 에러 플래그를 세운다(교환 시도 없음)', async () => {
    setUrl('?authError=1');

    await consumeAuthRedirect();

    expect(exchangeMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().loginReason).toBe('general');
    expect(window.location.search).toBe('');
    // 플래그는 1회 소비 — LoginModal이 읽고 나면 사라진다.
    expect(takeAuthRedirectError()).toBe(true);
    expect(takeAuthRedirectError()).toBe(false);
  });

  // ── 로그인 직전 경로 복귀(wt:loginReturnTo) ──
  // 서버 302는 항상 `/`로 되돌려 준다 — 로비/랭킹에서 로그인한 사용자를 원래 화면으로 되돌린다.

  it('rememberLoginReturnTo가 현재 경로(쿼리·해시 포함)를 sessionStorage에 기록한다', () => {
    setUrl('?tab=all#top', '/rank');
    rememberLoginReturnTo();
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBe('/rank?tab=all#top');
  });

  it('authcode + 복귀 경로 → 교환 성공 후 그 경로로 replaceState하고 키를 소거한다', async () => {
    exchangeMock.mockResolvedValue(exchangeRes());
    sessionStorage.setItem(LOGIN_RETURN_TO_KEY, '/rank?period=all#me');
    setUrl(`?authcode=${CODE}`, '/');

    await consumeAuthRedirect();

    expect(selectIsLoggedIn(useAuthStore.getState())).toBe(true);
    expect(window.location.pathname).toBe('/rank');
    expect(window.location.search).toBe('?period=all');
    expect(window.location.hash).toBe('#me');
    // one-shot — 다음 부팅에 재사용되지 않는다.
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull();
  });

  it('외부 URL·프로토콜 상대 경로는 거부하고 현재 경로를 유지한다(오픈 리다이렉트 차단)', async () => {
    for (const evil of ['https://evil.com', '//evil.com/pwn', 'evil.com', '']) {
      exchangeMock.mockResolvedValue(exchangeRes());
      sessionStorage.setItem(LOGIN_RETURN_TO_KEY, evil);
      setUrl(`?authcode=${CODE}`, '/');

      await consumeAuthRedirect();

      expect(window.location.pathname).toBe('/');
      expect(window.location.href).not.toContain('evil.com');
      expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull(); // 거부해도 소거는 한다.
    }
  });

  it('authError=1 + 복귀 경로 → 원래 화면으로 되돌린 뒤 모달을 연다', async () => {
    sessionStorage.setItem(LOGIN_RETURN_TO_KEY, '/lobby?filter=open');
    setUrl('?authError=1', '/');

    await consumeAuthRedirect();

    expect(window.location.pathname).toBe('/lobby');
    expect(window.location.search).toBe('?filter=open');
    expect(useAuthStore.getState().loginReason).toBe('general');
    expect(takeAuthRedirectError()).toBe(true);
  });

  it('sessionStorage 접근이 막힌 환경에서도 저장·복원이 조용한 no-op이다(홈 착지 폴백)', async () => {
    const blocked = new Error('storage blocked');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw blocked;
    });
    expect(() => rememberLoginReturnTo()).not.toThrow();
    setItem.mockRestore();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw blocked;
    });
    exchangeMock.mockResolvedValue(exchangeRes());
    setUrl(`?authcode=${CODE}`, '/lobby');

    await expect(consumeAuthRedirect()).resolves.toBeUndefined();
    // 복귀 경로를 못 읽었으므로 현재 경로에서 쿼리만 지운다(기존 동작 그대로).
    expect(window.location.pathname).toBe('/lobby');
    expect(window.location.search).toBe('');
  });
});
