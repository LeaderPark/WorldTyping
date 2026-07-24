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

// [WT-AUTH-06] Footer는 브라우징 화면에서만 마운트한다(§11-D68-⑨) — 인게임(/play/*)·대기실/
// 레이스(/multi/:code)는 제외, 로비(/multi) 자체는 허용. 실제 페이지 컴포넌트(GamePage 등)는
// 무거운 의존성을 끌고 오므로 라우트 판별 로직만 검증하는 가벼운 스텁 엘리먼트를 대신 마운트한다.
function renderShellAt(initial: string) {
  localStorage.setItem('wt:lang', 'en');
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="play" element={<div data-testid="stub-mode-select" />} />
            <Route path="play/:mode" element={<div data-testid="stub-track-select" />} />
            <Route path="play/:mode/:trackId" element={<div data-testid="stub-game" />} />
            <Route path="rank" element={<div data-testid="stub-rank" />} />
            <Route path="multi" element={<div data-testid="stub-lobby" />} />
            <Route path="multi/:roomCode" element={<div data-testid="stub-room" />} />
            <Route path="privacy" element={<div data-testid="stub-privacy" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('AppShell — SiteFooter 노출 범위(§11-D68-⑨, WT-AUTH-06)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('홈에는 Footer가 보인다', async () => {
    renderShellAt('/');
    await screen.findByTestId('home-page');
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
  });

  it('로비(/multi)에는 Footer가 보인다(대기실과 달리 브라우징 화면)', async () => {
    renderShellAt('/multi');
    await screen.findByTestId('stub-lobby');
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
  });

  it('랭킹·개인정보처리방침에도 Footer가 보인다', async () => {
    renderShellAt('/rank');
    await screen.findByTestId('stub-rank');
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
    cleanup();

    renderShellAt('/privacy');
    await screen.findByTestId('stub-privacy');
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
  });

  it('인게임(/play, /play/:mode, /play/:mode/:trackId)에는 Footer가 보이지 않는다', async () => {
    renderShellAt('/play');
    await screen.findByTestId('stub-mode-select');
    expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
    cleanup();

    renderShellAt('/play/continent');
    await screen.findByTestId('stub-track-select');
    expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
    cleanup();

    renderShellAt('/play/continent/asia-1');
    await screen.findByTestId('stub-game');
    expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
  });

  it('대기실/레이스(/multi/:roomCode)에는 Footer가 보이지 않는다', async () => {
    renderShellAt('/multi/KX7-3QP');
    await screen.findByTestId('stub-room');
    expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
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
