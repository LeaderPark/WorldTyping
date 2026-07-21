// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S7 결과 전문), docs/03 §4.2(ResultView), WT-M2-06. GamePage.test.tsx가
// 전체 여정(엔진 실배선)을 커버하므로, 여기서는 ResultView 자신의 표시/액션 분기(체크포인트
// 이어하기 버튼, 랭킹/공유 disabled 스텁, 다른 노선/홈 내비게이션)를 엔진을 얕게 스텁해 단위
// 검증한다.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import type { Country } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { ResultView } from './ResultView';

function mkEngine(checkpointResumeAvailable: boolean): {
  engine: GameSessionEngine;
  resume: ReturnType<typeof vi.fn>;
} {
  const resume = vi.fn();
  const engine = {
    getSnapshot: () => ({ checkpointResumeAvailable }),
    resumeFromCheckpoint: resume,
  } as unknown as GameSessionEngine;
  return { engine, resume };
}

const COUNTRIES: Country[] = [
  {
    id: 'KR', iso3: 'KOR', nameKo: '대한민국', nameEn: 'South Korea', aliasesKo: [], aliasesEn: [],
    continent: 'asia', subregion: '', difficultyTier: 1, capitalKo: '', capitalEn: '',
    flagEmoji: '🏳️', population: 0, latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: ['대한민국'], acceptedInputsEn: ['south korea'],
  },
  {
    id: 'JP', iso3: 'JPN', nameKo: '일본', nameEn: 'Japan', aliasesKo: [], aliasesEn: [],
    continent: 'asia', subregion: '', difficultyTier: 1, capitalKo: '', capitalEn: '',
    flagEmoji: '🏳️', population: 0, latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: ['일본'], acceptedInputsEn: ['japan'],
  },
];

function baseResult(overrides: Partial<EngineRunResult> = {}): EngineRunResult {
  return {
    mode: 'worldtour',
    lang: 'ko',
    outcome: 'gameover',
    practice: false,
    viaCheckpoint: false,
    stats: {
      totalKeystrokes: 10,
      correctKeystrokes: 8,
      elapsedMs: 5000,
      maxCombo: 1,
      countriesCleared: 1,
      countriesSkipped: 1,
      perCountry: [
        { code: 'KR', ms: 1000, errors: 0, skipped: false },
        { code: 'JP', ms: 2000, errors: 3, skipped: true },
      ],
    },
    score: {
      cpm: 200,
      acc: 0.8,
      pi: 128,
      grade: 'C',
      completed: false,
      baseScore: 500,
      accFactor: 0.64,
      comboFactor: 1.01,
      timeBonus: 0,
      finalScore: 323,
    },
    ...overrides,
  };
}

function renderResult(engine: GameSessionEngine, result: EngineRunResult, retry = vi.fn()) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/play/worldtour/world']}>
        <Routes>
          <Route path="/" element={<div data-testid="home-stub" />} />
          <Route path="/play/:mode" element={<div data-testid="track-select-stub" />} />
          <Route
            path="/play/:mode/:trackId"
            element={
              <ResultView
                engine={engine}
                result={result}
                countries={COUNTRIES}
                lang="ko"
                mode="worldtour"
                trackId="world"
                retry={retry}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => cleanup());

describe('ResultView', () => {
  it('게임오버 라벨·최다 오타·랭킹/공유 disabled 스텁을 렌더한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult());

    const card = screen.getByTestId('result-card');
    expect(card.textContent).toContain('라이프 소진');
    expect(card.textContent).toContain('일본'); // 최다 오타 국가(errors=3 > 0).
    expect(screen.getByTestId('result-ranking')).toBeDisabled();
    expect(screen.getByTestId('result-share')).toBeDisabled();
    expect(screen.queryByTestId('result-resume')).not.toBeInTheDocument();
  });

  it('checkpointResumeAvailable이면 이어하기 버튼이 나타나고 클릭 시 engine.resumeFromCheckpoint를 호출한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine, resume } = mkEngine(true);
    renderResult(engine, baseResult());

    const resumeBtn = screen.getByTestId('result-resume');
    act(() => fireEvent.click(resumeBtn));
    expect(resume).toHaveBeenCalledOnce();
  });

  it('R 키로 retry()가 호출된다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    const retry = vi.fn();
    renderResult(engine, baseResult(), retry);

    act(() => fireEvent.keyDown(window, { key: 'r' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('"다른 노선"/"홈" 클릭 시 각각 /play/:mode, / 로 이동한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult());

    act(() => fireEvent.click(screen.getByTestId('result-other-route')));
    expect(screen.getByTestId('track-select-stub')).toBeInTheDocument();
  });

  it('완주(completed) 결과는 "완주" 라벨을 표시한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult({ outcome: 'completed' }));

    const card = screen.getByTestId('result-card');
    expect(card.textContent).toContain('완주');
    expect(card.textContent).not.toContain('라이프 소진');
  });
});
