// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S9 로비 와이어프레임), docs/00 §11-D23(v1 race-mixed만 — 모드 선택 UI 없음),
//       WT-M4-04
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../../app/providers';
import { useSettingsStore } from '../../../stores/settings';
import { LobbyPage } from './index';

const getMock = vi.fn();
const postMock = vi.fn();
const ensureSessionMock = vi.fn();

vi.mock('../../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../../net/api-client')>('../../../net/api-client');
  return {
    ...actual,
    apiClient: { get: (...a: unknown[]) => getMock(...a), post: (...a: unknown[]) => postMock(...a) },
    ensureSession: (...a: unknown[]) => ensureSessionMock(...a),
  };
});

function renderLobby() {
  return render(
    <MemoryRouter initialEntries={['/multi']}>
      <AppProviders>
        <Routes>
          <Route path="/multi" element={<LobbyPage />} />
          <Route path="/multi/:roomCode" element={<p data-testid="landed-room-page" />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
}

describe('LobbyPage (WT-M4-04)', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('ko');
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: '', expiresAt: '' });
    getMock.mockResolvedValue({ rooms: [{ code: 'KX73QP', lang: 'ko', players: 3, maxPlayers: 8 }] });
    postMock.mockResolvedValue({ roomCode: 'AB12CD', wsUrl: '/ws/room/AB12CD', ticket: 'tk', lang: 'ko' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('모드 선택 UI 없이 퀵매치/방 만들기/코드 참가/공개 방 목록을 렌더한다(§11-D23)', async () => {
    renderLobby();
    expect(screen.getByTestId('lobby-quickmatch')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-create-submit')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-join-code')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /mode/i })).not.toBeInTheDocument();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/rooms/public'));
    expect(await screen.findByTestId('lobby-public-room-KX73QP')).toBeInTheDocument();
  });

  it('퀵매치 클릭 → REST 그랜트 취득 후 /multi/{roomCode}로 이동(grant를 state로 전달)', async () => {
    renderLobby();
    fireEvent.click(screen.getByTestId('lobby-quickmatch'));

    await waitFor(() => expect(screen.getByTestId('landed-room-page')).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledWith('/match/quick', { lang: 'ko' });
  });

  it('코드 참가 입력이 3-3 하이픈으로 자동 포맷된다', () => {
    renderLobby();
    const input = screen.getByTestId('lobby-join-code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'kx73qp' } });
    expect(input.value).toBe('KX7-3QP');
  });

  it('공개 방 목록의 참가 버튼이 /rooms/:code/join을 호출한다', async () => {
    renderLobby();
    await screen.findByTestId('lobby-public-room-KX73QP');
    const entry = screen.getByTestId('lobby-public-room-KX73QP');
    fireEvent.click(entry.querySelector('button')!);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/rooms/KX73QP/join', {}));
  });
});
