// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S4 노선/세부 선택 — "최고 S 2:58"·"미완주"·"미도전"·"출발→"), WT-M2-07
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { TrackSelectPage } from './index';

function renderAt(mode: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[`/play/${mode}`]}>
        <Routes>
          <Route path="/play" element={<div data-testid="mode-select-stub" />} />
          <Route path="/play/:mode" element={<TrackSelectPage />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('TrackSelectPage (S4 — 대륙/티어/일주 공용)', () => {
  beforeEach(() => {
    localStorage.clear();
    useMetaStore.getState().reset();
    useSettingsStore.getState().setLang('ko');
  });
  afterEach(() => cleanup());

  it('mode=continent: 6개 노선을 렌더하고 각각 /play/continent/:id로 링크한다', () => {
    renderAt('continent');
    expect(screen.getByTestId('track-item-continent-asia')).toHaveAttribute(
      'href',
      '/play/continent/asia',
    );
    expect(screen.getByTestId('track-item-continent-europe')).toHaveAttribute(
      'href',
      '/play/continent/europe',
    );
    // 미도전 노선은 "미도전"을 표시한다(§10.2 3분기).
    expect(screen.getByTestId('track-item-continent-asia').textContent).toContain('미도전');
  });

  it('완주 기록이 있는 노선은 "최고 {grade} {time}"을 표시한다', () => {
    useMetaStore.getState().recordRun({
      mode: 'continent', trackId: 'south-america', dateKST: '2026-07-21',
      pi: 512, grade: 'S', timeMs: 49_000, score: 60_000, completed: true,
    });
    renderAt('continent');
    const item = screen.getByTestId('track-item-continent-south-america');
    expect(item.textContent).toContain('S');
    expect(item.textContent).toContain('0:49');
  });

  it('시도했지만 완주하지 못한 노선은 "미완주"를 표시한다', () => {
    useMetaStore.getState().recordRun({
      mode: 'continent', trackId: 'africa', dateKST: '2026-07-21',
      pi: 100, grade: 'D', timeMs: 20_000, score: 500, completed: false,
    });
    renderAt('continent');
    expect(screen.getByTestId('track-item-continent-africa').textContent).toContain('미완주');
  });

  it('mode=tier: T1~T5 다섯 항목을 렌더한다', () => {
    renderAt('tier');
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`track-item-tier-${tier}`)).toHaveAttribute(
        'href',
        `/play/tier/${tier}`,
      );
    }
  });

  it('mode=worldtour: 단일 항목을 /play/worldtour/main으로 링크한다', () => {
    renderAt('worldtour');
    expect(screen.getByTestId('track-item-worldtour')).toHaveAttribute(
      'href',
      '/play/worldtour/main',
    );
  });

  it('mode=daily(이 화면이 다루지 않는 모드)는 /play로 되돌아간다', () => {
    renderAt('daily');
    expect(screen.getByTestId('mode-select-stub')).toBeInTheDocument();
  });
});
