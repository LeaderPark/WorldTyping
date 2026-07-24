// @vitest-environment jsdom
//
// spec: docs/06 §6.5(11항 아웃라인), docs/00 §11-D72(단일 언어 렌더 — ko/en 병기 폐기), §11-D76(내
// 데이터 셀프서비스 UI 제거 — 데이터 권리는 이메일 채널, 운영 주체 실명 박진우), WT-M6-01 →
// WT-LGL-01 → WT-LGL-02. 본문은 settings.lang 단일 언어만 렌더하므로 언어별 단언은 스토어를 전환한
// 뒤 각각 수행한다(privacy-body-{lang} 중 활성 언어 1개만 DOM에 존재).
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { PrivacyPage } from './index';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderPage(lang: 'ko' | 'en' = 'ko') {
  useSettingsStore.getState().setLang(lang);
  return render(
    <AppProviders>
      {/* WT-M6-06: 크레딧 섹션이 <Link to="/credits">를 렌더하므로 Router 컨텍스트가 필요하다. */}
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('PrivacyPage', () => {
  it('renders an h1 (tabIndex=-1 for route-focus, docs/03 §7.3) with non-empty text', () => {
    renderPage();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.textContent).not.toBe('');
  });

  it('renders only the active-language body (§11-D72 단일 언어 — 병기 폐기)', () => {
    renderPage('ko');
    expect(screen.getByTestId('privacy-body-ko')).toBeInTheDocument();
    expect(screen.queryByTestId('privacy-body-en')).not.toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-ko').textContent).toContain('개인정보처리방침');

    cleanup();
    renderPage('en');
    expect(screen.getByTestId('privacy-body-en')).toBeInTheDocument();
    expect(screen.queryByTestId('privacy-body-ko')).not.toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-en').textContent).toContain('Privacy Policy');
  });

  it('contains all 11 outline sections in each language, as actual headings (§6.5 numbering)', () => {
    for (const lang of ['ko', 'en'] as const) {
      renderPage(lang);
      const headings = within(screen.getByTestId(`privacy-body-${lang}`))
        .getAllByRole('heading')
        .map((h) => h.textContent ?? '');
      for (let n = 1; n <= 11; n += 1) {
        const prefix = `${n}. `;
        expect(headings.some((h) => h.startsWith(prefix)), `${lang} section ${n} heading missing (got: ${JSON.stringify(headings)})`).toBe(true);
      }
      const body = screen.getByTestId(`privacy-body-${lang}`).textContent ?? '';
      // 계정/이메일/실명 미수집 원칙이 실문안에 선명하게 등장하는지(§6.5 항목 2 지시).
      expect(body).toContain(lang === 'ko' ? '수집하지 않습니다' : 'never collect');
      cleanup();
    }
  });

  it('resolves the operator/contact to the confirmed values instead of placeholders (00 §11-D76 — 실명 박진우)', () => {
    for (const lang of ['ko', 'en'] as const) {
      renderPage(lang);
      const body = screen.getByTestId(`privacy-body-${lang}`).textContent ?? '';
      expect(body).not.toContain('{PLACEHOLDER');
      expect(body).toContain('박진우');
      expect(body).not.toContain('LeaderPark');
      expect(body).toContain('dkdleldjqkr976@gmail.com');
      cleanup();
    }
  });

  it('discloses the Google sign-in collection items and Google LLC as a processing outsourcer (00 §11-D68-⑨)', () => {
    renderPage('ko');
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    expect(ko).toContain('Google LLC');
    expect(ko).toContain('sub');
    expect(ko).toContain('이메일');

    cleanup();
    renderPage('en');
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(en).toContain('Google LLC');
    expect(en).toContain('sub');
    expect(en.toLowerCase()).toContain('email');
  });

  it('normalizes the addendum to v1.0 in the terms format — no revision-history table (§11-D74)', () => {
    // [§11-D74/Tweak H] 2026-07-24 시행판 = v1.0 확정. v1.1 라벨·개정이력 표(v1.0 2026-07-22 포함)는
    // 폐기하고 부칙을 terms와 동일 포맷("시행일: 2026-07-24 (v1.0)")으로 통일한다.
    renderPage('ko');
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    expect(ko).toContain('v1.0');
    expect(ko).not.toContain('v1.1');
    expect(ko).not.toContain('2026-07-22');
    // 개정이력 표는 삭제되고 §4 보유기간 표 하나만 남는다.
    expect(within(screen.getByTestId('privacy-body-ko')).getAllByRole('table').length).toBe(1);

    cleanup();
    renderPage('en');
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(en).toContain('v1.0');
    expect(en).not.toContain('v1.1');
    expect(within(screen.getByTestId('privacy-body-en')).getAllByRole('table').length).toBe(1);
  });

  it('renders the credits section with notice.disputed and ODbL/Natural Earth/flag-icons notices', () => {
    renderPage();
    const credits = screen.getByTestId('privacy-credits');
    expect(credits.textContent).toContain('ODbL');
    expect(credits.textContent).toContain('Natural Earth');
    expect(credits.textContent).toContain('flag-icons');
    expect(credits.textContent).toMatch(/정치적 입장을 나타내지 않습니다|do not reflect any political position/);
  });

  it('links to the full /credits page (WT-M6-06)', () => {
    renderPage();
    expect(screen.getByTestId('privacy-credits-link')).toHaveAttribute('href', '/credits');
  });

  it('describes the email channel for data rights and drops the self-service copy (§11-D76)', () => {
    renderPage('ko');
    expect(screen.queryByTestId('privacy-my-data')).not.toBeInTheDocument();
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    expect(ko).toContain('dkdleldjqkr976@gmail.com');
    expect(ko).not.toContain('내 데이터 내려받기');
    expect(ko).not.toContain('데이터 초기화 및 삭제');

    cleanup();
    renderPage('en');
    expect(screen.queryByTestId('privacy-my-data')).not.toBeInTheDocument();
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(en).not.toContain('Download my data');
    expect(en).not.toContain('Reset and delete my data');
  });
});
