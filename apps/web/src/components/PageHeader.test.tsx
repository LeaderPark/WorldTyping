// @vitest-environment jsdom
//
// spec: docs/00 §11-D74(페이지 크롬 통일 — 헤더)·D75(2행 nav 폐지 — 뒤로가기 제거·title은 sr-only
//       h1로 보존), docs/03 §7.3(useRouteFocus 첫 h1), 설계 §2 결정 2·4.
// 스모크: 브랜드 + 기본 액션(AuthChip 로그인 버튼 + 테마 토글) + title=sr-only h1(tabIndex) 유무.
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

describe('PageHeader (D74·D75)', () => {
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
    // 브랜드는 홈으로 가는 링크(<a href="/">, WT-TWEAK-BRAND-LINK — 전 페이지 공통).
    expect(screen.getByTestId('brand-home-link')).toHaveAttribute('href', '/');
    // actions 기본값 = AuthChip(비로그인 → topbar-login) + ThemeToggle.
    expect(screen.getByTestId('topbar-login')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('actions prop이 기본 액션을 대체한다', () => {
    renderHeader({ actions: <span data-testid="custom-action">x</span> });
    expect(screen.getByTestId('custom-action')).toBeInTheDocument();
    expect(screen.queryByTestId('topbar-login')).not.toBeInTheDocument();
  });

  it('[D75] 뒤로가기 링크(.wt-nav-back)는 렌더하지 않는다', () => {
    renderHeader({ title: 'My Rankings' });
    expect(document.querySelector('.wt-nav-back')).toBeNull();
  });

  it('title이 있으면 sr-only h1(tabIndex=-1 — useRouteFocus 첫 h1 계약)을 렌더한다', () => {
    renderHeader({ title: 'My Rankings' });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('My Rankings');
    expect(h1).toHaveAttribute('tabindex', '-1');
    // 시각적으로 감추되 DOM/a11y 트리에는 존재(sr-only) — router.test·axe 계약 보존.
    expect(h1).toHaveClass('sr-only');
  });

  it('title이 없으면 h1을 렌더하지 않는다', () => {
    renderHeader();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});
