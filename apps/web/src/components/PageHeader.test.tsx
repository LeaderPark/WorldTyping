// @vitest-environment jsdom
//
// spec: docs/00 §11-D74(페이지 크롬 통일 — 헤더), docs/03 §7.3(useRouteFocus 첫 h1), 설계 §2 결정 2·4.
// 스모크: 브랜드 + 기본 액션(AuthChip 로그인 버튼 + 테마 토글) + back href/testid/라벨 + h1 tabIndex.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { useAuthStore } from '../stores/auth';
import { useSettingsStore } from '../stores/settings';
import { PageHeader, type PageHeaderProps } from './PageHeader';

function renderHeader(props: PageHeaderProps = {}) {
  return render(
    <AppProviders>
      <MemoryRouter>
        <PageHeader {...props} />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('PageHeader (D74)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => cleanup());

  it('1행 bar에 브랜드 링크와 기본 액션(로그인 버튼 + 테마 토글)을 렌더한다', () => {
    renderHeader();
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    // 브랜드는 하위 페이지용 홈 링크(<a href="/">).
    expect(screen.getByTestId('brand-mark')).toHaveAttribute('href', '/');
    // actions 기본값 = AuthChip(비로그인 → topbar-login) + ThemeToggle.
    expect(screen.getByTestId('topbar-login')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('actions prop이 기본 액션을 대체한다', () => {
    renderHeader({ actions: <span data-testid="custom-action">x</span> });
    expect(screen.getByTestId('custom-action')).toBeInTheDocument();
    expect(screen.queryByTestId('topbar-login')).not.toBeInTheDocument();
  });

  it('back이 있으면 .wt-nav-back 링크를 지정 testId·href·라벨로 렌더한다', () => {
    renderHeader({ back: { to: '/play', labelKey: 'nav.back.mode', testId: 'sample-back' } });
    const back = screen.getByTestId('sample-back');
    expect(back).toHaveAttribute('href', '/play');
    expect(back).toHaveClass('wt-nav-back');
    expect(back.textContent).not.toBe('');
  });

  it('title이 있으면 h1(tabIndex=-1 — useRouteFocus 첫 h1 계약)을 렌더한다', () => {
    renderHeader({ title: 'My Rankings', back: { to: '/', labelKey: 'nav.back.home', testId: 'x-back' } });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('My Rankings');
    expect(h1).toHaveAttribute('tabindex', '-1');
    expect(h1).toHaveClass('wt-page-header__title');
  });

  it('back/title이 모두 없으면 2행 nav를 렌더하지 않는다(h1 없음)', () => {
    renderHeader();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});
