// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-⑥(SettingsOverlay 전면 제거 — 기어=테마 토글, 데이터 열람/삭제는 /privacy로
// 이전), WT-AUTH-03. 구 S12 설정 오버레이 테스트는 이 태스크로 폐기됐고(오버레이 부재를 회귀
// 가드로 남긴다), 데이터 셀프서비스 테스트는 PrivacyPage/index.test.tsx로 이전했다. 여기서는 (1)
// ?modal=settings 딥링크가 더는 오버레이를 열지 않음, (2) 전역 LoginModal 열림/닫힘을 검증한다.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';
import { useSettingsStore } from '../stores/settings';
import { useAuthStore } from '../stores/auth';

// LoginModal이 GIS 실 client ID 경로를 타지 않도록 useLogin을 DEV 폴백으로 고정한다(로컬 .env.local
// 유무와 무관하게 결정적으로 — dev 버튼 경로만 렌더).
vi.mock('../features/auth/useLogin', () => ({
  useLogin: () => ({
    clientId: undefined,
    devFallback: true,
    handleCredential: vi.fn().mockResolvedValue(undefined),
    loginDev: vi.fn().mockResolvedValue(undefined),
  }),
  GOOGLE_CLIENT_ID: undefined,
  DEV_LOGIN_FALLBACK: true,
}));

function renderShell(initial = '/') {
  localStorage.setItem('wt:lang', 'en');
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('AppShell — SettingsOverlay 제거(§11-D68-⑥)', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    cleanup();
    useAuthStore.getState().closeLogin();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('?modal=settings로 진입해도 설정 오버레이(및 dialog)가 더는 열리지 않는다', async () => {
    renderShell('/?modal=settings');
    await screen.findByTestId('home-page');
    expect(screen.queryByTestId('settings-close')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-data-export')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('AppShell — 전역 LoginModal(§11-D68)', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    cleanup();
    useAuthStore.getState().closeLogin();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('기본 상태에서는 로그인 모달이 렌더되지 않는다', async () => {
    renderShell('/');
    await screen.findByTestId('home-page');
    expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument();
  });

  it('openLogin(reason)이 모달을 열고 사유가 반영되며 취소로 닫힌다', async () => {
    renderShell('/');
    await screen.findByTestId('home-page');

    act(() => useAuthStore.getState().openLogin('multi'));
    expect(await screen.findByTestId('login-modal')).toBeInTheDocument();
    expect(screen.getByTestId('login-reason')).toHaveAttribute('data-reason', 'multi');

    act(() => screen.getByTestId('login-cancel').click());
    await waitFor(() => expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument());
  });
});
