// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S1 홈 와이어프레임), §11.1(1단계 — 싱글플레이 카드 펄스), WT-M2-07
//
// bootLoader를 일부러 목킹하지 않는다 — HeroMap(useWorldGeoIndex)이 부팅 데이터 없이도 안전하게
// placeholder로 폴백하는지(app/router.test.tsx의 "로더 없이 홈을 렌더" 전제와 동일 계약)를 이
// 파일 자체가 실증한다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { HomePage } from './index';

function renderHome() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <HomePage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('HomePage (S1)', () => {
  beforeEach(() => {
    localStorage.setItem('wt:lang', 'ko'); // 언어 게이트가 다른 어서션을 가리지 않게.
    useMetaStore.getState().reset();
    useSettingsStore.getState().setLang('ko');
  });
  afterEach(() => cleanup());

  it('부팅 데이터 없이도 히어로 지도가 placeholder로 안전하게 렌더된다(throw 없음)', () => {
    renderHome();
    expect(screen.getByTestId('hero-map')).toBeInTheDocument();
    expect(screen.getByTestId('hero-map-loading')).toBeInTheDocument();
  });

  it('싱글/멀티/데일리 3개 카드와 랭킹/여권/설정 내비를 렌더한다', () => {
    renderHome();
    expect(screen.getByTestId('home-card-single')).toHaveAttribute('href', '/play');
    expect(screen.getByTestId('home-card-multi')).toHaveAttribute('href', '/multi');
    expect(screen.getByTestId('home-card-daily').getAttribute('href')).toMatch(/^\/play\/daily\//);
    expect(screen.getByTestId('home-nav-rank')).toHaveAttribute('href', '/rank');
    expect(screen.getByTestId('home-nav-passport')).toHaveAttribute('href', '/passport');
    expect(screen.getByTestId('home-daily-badge').getAttribute('href')).toMatch(/^\/play\/daily\//);
  });

  it('완주 기록이 하나도 없으면 싱글플레이 카드가 펄스된다(§11.1 1단계)', () => {
    renderHome();
    expect(screen.getByTestId('home-card-single').className).toContain('wt-mode-card--pulse');
  });

  it('완주 기록이 있으면 펄스가 사라진다', () => {
    useMetaStore.getState().addStamp('continent:asia');
    renderHome();
    expect(screen.getByTestId('home-card-single').className).not.toContain('wt-mode-card--pulse');
  });

  it('언어 토글 버튼이 lang을 뒤집는다', () => {
    renderHome();
    const toggle = screen.getByTestId('home-lang-toggle');
    toggle.click();
    expect(useSettingsStore.getState().lang).toBe('en');
  });

  it('bestPI가 없으면 티커를 렌더하지 않고, 있으면 표시한다', () => {
    const { unmount } = renderHome();
    expect(screen.queryByTestId('home-ticker')).not.toBeInTheDocument();
    unmount();

    useMetaStore.getState().setBestPI(388);
    renderHome();
    expect(screen.getByTestId('home-ticker').textContent).toContain('388');
  });
});
