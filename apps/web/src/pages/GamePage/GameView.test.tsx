// @vitest-environment jsdom
//
// spec: docs/03 §4.2(GameView 3밴드 트리)·§4.5, WT-UI-03. GameView가 상단 앱바·부유 대시보드·하단
// 보딩패스 스트립을 조립하고 기존 testid(game-view/hud-bar/hud-lives/hud-cpm/hud-acc/hud-timer/
// combo-badge/progress-count/prompt-mount/game-country-announce)를 보존하는지, race variant에서
// tracksSlot·하드캡 슬롯을 얹는지 검증한다. RaceOverlay/GameViewProps 계약은 typecheck가 지킨다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import type { Country } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { GameView, type GameViewProps } from './GameView';

function mk(id: string, nameKo: string, nameEn: string, continent: Country['continent']): Country {
  return {
    id, iso3: `${id}X`, nameKo, nameEn, aliasesKo: [], aliasesEn: [], continent,
    subregion: '', difficultyTier: 2, capitalKo: '', capitalEn: '', flagEmoji: '🏳️',
    population: 0, latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: [nameKo], acceptedInputsEn: [nameEn.toLowerCase()],
  };
}

const COUNTRIES: Country[] = [
  mk('CO', '콜롬비아', 'colombia', 'south-america'),
  mk('VE', '베네수엘라', 'venezuela', 'south-america'),
  mk('BR', '브라질', 'brazil', 'south-america'),
];

function makeStubEngine() {
  const listeners = new Set<(e: EngineEvent) => void>();
  return {
    subscribe: (fn: (e: EngineEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => ({ combo: 0, phase: 'playing', currentIndex: 0 }),
  } as unknown as GameSessionEngine;
}

function baseProps(overrides: Partial<GameViewProps> = {}): GameViewProps {
  return {
    engine: makeStubEngine(),
    controller: null,
    getInputValue: () => '',
    lang: 'ko',
    mode: 'continent',
    countries: COUNTRIES,
    countryIds: COUNTRIES.map((c) => c.id),
    currentIndex: 0,
    lives: null,
    bindTimerEl: vi.fn(),
    bindGaugeEl: vi.fn(),
    juice: true,
    ...overrides,
  };
}

function renderView(props: GameViewProps) {
  return render(
    <AppProviders>
      <MemoryRouter>
        <GameView {...props} />
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => cleanup());

describe('GameView — WT-UI-03 3밴드 조립', () => {
  it('싱글: 앱바·대시보드·스트립 3밴드와 핵심 testid를 렌더한다', () => {
    renderView(baseProps());
    const view = screen.getByTestId('game-view');
    expect(view.getAttribute('data-variant')).toBe('single');
    // 상단 앱바
    expect(screen.getByTestId('hud-bar')).toBeInTheDocument();
    expect(screen.getByTestId('progress-count').textContent).toBe('1 / 3');
    expect(screen.getByTestId('hud-acc')).toBeInTheDocument();
    // 부유 대시보드
    expect(screen.getByTestId('dashboard-card')).toBeInTheDocument();
    expect(screen.getByTestId('hud-cpm')).toBeInTheDocument();
    expect(screen.getByTestId('hud-timer')).toBeInTheDocument();
    // 하단 보딩패스 스트립(캡슐 = game-stamp-anchor + prompt-mount + combo)
    expect(screen.getByTestId('boarding-strip')).toBeInTheDocument();
    expect(screen.getByTestId('game-stamp-anchor')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-mount').textContent).toBe('콜롬비아');
    expect(screen.getByTestId('combo-badge')).toBeInTheDocument();
    // sr 낭독 영역
    expect(screen.getByTestId('game-country-announce')).toBeInTheDocument();
    // 싱글은 레이스 슬롯 없음
    expect(screen.queryByTestId('race-overlay-tracks')).toBeNull();
    expect(screen.queryByTestId('race-hardcap')).toBeNull();
  });

  it('스트립 배경은 현재 출제국 대륙색 CSS 변수로 설정된다', () => {
    renderView(baseProps());
    const strip = screen.getByTestId('boarding-strip');
    // south-america → --continent-south-america
    expect(strip.getAttribute('style') ?? '').toContain('--continent-south-america');
  });

  it('라이프 있는 모드(티어)는 hud-lives와 제한시간 게이지를 보여준다', () => {
    renderView(baseProps({ mode: 'tier', lives: 3 }));
    expect(screen.getByTestId('hud-lives').textContent).toBe('♥♥♥');
    expect(screen.getByTestId('time-limit-gauge')).toBeInTheDocument();
  });

  it('대륙 모드는 라이프·게이지를 숨긴다', () => {
    renderView(baseProps({ mode: 'continent', lives: null }));
    expect(screen.queryByTestId('hud-lives')).toBeNull();
    expect(screen.queryByTestId('time-limit-gauge')).toBeNull();
  });

  it('레이스 variant: tracksSlot·하드캡 슬롯을 얹고 data-variant=race', () => {
    const bindHardCapEl = vi.fn();
    renderView(
      baseProps({
        mode: 'race',
        race: {
          tracksSlot: <div data-testid="test-tracks" />,
          bindHardCapEl,
          ackIndex: 1,
        },
      }),
    );
    expect(screen.getByTestId('game-view').getAttribute('data-variant')).toBe('race');
    expect(screen.getByTestId('race-overlay-tracks')).toBeInTheDocument();
    expect(screen.getByTestId('test-tracks')).toBeInTheDocument();
    expect(screen.getByTestId('race-hardcap')).toBeInTheDocument();
    expect(screen.getByTestId('race-hardcap-time')).toBeInTheDocument();
    expect(bindHardCapEl).toHaveBeenCalled();
  });
});
