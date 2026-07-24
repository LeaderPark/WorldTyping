// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨(/support 신설 — FAQ[로그인·랭킹기준·데이터열람삭제→/privacy·신고] +
//       문의처, 법률 자문 아님 고지), WT-AUTH-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { SupportPage } from './index';

afterEach(() => cleanup());

function renderPage() {
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

  it('renders both the Korean and English bodies (ko/en 병기)', () => {
    renderPage();
    expect(screen.getByTestId('support-body-ko').textContent).toContain('고객지원');
    expect(screen.getByTestId('support-body-en').textContent).toContain('Support');
  });

  it('covers the required FAQ topics (login / ranking criteria / data access-delete / reporting) in both languages', () => {
    renderPage();
    const ko = screen.getByTestId('support-body-ko').textContent ?? '';
    const en = screen.getByTestId('support-body-en').textContent ?? '';
    expect(ko).toContain('로그인');
    expect(ko).toContain('랭킹');
    expect(ko).toContain('/privacy');
    expect(ko).toContain('신고');
    expect(en.toLowerCase()).toContain('sign in');
    expect(en.toLowerCase()).toContain('leaderboard');
    expect(en).toContain('/privacy');
    expect(en.toLowerCase()).toContain('report');
  });

  it('gives the fixed contact email in both languages', () => {
    renderPage();
    expect(screen.getByTestId('support-body-ko').textContent).toContain('dkdleldjqkr976@gmail.com');
    expect(screen.getByTestId('support-body-en').textContent).toContain('dkdleldjqkr976@gmail.com');
  });

  it('carries the "standard draft, not legal advice" disclaimer in both languages', () => {
    renderPage();
    const ko = screen.getByTestId('support-body-ko').textContent ?? '';
    const en = screen.getByTestId('support-body-en').textContent ?? '';
    expect(ko).toContain('법률 자문');
    expect(en.toLowerCase()).toContain('legal advice');
  });

  it('links back home', () => {
    renderPage();
    expect(screen.getByTestId('support-back')).toHaveAttribute('href', '/');
  });
});
