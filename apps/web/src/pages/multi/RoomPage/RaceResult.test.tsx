// @vitest-environment jsdom
//
// spec: docs/03 §6.6(서버 권위 원칙 — 순위·시간·CPM/ACC/PI는 results가 유일한 진실), docs/01
//       §8.2(리매치 투표), WT-M4-04
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { S2C_Results } from '@wt/shared';
import { AppProviders } from '../../../app/providers';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { RaceResult } from './RaceResult';

function fakeMp(overrides: Partial<ReturnType<typeof useMultiplayer>> = {}): ReturnType<typeof useMultiplayer> {
  return {
    quickMatch: vi.fn(),
    createRoom: vi.fn(),
    join: vi.fn(),
    joinRoom: vi.fn(),
    connectWithGrant: vi.fn(),
    ready: vi.fn(),
    startRace: vi.fn(),
    chat: vi.fn(),
    rematch: vi.fn(),
    botAccept: vi.fn(),
    leave: vi.fn(),
    attachRace: vi.fn(),
    getOffsetMs: vi.fn(() => 0),
    ...overrides,
  } as unknown as ReturnType<typeof useMultiplayer>;
}

const raceResult: S2C_Results = {
  v: 1,
  type: 'results',
  raceId: 'r1',
  rows: [
    { playerId: 'p1', nickname: 'Alice', isBot: false, rank: 1, finished: true, countriesCleared: 15, elapsedMs: 65000, cpm: 420, acc: 97.5, pi: 410, disconnected: false },
    { playerId: 'p2', nickname: 'Bob', isBot: false, rank: 2, finished: false, countriesCleared: 9, elapsedMs: null, cpm: 300, acc: 90.1, pi: 250, disconnected: false },
  ],
  rematchDeadline: Date.now() + 30_000,
};

describe('RaceResult (WT-M4-04)', () => {
  afterEach(() => cleanup());

  it('서버 results 값만으로 순위표를 렌더하고 내 행을 표시한다(§6.6)', () => {
    const mp = fakeMp();
    render(
      <AppProviders>
        <RaceResult raceResult={raceResult} rematchState={null} myPlayerId="p1" latencyMs={42} mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    expect(screen.getByTestId('race-result-row-p1')).toHaveClass('wt-race-result__row--me');
    expect(screen.getByTestId('race-result-row-p2')).toBeInTheDocument();
    expect(screen.getByText(/65\.0s/)).toBeInTheDocument();
  });

  it('리매치 투표 버튼이 mp.rematch를 호출한다', () => {
    const mp = fakeMp();
    render(
      <AppProviders>
        <RaceResult raceResult={raceResult} rematchState={null} myPlayerId="p1" latencyMs={42} mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId('race-result-vote-yes'));
    expect(mp.rematch).toHaveBeenCalledWith(true);
  });

  it('나가기 버튼이 onLeave를 호출한다(mp.leave 직접 호출 아님 — 라우팅은 RoomPage 소관)', () => {
    const mp = fakeMp();
    const onLeave = vi.fn();
    render(
      <AppProviders>
        <RaceResult raceResult={raceResult} rematchState={null} myPlayerId="p1" latencyMs={42} mp={mp} onLeave={onLeave} />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId('race-result-leave'));
    expect(onLeave).toHaveBeenCalled();
    expect(mp.leave).not.toHaveBeenCalled();
  });
});
