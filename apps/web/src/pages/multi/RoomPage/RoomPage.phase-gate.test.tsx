// @vitest-environment jsdom
//
// spec: WT-FIX-FINISH-TRANSITION(리드 진단) — 멀티에서 전원 완주해도 결과 화면으로 전환되지 않는
// 버그의 회귀 테스트. 서버 MatchRoom.finishRace()가 room-state(phase='FINISHED')를 브로드캐스트하지
// 않던 결함을 고쳤지만(workers/api/src/do/MatchRoom.ts), 클라도 이중 안전망으로 room.phase==='result'
// 뿐 아니라 raceFinishedReason(기존 dead state, stores/multiplayer.ts)이 도착해 있으면 결과 화면을
// 표시한다(RoomPage/index.tsx :196). 이 파일은 그 게이트 조건 자체를 검증한다 — 실제 WS 배선(useMultiplayer
// routeMessage)의 회귀는 features/multiplayer/useMultiplayer.test.ts가 별도로 담당한다.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { S2C_Results } from '@wt/shared';
import { AppProviders } from '../../../app/providers';
import { useAuthStore, type AccountSession } from '../../../stores/auth';
import { useMultiplayerStore, type RoomState } from '../../../stores/multiplayer';
import { RoomPage } from './index';

// useMultiplayer는 실제 WS 매니저를 만든다 — 게이트 검증엔 room/raceResult/raceFinishedReason 스토어
// 상태만 필요하므로 훅을 목킹한다(RoomPage.gate.test.tsx와 동일 패턴).
const mpMocks = vi.hoisted(() => ({
  connectWithGrant: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  rematch: vi.fn(),
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

const BASE_ROOM: RoomState = {
  code: 'ABC123',
  hostId: 'acct-1',
  lang: 'en',
  players: [],
  phase: 'racing',
  maxPlayers: 8,
  isPublic: false,
  autoStartAt: null,
};

const RACE_RESULT: S2C_Results = {
  v: 1,
  type: 'results',
  raceId: 'r1',
  rows: [
    { playerId: 'acct-1', nickname: 'Tester', isBot: false, rank: 1, finished: true, countriesCleared: 15, elapsedMs: 60000, cpm: 400, acc: 98, pi: 390, disconnected: false },
  ],
  rematchDeadline: Date.now() + 30_000,
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

describe('RoomPage 결과 화면 전환 게이트 (WT-FIX-FINISH-TRANSITION)', () => {
  beforeEach(() => {
    useAuthStore.getState().login(ACCOUNT); // 딥링크 로그인 게이트를 우회(WT-AUTH-05, 이 테스트 관심사 아님).
    useMultiplayerStore.getState().reset();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    useAuthStore.getState().logout();
  });

  it('room.phase===\'result\'면 정상적으로 RaceResult를 렌더한다(정상 경로)', () => {
    renderRoom();
    act(() => {
      useMultiplayerStore.getState().setRoom({ ...BASE_ROOM, phase: 'result' });
      useMultiplayerStore.getState().setRaceResult(RACE_RESULT);
    });
    expect(screen.getByTestId('race-result')).toBeInTheDocument();
  });

  it('room.phase가 아직 \'racing\'에 고정돼도 raceFinishedReason이 도착해 있으면 RaceResult로 전환한다(이중 안전망)', () => {
    renderRoom();
    act(() => {
      // 서버가 room-state(phase=FINISHED)를 유실한 상황을 재현 — room.phase는 'racing' 그대로.
      useMultiplayerStore.getState().setRoom({ ...BASE_ROOM, phase: 'racing' });
      useMultiplayerStore.getState().setRaceFinishedReason('all-finished');
      useMultiplayerStore.getState().setRaceResult(RACE_RESULT);
    });
    expect(screen.getByTestId('race-result')).toBeInTheDocument();
  });

  it('raceFinishedReason만 있고 raceResult가 아직 없으면 RaceResult를 렌더하지 않는다(둘 다 필요)', () => {
    renderRoom();
    act(() => {
      useMultiplayerStore.getState().setRoom({ ...BASE_ROOM, phase: 'racing' });
      useMultiplayerStore.getState().setRaceFinishedReason('all-finished');
    });
    expect(screen.queryByTestId('race-result')).not.toBeInTheDocument();
  });

  it('raceFinishedReason과 raceResult 둘 다 없고 phase도 result가 아니면 RaceResult를 렌더하지 않는다', () => {
    renderRoom();
    act(() => {
      useMultiplayerStore.getState().setRoom({ ...BASE_ROOM, phase: 'waiting' });
    });
    expect(screen.queryByTestId('race-result')).not.toBeInTheDocument();
  });
});
