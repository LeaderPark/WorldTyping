// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-⑥/⑧ + WT-AUTH-03(TopBar: 뒤로·브랜드·[로그인|프로필]·테마).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { useAuthStore } from '../stores/auth';
import { useSettingsStore } from '../stores/settings';
import { TopBar, type TopBarProps } from './TopBar';

function renderTopBar(props: TopBarProps = {}) {
  return render(
    <AppProviders>
      <MemoryRouter>
        <TopBar {...props} />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('TopBar (WT-AUTH-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setLang('en');
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => cleanup());

  it('브랜드·로그인 버튼·테마 토글을 렌더한다(비로그인, 뒤로 버튼 기본 미노출)', () => {
    renderTopBar();
    expect(screen.getByTestId('topbar')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-login')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('topbar-back')).not.toBeInTheDocument();
  });

  it('back=true면 뒤로 버튼을 렌더한다', () => {
    renderTopBar({ back: true });
    expect(screen.getByTestId('topbar-back')).toBeInTheDocument();
  });

  it('title prop이 브랜드 자리를 대체한다', () => {
    renderTopBar({ title: 'Lobby' });
    expect(screen.getByTestId('topbar')).toHaveTextContent('Lobby');
  });
});
