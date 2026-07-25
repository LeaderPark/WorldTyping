// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-②/⑥/⑩ + WT-AUTH-03 + WT-AUTH-REDIRECT(기본 로그인 = GIS ux_mode:'redirect').
// useLogin/gis-loader를 목킹해 client ID 경로와 DEV 폴백 경로를 각각 결정적으로 검증한다
// (로컬 .env.local 유무와 무관).
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { GOOGLE_REDIRECT_LOGIN_PATH, LOGIN_RETURN_TO_KEY, takeAuthRedirectError } from './authcode-boot';
import { LoginModal } from './LoginModal';
import { useLogin } from './useLogin';
import { loadGis } from './gis-loader';

vi.mock('./useLogin', () => ({ useLogin: vi.fn() }));
vi.mock('./gis-loader', () => ({ loadGis: vi.fn(), __resetGisForTests: vi.fn() }));
vi.mock('./authcode-boot', async () => {
  const actual = await vi.importActual<typeof import('./authcode-boot')>('./authcode-boot');
  return { ...actual, takeAuthRedirectError: vi.fn(() => false) };
});

const useLoginMock = vi.mocked(useLogin);
const loadGisMock = vi.mocked(loadGis);
const takeAuthRedirectErrorMock = vi.mocked(takeAuthRedirectError);

/** GIS 전역 목 — initialize에 넘어온 설정을 캡처한다. */
function mockGis(): { initialize: ReturnType<typeof vi.fn>; renderButton: ReturnType<typeof vi.fn> } {
  const initialize = vi.fn();
  const renderButton = vi.fn();
  loadGisMock.mockResolvedValue({
    accounts: { id: { initialize, renderButton, prompt: vi.fn(), cancel: vi.fn(), disableAutoSelect: vi.fn() } },
  });
  return { initialize, renderButton };
}

function renderModal() {
  return render(
    <AppProviders>
      <LoginModal />
    </AppProviders>,
  );
}

describe('LoginModal (WT-AUTH-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().closeLogin();
    vi.clearAllMocks();
    takeAuthRedirectErrorMock.mockReturnValue(false);
    useLoginMock.mockReturnValue({
      clientId: undefined,
      devFallback: true,
      handleCredential: vi.fn().mockResolvedValue(undefined),
      loginDev: vi.fn().mockResolvedValue(undefined),
    });
  });
  afterEach(() => cleanup());

  it('loginReason이 null이면 아무것도 렌더하지 않는다', () => {
    renderModal();
    expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument();
  });

  it('사유(reason)가 문구/데이터 속성에 반영된다', async () => {
    renderModal();
    act(() => useAuthStore.getState().openLogin('ranking'));
    await screen.findByTestId('login-modal');
    expect(screen.getByTestId('login-reason')).toHaveAttribute('data-reason', 'ranking');
  });

  it('취소 버튼이 모달을 닫는다', async () => {
    renderModal();
    act(() => useAuthStore.getState().openLogin('general'));
    await screen.findByTestId('login-modal');
    act(() => screen.getByTestId('login-cancel').click());
    await waitFor(() => expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument());
  });

  it('DEV 폴백: dev 로그인 버튼 클릭 시 loginDev 호출 후 닫힌다', async () => {
    const loginDev = vi.fn().mockResolvedValue(undefined);
    useLoginMock.mockReturnValue({ clientId: undefined, devFallback: true, handleCredential: vi.fn(), loginDev });
    renderModal();
    act(() => useAuthStore.getState().openLogin('multi'));
    const devBtn = await screen.findByTestId('login-dev');

    await act(async () => {
      devBtn.click();
    });
    await waitFor(() => expect(loginDev).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument());
  });

  it('[WT-AUTH-REDIRECT] client ID가 있으면 GIS를 ux_mode:redirect + login_uri로 초기화하고 공식 버튼을 렌더한다', async () => {
    const { initialize, renderButton } = mockGis();
    useLoginMock.mockReturnValue({
      clientId: 'cid.apps.googleusercontent.com',
      devFallback: false,
      handleCredential: vi.fn(),
      loginDev: vi.fn(),
    });

    renderModal();
    act(() => useAuthStore.getState().openLogin('multi'));
    await screen.findByTestId('login-modal');

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const cfg = initialize.mock.calls[0]?.[0] as GsiIdConfig;
    expect(cfg.client_id).toBe('cid.apps.googleusercontent.com');
    // 전체 페이지 이동 경로 — 팝업/FedCM 경로는 더 이상 쓰지 않는다(라이브 장애 대응).
    expect(cfg.ux_mode).toBe('redirect');
    expect(cfg.login_uri).toBe(`${window.location.origin}${GOOGLE_REDIRECT_LOGIN_PATH}`);
    expect(cfg.use_fedcm_for_prompt).toBeUndefined();
    expect(cfg.use_fedcm_for_button).toBeUndefined();
    // login_uri는 GIS 규약상 절대 URI여야 한다.
    expect(cfg.login_uri?.startsWith('http')).toBe(true);

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('login-dev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-error')).not.toBeInTheDocument();
  });

  it('[WT-AUTH-REDIRECT] 부트에서 ?authError=1을 소비했으면 열리자마자 generic 에러 문구를 띄운다', async () => {
    mockGis();
    takeAuthRedirectErrorMock.mockReturnValue(true);
    useLoginMock.mockReturnValue({
      clientId: 'cid.apps.googleusercontent.com',
      devFallback: false,
      handleCredential: vi.fn(),
      loginDev: vi.fn(),
    });

    renderModal();
    act(() => useAuthStore.getState().openLogin('general'));

    const alert = await screen.findByTestId('login-error');
    expect(alert).toHaveTextContent('Sign-in failed. Please try again in a moment.');
  });

  it('[WT-AUTH-REDIRECT] 모달이 열리면 로그인 직전 경로를 sessionStorage에 기록한다(전체 페이지 이동 후 복귀용)', async () => {
    mockGis();
    useLoginMock.mockReturnValue({
      clientId: 'cid.apps.googleusercontent.com',
      devFallback: false,
      handleCredential: vi.fn(),
      loginDev: vi.fn(),
    });
    window.history.replaceState(null, '', '/rank?period=all#me');

    renderModal();
    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBeNull(); // 닫혀 있으면 기록하지 않는다.

    act(() => useAuthStore.getState().openLogin('ranking'));
    await screen.findByTestId('login-modal');

    expect(sessionStorage.getItem(LOGIN_RETURN_TO_KEY)).toBe('/rank?period=all#me');
  });
});
