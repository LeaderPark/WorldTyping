// @vitest-environment jsdom
//
// spec: docs/01 §8.2(대기실 W — 슬롯/레디/채팅/호스트 시작), docs/00 §11-D23, WT-M4-04
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app/providers';
import { useMultiplayerStore, type RoomState } from '../../../stores/multiplayer';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { WaitingRoom } from './WaitingRoom';

function player(id: string, overrides: Partial<RoomState['players'][number]> = {}) {
  return {
    playerId: id,
    nickname: id,
    passportCover: 'basic-green',
    bestPi: null,
    isHost: false,
    isBot: false,
    ready: false,
    connState: 'connected' as const,
    ...overrides,
  };
}

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

describe('WaitingRoom (WT-M4-04)', () => {
  beforeEach(() => {
    useMultiplayerStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('참가자 슬롯 + 빈 슬롯 + 레디 토글 + 호스트 전용 시작 버튼을 렌더한다', () => {
    const room: RoomState = {
      code: 'AB12CD',
      hostId: 'host1',
      lang: 'ko',
      players: [player('host1', { isHost: true, ready: true }), player('me1')],
      phase: 'waiting',
      maxPlayers: 4,
      isPublic: false,
      autoStartAt: null,
    };
    const mp = fakeMp();

    render(
      <AppProviders>
        <WaitingRoom room={room} myPlayerId="me1" mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    expect(screen.getByTestId('waiting-slot-host1')).toBeInTheDocument();
    expect(screen.getByTestId('waiting-slot-me1')).toBeInTheDocument();
    // maxPlayers 4 - players 2 = 빈 슬롯 2개.
    expect(screen.getByTestId('waiting-slot-empty-0')).toBeInTheDocument();
    expect(screen.getByTestId('waiting-slot-empty-1')).toBeInTheDocument();
    // 나는 호스트가 아니므로 시작 버튼이 없다.
    expect(screen.queryByTestId('waiting-start-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('waiting-ready-toggle'));
    expect(mp.ready).toHaveBeenCalledWith(true);
  });

  it('호스트에게는 시작 버튼이 보이고 클릭 시 mp.startRace를 호출한다', () => {
    const room: RoomState = {
      code: 'AB12CD',
      hostId: 'me1',
      lang: 'ko',
      players: [player('me1', { isHost: true })],
      phase: 'waiting',
      maxPlayers: 8,
      isPublic: false,
      autoStartAt: null,
    };
    const mp = fakeMp();

    render(
      <AppProviders>
        <WaitingRoom room={room} myPlayerId="me1" mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId('waiting-start-btn'));
    expect(mp.startRace).toHaveBeenCalled();
  });

  it('채팅 전송 시 mp.chat을 호출하고 입력을 비운다', () => {
    const room: RoomState = {
      code: 'AB12CD',
      hostId: 'me1',
      lang: 'ko',
      players: [player('me1', { isHost: true })],
      phase: 'waiting',
      maxPlayers: 8,
      isPublic: false,
      autoStartAt: null,
    };
    const mp = fakeMp();

    render(
      <AppProviders>
        <WaitingRoom room={room} myPlayerId="me1" mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    const input = screen.getByTestId('waiting-chat-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ㄱㄱ' } });
    fireEvent.click(screen.getByTestId('waiting-chat-send'));
    expect(mp.chat).toHaveBeenCalledWith('ㄱㄱ');
    expect(input.value).toBe('');
  });

  it('bot-offer 스토어 상태가 있으면 BotOfferModal을 렌더하고 수락 시 mp.botAccept(true)를 호출한다', () => {
    useMultiplayerStore.getState().setBotOffer({ v: 1, type: 'bot-offer', expiresAt: Date.now() + 30_000 });
    const room: RoomState = {
      code: 'AB12CD',
      hostId: 'me1',
      lang: 'ko',
      players: [player('me1', { isHost: true })],
      phase: 'waiting',
      maxPlayers: 8,
      isPublic: false,
      autoStartAt: null,
    };
    const mp = fakeMp();

    render(
      <AppProviders>
        <WaitingRoom room={room} myPlayerId="me1" mp={mp} onLeave={vi.fn()} />
      </AppProviders>,
    );

    expect(screen.getByTestId('bot-offer-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bot-offer-accept'));
    expect(mp.botAccept).toHaveBeenCalledWith(true);
  });
});
