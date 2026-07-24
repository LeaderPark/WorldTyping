// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨(/support — FAQ[로그인·랭킹기준·데이터열람삭제→/privacy·신고] + 문의처,
//       법률 자문 아님 고지), §11-D72(단일 언어 렌더 — ko/en 병기 폐기), WT-AUTH-06 → WT-LGL-01.
//       본문은 settings.lang 단일 언어만 렌더하므로 언어별 단언은 스토어 전환 후 각각 수행한다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { SupportPage } from './index';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPage(lang: 'ko' | 'en' = 'ko') {
  useSettingsStore.getState().setLang(lang);
  return render(
    <AppProviders>
      <MemoryRouter>
        <SupportPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('SupportPage', () => {
  it('renders a single h1 (tabIndex=-1 for route-focus) with non-empty text', () => {
    renderPage();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.textContent).not.toBe('');
  });

  it('renders only the active-language body (§11-D72 단일 언어)', () => {
    renderPage('ko');
    expect(screen.getByTestId('support-body-ko').textContent).toContain('고객지원');
    expect(screen.queryByTestId('support-body-en')).not.toBeInTheDocument();

    cleanup();
    renderPage('en');
    expect(screen.getByTestId('support-body-en').textContent).toContain('Support');
    expect(screen.queryByTestId('support-body-ko')).not.toBeInTheDocument();
  });

  it('covers the required FAQ topics (login / ranking criteria / data access-delete / reporting) in each language', () => {
    renderPage('ko');
    const ko = screen.getByTestId('support-body-ko').textContent ?? '';
    expect(ko).toContain('로그인');
    expect(ko).toContain('랭킹');
    expect(ko).toContain('/privacy');
    expect(ko).toContain('신고');

    cleanup();
    renderPage('en');
    const en = screen.getByTestId('support-body-en').textContent ?? '';
    expect(en.toLowerCase()).toContain('sign in');
    expect(en.toLowerCase()).toContain('leaderboard');
    expect(en).toContain('/privacy');
    expect(en.toLowerCase()).toContain('report');
  });

  it('gives the fixed contact email in each language', () => {
    renderPage('ko');
    expect(screen.getByTestId('support-body-ko').textContent).toContain('dkdleldjqkr976@gmail.com');
    cleanup();
    renderPage('en');
    expect(screen.getByTestId('support-body-en').textContent).toContain('dkdleldjqkr976@gmail.com');
  });

  it('carries the "standard draft, not legal advice" disclaimer in each language', () => {
    renderPage('ko');
    expect(screen.getByTestId('support-body-ko').textContent).toContain('법률 자문');
    cleanup();
    renderPage('en');
    expect((screen.getByTestId('support-body-en').textContent ?? '').toLowerCase()).toContain('legal advice');
  });

  it('links back home', () => {
    renderPage();
    expect(screen.getByTestId('support-back')).toHaveAttribute('href', '/');
  });
});
