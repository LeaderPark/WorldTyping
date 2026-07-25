// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S9 로비 와이어프레임), docs/00 §11-D23(v1 race-mixed만 — 모드 선택 UI 없음)·
//       D68(멀티=로그인 필수·로비 재구성), WT-M4-04 → WT-AUTH-05
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../../app/providers';
import { useSettingsStore } from '../../../stores/settings';
import { useAuthStore, type AccountSession } from '../../../stores/auth';
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

const ACCOUNT: AccountSession = {
  token: 'acct-tok',
  playerId: 'acct-1',
  nickname: 'Tester',
  expiresAt: Date.now() + 1_000_000_000,
  geo: 'KR',
  profile: { name: 'Tester', picture: null, email: null },
};

function logIn(): void {
  act(() => useAuthStore.getState().login(ACCOUNT));
}

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

const PUBLIC_LIST = {
  rooms: [
    { code: 'ABC123', lang: 'ko', players: 2, maxPlayers: 8, title: '서울 정복', phase: 'WAITING', hostCover: 'basic-green' },
    { code: 'XYZ789', lang: 'en', players: 4, maxPlayers: 4, title: 'Speed run', phase: 'RACING', hostCover: null },
  ],
  // [WT-TWEAK-LOBBY-SIMPLE] 서버 응답은 counts도 포함하지만 LobbyPage가 더 이상 소비하지 않는다 —
  // 실제 응답 형태를 재현해 무시 경로를 검증하기 위해 그대로 남겨둔다.
  counts: { public: 2, private: 5 },
};

describe('LobbyPage (WT-AUTH-05)', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('ko');
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: '', expiresAt: '' });
    getMock.mockResolvedValue(PUBLIC_LIST);
    postMock.mockResolvedValue({ roomCode: 'AB12CD', wsUrl: '/ws/room/AB12CD', ticket: 'tk', lang: 'ko', title: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('모드 선택 UI 없이 배너·퀵매치·방 만들기·검색·방 카드를 렌더한다(§11-D23)', async () => {
    renderLobby();
    expect(screen.getByTestId('lobby-banner')).toHaveAttribute('data-variant', 'guest');
    expect(screen.getByTestId('lobby-quickmatch')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-create-open')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-search')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /mode/i })).not.toBeInTheDocument();

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/rooms/public'));
    expect(await screen.findByTestId('lobby-room-card-ABC123')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-room-card-XYZ789')).toBeInTheDocument();
  });

  it('[WT-TWEAK-LOBBY-SIMPLE] 카운트/필터 세그먼트 UI 없이 공개 방 목록 전부를 보여주고, 진행 중(RACING) 방은 입장 대신 잠금을 보여준다', async () => {
    renderLobby();
    await screen.findByTestId('lobby-room-card-ABC123');

    // 카운트/필터 탭 UI가 제거되었다 — 응답의 counts는 무시하고 rooms 전부를 그대로 노출한다.
    expect(screen.queryByTestId('lobby-filter-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lobby-filter-public')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lobby-filter-private')).not.toBeInTheDocument();
    expect(screen.getByTestId('lobby-room-card-ABC123')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-room-card-XYZ789')).toBeInTheDocument();

    // WAITING 방은 입장 버튼, RACING 방은 잠금.
    expect(screen.getByTestId('lobby-room-enter-ABC123')).toBeInTheDocument();
    expect(screen.queryByTestId('lobby-room-enter-XYZ789')).not.toBeInTheDocument();
    expect(screen.getByTestId('lobby-room-locked-XYZ789')).toBeInTheDocument();
  });

  it('검색어가 방 제목을 클라이언트 필터한다', async () => {
    renderLobby();
    await screen.findByTestId('lobby-room-card-ABC123');

    fireEvent.change(screen.getByTestId('lobby-search'), { target: { value: '서울' } });
    expect(screen.getByTestId('lobby-room-card-ABC123')).toBeInTheDocument();
    expect(screen.queryByTestId('lobby-room-card-XYZ789')).not.toBeInTheDocument();
  });

  it('비로그인 상태에서 퀵매치를 누르면 REST를 호출하지 않고 로그인(멀티)을 연다', async () => {
    renderLobby();
    fireEvent.click(screen.getByTestId('lobby-quickmatch'));

    expect(useAuthStore.getState().loginReason).toBe('multi');
    expect(postMock).not.toHaveBeenCalledWith('/match/quick', expect.anything());
    // 매칭 풀스크린으로 전환되지 않는다(액션은 보류됨).
    expect(screen.queryByTestId('lobby-matching')).not.toBeInTheDocument();
  });

  it('비로그인 방 만들기 게이트 → 로그인 성공 시 보류 액션(모달 열기)이 재개된다', async () => {
    renderLobby();
    fireEvent.click(screen.getByTestId('lobby-create-open'));

    expect(useAuthStore.getState().loginReason).toBe('multi');
    expect(screen.queryByTestId('lobby-create-modal')).not.toBeInTheDocument();

    logIn();
    expect(await screen.findByTestId('lobby-create-modal')).toBeInTheDocument();
  });

  it('로그인 상태에서 퀵매치는 즉시 /match/quick을 호출한다', async () => {
    logIn();
    renderLobby();
    fireEvent.click(screen.getByTestId('lobby-quickmatch'));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/match/quick', { lang: 'ko' }));
  });

  it('로그인 상태에서 6자 코드 검색 후 Enter는 코드 참가(/rooms/:code/join)를 호출한다', async () => {
    logIn();
    renderLobby();
    const input = screen.getByTestId('lobby-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc123' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/rooms/ABC123/join', {}));
  });

  it('로그인하면 배너가 member 변형으로 바뀐다', async () => {
    logIn();
    renderLobby();
    expect(screen.getByTestId('lobby-banner')).toHaveAttribute('data-variant', 'member');
  });
});
