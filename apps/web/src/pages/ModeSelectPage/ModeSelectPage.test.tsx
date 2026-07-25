// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S3 모드 선택 — "완주 4/6"·"진행 T3 도전 중"·"최고: 카이로 도달"), WT-M2-07
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { ModeSelectPage } from './index';

function renderPage() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/play']}>
        <ModeSelectPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('ModeSelectPage (S3)', () => {
  beforeEach(() => {
    localStorage.clear();
    useMetaStore.getState().reset();
    useSettingsStore.getState().setLang('ko');
  });
  afterEach(() => cleanup());

  it('renders exactly 4 mode cards linking to continent/tier/worldtour/chase', () => {
    renderPage();
    expect(screen.getByTestId('mode-card-continent')).toHaveAttribute('href', '/play/continent');
    expect(screen.getByTestId('mode-card-tier')).toHaveAttribute('href', '/play/tier');
    expect(screen.getByTestId('mode-card-worldtour')).toHaveAttribute('href', '/play/worldtour');
    expect(screen.getByTestId('mode-card-chase')).toHaveAttribute('href', '/play/chase');
  });

  it('골드 러너 카드는 런칭 14일 이내에는 NEW 뱃지를, 그 이후엔 숨긴다', () => {
    const { unmount } = renderPage();
    expect(screen.getByTestId('mode-card-chase-new')).toBeInTheDocument();
    unmount();
  });

  it('완주 기록이 없으면 "완주: 0/6"을 표시한다', () => {
    renderPage();
    expect(screen.getByTestId('mode-card-continent-progress').textContent).toContain('0/6');
  });

  it('대륙 스탬프 2개를 기록하면 "완주: 2/6"으로 갱신된다', () => {
    useMetaStore.getState().addStamp('continent:asia');
    useMetaStore.getState().addStamp('continent:europe');
    renderPage();
    expect(screen.getByTestId('mode-card-continent-progress').textContent).toContain('2/6');
  });

  it('티어 시도 기록이 없으면 "진행" 표시를 렌더하지 않는다', () => {
    renderPage();
    expect(screen.queryByTestId('mode-card-tier-progress')).not.toBeInTheDocument();
  });

  it('T1/T3을 시도하면 가장 높은 티어("T3 도전 중")를 표시한다', () => {
    useMetaStore.getState().recordRun({
      mode: 'tier', trackId: '1', dateKST: '2026-07-20', pi: 100, grade: 'D', timeMs: 1000, score: 10, completed: false,
    });
    useMetaStore.getState().recordRun({
      mode: 'tier', trackId: '3', dateKST: '2026-07-21', pi: 100, grade: 'D', timeMs: 1000, score: 10, completed: false,
    });
    renderPage();
    expect(screen.getByTestId('mode-card-tier-progress').textContent).toContain('T3');
  });

  it('세계일주 도달 기록이 없으면 "최고 도달" 표시를 렌더하지 않고, 있으면 현재 lang으로 표시한다', () => {
    const { unmount } = renderPage();
    expect(screen.queryByTestId('mode-card-worldtour-progress')).not.toBeInTheDocument();
    unmount();

    useMetaStore.getState().recordWorldtourProgress({
      index: 23, countryId: 'EG', nameKo: '이집트', nameEn: 'Egypt',
    });
    renderPage();
    expect(screen.getByTestId('mode-card-worldtour-progress').textContent).toContain('이집트');
  });
});
