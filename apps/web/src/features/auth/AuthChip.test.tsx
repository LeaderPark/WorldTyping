// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-⑥ + WT-AUTH-03(로그인 버튼 ↔ 프로필 칩 + 로그아웃 드롭다운).
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/providers';
import { selectIsLoggedIn, useAuthStore, type AccountSession } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { AuthChip } from './AuthChip';

function session(): AccountSession {
  return {
    token: 'wt1.acct',
    playerId: 'p1',
    nickname: 'Traveler',
    expiresAt: Date.now() + 60_000,
    geo: 'KR',
    profile: { name: 'Traveler', picture: null, email: null },
  };
}

function renderChip() {
  return render(
    <AppProviders>
      <AuthChip />
    </AppProviders>,
  );
}

describe('AuthChip (WT-AUTH-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => cleanup());

  it('비로그인 시 로그인 버튼을 렌더하고 클릭하면 로그인 모달을 연다', () => {
    renderChip();
    const loginBtn = screen.getByTestId('topbar-login');
    expect(loginBtn).toBeInTheDocument();
    expect(screen.queryByTestId('topbar-profile')).not.toBeInTheDocument();

    act(() => loginBtn.click());
    expect(useAuthStore.getState().loginReason).toBe('general');
  });

  it('로그인 시 프로필 칩(닉네임)을 렌더하고 드롭다운으로 로그아웃한다', async () => {
    act(() => useAuthStore.getState().login(session()));
    renderChip();

    const profile = screen.getByTestId('topbar-profile');
    expect(profile).toHaveTextContent('Traveler');
    expect(screen.queryByTestId('topbar-login')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-logout')).not.toBeInTheDocument();

    act(() => profile.click());
    const logout = await screen.findByTestId('topbar-logout');
    expect(profile).toHaveAttribute('aria-expanded', 'true');

    act(() => logout.click());
    await waitFor(() => expect(selectIsLoggedIn(useAuthStore.getState())).toBe(false));
    expect(screen.getByTestId('topbar-login')).toBeInTheDocument();
  });
});
