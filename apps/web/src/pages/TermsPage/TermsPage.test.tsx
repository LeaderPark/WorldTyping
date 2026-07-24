// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨(/terms 신설 — 표준 초안 9항, LeaderPark 명의, 법률 자문 아님 고지), WT-AUTH-06
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { TermsPage } from './index';

afterEach(() => cleanup());

function renderPage() {
  return render(
    <AppProviders>
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('TermsPage', () => {
  it('renders a single h1 (tabIndex=-1 for route-focus) with non-empty text', () => {
    renderPage();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.textContent).not.toBe('');
  });

  it('renders both the Korean and English bodies (ko/en 병기, same convention as PrivacyPage)', () => {
    renderPage();
    expect(screen.getByTestId('terms-body-ko').textContent).toContain('이용약관');
    expect(screen.getByTestId('terms-body-en').textContent).toContain('Terms of Service');
  });

  it('contains the 9 required sections (목적/서비스/계정/의무/제재/지재권/변경중단/면책/준거법) in both languages', () => {
    renderPage();
    const koHeadings = within(screen.getByTestId('terms-body-ko'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    const enHeadings = within(screen.getByTestId('terms-body-en'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    for (let n = 1; n <= 9; n += 1) {
      const prefix = `${n}. `;
      expect(koHeadings.some((h) => h.startsWith(prefix)), `ko section ${n} missing (${JSON.stringify(koHeadings)})`).toBe(true);
      expect(enHeadings.some((h) => h.startsWith(prefix)), `en section ${n} missing (${JSON.stringify(enHeadings)})`).toBe(true);
    }
  });

  it('names the operator (LeaderPark) and fixed contact email, and references /credits for licenses', () => {
    renderPage();
    const ko = screen.getByTestId('terms-body-ko').textContent ?? '';
    const en = screen.getByTestId('terms-body-en').textContent ?? '';
    for (const body of [ko, en]) {
      expect(body).toContain('LeaderPark');
      expect(body).toContain('dkdleldjqkr976@gmail.com');
      expect(body).toContain('/credits');
      expect(body).toContain('/privacy');
    }
  });

  it('carries the "standard draft, not legal advice" disclaimer in both languages', () => {
    renderPage();
    const ko = screen.getByTestId('terms-body-ko').textContent ?? '';
    const en = screen.getByTestId('terms-body-en').textContent ?? '';
    expect(ko).toContain('법률 자문');
    expect(en.toLowerCase()).toContain('legal advice');
  });

  it('states Korean law as the governing law (준거법 대한민국)', () => {
    renderPage();
    expect(screen.getByTestId('terms-body-ko').textContent).toContain('대한민국');
    expect(screen.getByTestId('terms-body-en').textContent).toContain('Republic of Korea');
  });

  it('links back home', () => {
    renderPage();
    expect(screen.getByTestId('terms-back')).toHaveAttribute('href', '/');
  });
});
