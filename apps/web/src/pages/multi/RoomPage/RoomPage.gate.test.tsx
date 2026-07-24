// @vitest-environment jsdom
//
// spec: docs/00 §11-D68(멀티=로그인 필수), WT-AUTH-05 — RoomPage 딥링크 로그인 게이트.
// grant 없는 딥링크(초대 링크 직접 진입)는 비로그인 시 연결하지 않고 로그인 모달을 띄운다.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../../app/providers';
import { useAuthStore, type AccountSession } from '../../../stores/auth';
import { useMultiplayerStore } from '../../../stores/multiplayer';
import { useSettingsStore } from '../../../stores/settings';
import { RoomPage } from './index';

// useMultiplayer는 실제 WS 매니저를 만든다 — 게이트 검증엔 연결 호출 여부만 필요하므로 훅을 목킹한다.
const mpMocks = vi.hoisted(() => ({
  connectWithGrant: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
}));
vi.mock('../../../features/multiplayer/useMultiplayer', () => ({
  useMultiplayer: () => mpMocks,
}));

const ACCOUNT: AccountSession = {
  token: 'acct-tok',
  playerId: 'acct-1',
  nickname: 'Tester',
  expiresAt: Date.now() + 1_000_000_000,
  geo: 'KR',
  profile: { name: 'Tester', picture: null, email: null },
};

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/multi/ABC123']}>
      <AppProviders>
        <Routes>
          <Route path="/multi" element={<p data-testid="lobby-stub" />} />
          <Route path="/multi/:roomCode" element={<RoomPage />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
}

describe('RoomPage 딥링크 로그인 게이트 (WT-AUTH-05)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    useMultiplayerStore.getState().reset();
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('비로그인 딥링크는 연결하지 않고 로그인(멀티)을 연다', () => {
    renderRoom();
    expect(useAuthStore.getState().loginReason).toBe('multi');
    expect(mpMocks.join).not.toHaveBeenCalled();
    expect(mpMocks.connectWithGrant).not.toHaveBeenCalled();
  });

  it('로그인을 취소하면 로비로 돌아간다', async () => {
    renderRoom();
    expect(useAuthStore.getState().loginReason).toBe('multi');

    act(() => useAuthStore.getState().closeLogin());
    expect(await screen.findByTestId('lobby-stub')).toBeInTheDocument();
    expect(mpMocks.join).not.toHaveBeenCalled();
  });

  it('로그인 상태의 딥링크는 REST join으로 연결한다 — 신원=계정 닉(GUEST_ 미포함, §11-D88)', () => {
    act(() => useAuthStore.getState().login(ACCOUNT));
    renderRoom();
    expect(mpMocks.join).toHaveBeenCalledWith(
      'ABC123',
      expect.objectContaining({ nickname: 'Tester', passportCover: expect.any(String) }),
    );
    const identity = mpMocks.join.mock.calls[0]?.[1] as { nickname: string };
    expect(identity.nickname).not.toMatch(/^GUEST_/);
  });

  it('연결 실패 화면은 lastError 사유별 i18n 키를 표기한다 (§11-D89)', async () => {
    useSettingsStore.getState().setLang('ko');
    act(() => useAuthStore.getState().login(ACCOUNT));
    renderRoom();
    // 마운트 effect가 reset() 후 연결(mock no-op)한 뒤 사유와 함께 실패 상태로 전이시킨다.
    act(() => {
      useMultiplayerStore.getState().setLastError({ code: 'ROOM_NOT_FOUND', message: 'x' });
      useMultiplayerStore.getState().setConnection('failed');
    });
    expect(await screen.findByText('방을 찾을 수 없어요')).toBeInTheDocument();
  });
});
