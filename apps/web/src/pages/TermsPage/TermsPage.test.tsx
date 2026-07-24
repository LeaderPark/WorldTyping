// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨(/terms — 표준 초안 9항, 법률 자문 아님 고지), §11-D76(운영 주체 실명
//       박진우 — LeaderPark 표기 폐기), §11-D72(단일 언어 렌더 — ko/en 병기 폐기), WT-AUTH-06 →
//       WT-LGL-01 → WT-LGL-02. 본문은 settings.lang 단일 언어만 렌더하므로 언어별 단언은 스토어
//       전환 후 각각 수행한다.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { TermsPage } from './index';

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

  it('renders only the active-language body (§11-D72 단일 언어)', () => {
    renderPage('ko');
    expect(screen.getByTestId('terms-body-ko').textContent).toContain('이용약관');
    expect(screen.queryByTestId('terms-body-en')).not.toBeInTheDocument();

    cleanup();
    renderPage('en');
    expect(screen.getByTestId('terms-body-en').textContent).toContain('Terms of Service');
    expect(screen.queryByTestId('terms-body-ko')).not.toBeInTheDocument();
  });

  it('contains the 9 required sections (목적/서비스/계정/의무/제재/지재권/변경중단/면책/준거법) in each language', () => {
    for (const lang of ['ko', 'en'] as const) {
      renderPage(lang);
      const headings = within(screen.getByTestId(`terms-body-${lang}`))
        .getAllByRole('heading')
        .map((h) => h.textContent ?? '');
      for (let n = 1; n <= 9; n += 1) {
        const prefix = `${n}. `;
        expect(headings.some((h) => h.startsWith(prefix)), `${lang} section ${n} missing (${JSON.stringify(headings)})`).toBe(true);
      }
      cleanup();
    }
  });

  it('names the operator (박진우) and fixed contact email, and references /credits for licenses', () => {
    for (const lang of ['ko', 'en'] as const) {
      renderPage(lang);
      const body = screen.getByTestId(`terms-body-${lang}`).textContent ?? '';
      expect(body).toContain('박진우');
      expect(body).not.toContain('LeaderPark');
      expect(body).toContain('dkdleldjqkr976@gmail.com');
      expect(body).toContain('/credits');
      expect(body).toContain('/privacy');
      cleanup();
    }
  });

  it('carries the "standard draft, not legal advice" disclaimer in each language', () => {
    renderPage('ko');
    expect(screen.getByTestId('terms-body-ko').textContent).toContain('법률 자문');
    cleanup();
    renderPage('en');
    expect((screen.getByTestId('terms-body-en').textContent ?? '').toLowerCase()).toContain('legal advice');
  });

  it('states Korean law as the governing law (준거법 대한민국)', () => {
    renderPage('ko');
    expect(screen.getByTestId('terms-body-ko').textContent).toContain('대한민국');
    cleanup();
    renderPage('en');
    expect(screen.getByTestId('terms-body-en').textContent).toContain('Republic of Korea');
  });
});
