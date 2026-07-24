// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-②/⑥/⑩ + WT-AUTH-03. useLogin/gis-loader를 목킹해 client ID 경로와 DEV
// 폴백 경로를 각각 결정적으로 검증한다(로컬 .env.local 유무와 무관).
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { LoginModal } from './LoginModal';
import { useLogin } from './useLogin';
import { loadGis } from './gis-loader';

vi.mock('./useLogin', () => ({ useLogin: vi.fn() }));
vi.mock('./gis-loader', () => ({ loadGis: vi.fn(), __resetGisForTests: vi.fn() }));

const useLoginMock = vi.mocked(useLogin);
const loadGisMock = vi.mocked(loadGis);

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
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().closeLogin();
    vi.clearAllMocks();
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

  it('client ID가 있으면 GIS 공식 버튼을 렌더하고 credential 콜백이 로그인→닫힘을 트리거한다', async () => {
    let captured: ((r: GsiCredentialResponse) => void) | null = null;
    const initialize = vi.fn((cfg: GsiIdConfig) => {
      captured = cfg.callback;
    });
    const renderButton = vi.fn();
    loadGisMock.mockResolvedValue({
      accounts: { id: { initialize, renderButton, prompt: vi.fn(), cancel: vi.fn(), disableAutoSelect: vi.fn() } },
    });
    const handleCredential = vi.fn().mockResolvedValue(undefined);
    useLoginMock.mockReturnValue({ clientId: 'cid.apps.googleusercontent.com', devFallback: false, handleCredential, loginDev: vi.fn() });

    renderModal();
    act(() => useAuthStore.getState().openLogin('multi'));
    await screen.findByTestId('login-modal');

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('login-dev')).not.toBeInTheDocument();

    await act(async () => {
      captured?.({ credential: 'the-credential' });
    });
    await waitFor(() => expect(handleCredential).toHaveBeenCalledWith('the-credential'));
    await waitFor(() => expect(screen.queryByTestId('login-modal')).not.toBeInTheDocument());
  });
});
