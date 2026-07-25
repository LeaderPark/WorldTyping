// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S11), docs/03 §3.7·§4.2, docs/05 §7.2-4(관전), WT-RACE-GLOBE acceptance
// ("RaceView 지구본 마운트 스모크").
//
// RaceView가 (a) 레이스 진행 중(countdown/playing)과 (b) 관전 모드 양쪽에서 지구본 무대를
// 마운트하고, HUD를 그 위 레이어(.wt-race-stage/.wt-race-above)에 얹는지만 확인한다. 지구본
// 내부 동작은 RaceGlobe.test.tsx/globe-race.test.ts 몫이라 useGlobeIndex는 null로 목킹한다
// (GlobeMap 미마운트 — 컨테이너 배치만 검증).
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Country, S2C_Start } from '@wt/shared';
import { AppProviders } from '../../../app/providers';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { useMultiplayerStore, type RoomPlayer } from '../../../stores/multiplayer';
import { RaceView } from './RaceView';

function mkCountry(id: string): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo: id,
    nameEn: id,
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: 1,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '🏳️',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [id],
    acceptedInputsEn: [id.toLowerCase()],
  };
}

const COUNTRIES: Country[] = ['KR', 'JP', 'CN'].map(mkCountry);

vi.mock('../../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: COUNTRIES },
    config: {
      schemaVersion: 2,
      dataUrl: '/data/countries.json',
      mapUrl: '/data/countries-110m.json',
      grades: { S: 450, A: 340, B: 230, C: 120 },
      timeLimit: { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 },
      anticheat: { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 },
      featureFlags: {},
    },
    dataVersion: 'test',
  }),
}));

// 지구본 인덱스는 이 스모크의 관심사가 아니다(비동기 topology fetch 회피).
vi.mock('../../../features/map/globe/useGlobeIndex', () => ({
  useGlobeIndex: () => null,
}));

function player(id: string): RoomPlayer {
  return {
    playerId: id,
    nickname: id,
    passportCover: 'basic-green',
    bestPi: null,
    isHost: false,
    isBot: false,
    ready: true,
    connState: 'connected',
  };
}

function fakeMp(): ReturnType<typeof useMultiplayer> {
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
    attachRace: vi.fn(() => () => {}),
    // 서버 epoch → 로컬 performance 시계 오프셋(useRaceSession 계약).
    getOffsetMs: vi.fn(() => Date.now() - performance.now()),
  } as unknown as ReturnType<typeof useMultiplayer>;
}

function startMsg(): S2C_Start {
  return {
    v: 1,
    type: 'start',
    raceId: 'r1',
    seed: '0'.repeat(32),
    countries: COUNTRIES.map((c) => c.id),
    dataVersion: 'test',
    startAt: Date.now(),
    hardCapAt: Date.now() + 120_000,
    perCountryLimitMs: 10_000,
  };
}

beforeEach(() => {
  useMultiplayerStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('RaceView 지구본 무대 마운트(WT-RACE-GLOBE)', () => {
  it('카운트다운 진입 시 지구본 배경과 .wt-race-stage 레이어를 함께 마운트한다', () => {
    vi.useFakeTimers();
    const mp = fakeMp();
    render(
      <MemoryRouter>
        <AppProviders>
          <RaceView
            replay={startMsg()}
            players={[player('me'), player('o1')]}
            myPlayerId="me"
            lang="ko"
            mp={mp}
          />
        </AppProviders>
      </MemoryRouter>,
    );

    // idle(리빌) 단계에는 아직 무대가 없다.
    expect(screen.queryByTestId('race-globe')).toBeNull();

    // useRaceSession이 예약한 engine.start()가 발화 → countdown.
    act(() => {
      vi.advanceTimersByTime(50);
    });

    const globe = screen.getByTestId('race-globe');
    expect(globe).toBeInTheDocument();
    expect(globe.className).toBe('wt-race-globe');
    expect(globe.getAttribute('aria-hidden')).toBe('true');
    // HUD(GameView)는 지구본 위 레이어로 감싸 렌더된다.
    const stage = document.querySelector('.wt-race-stage');
    expect(stage).not.toBeNull();
    expect(stage!.querySelector('[data-testid="game-view"]')).not.toBeNull();
  });

  it('관전 모드에서도 지구본을 마운트하고 관전 패널을 위 레이어에 둔다', () => {
    const mp = fakeMp();
    render(
      <AppProviders>
        <RaceView
          replay={startMsg()}
          players={[player('me'), player('o1')]}
          myPlayerId="me"
          lang="ko"
          mp={mp}
          spectating
        />
      </AppProviders>,
    );

    expect(screen.getByTestId('race-globe')).toBeInTheDocument();
    expect(screen.getByTestId('race-spectator').className).toContain('wt-race-above');
  });
});
