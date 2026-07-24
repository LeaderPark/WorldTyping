// @vitest-environment jsdom
//
// spec: docs/03 §4.3(6번째 스토어), docs/00 §11-D68 + WT-AUTH-03.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectIsLoggedIn, useAuthStore, type AccountSession } from './auth';
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
