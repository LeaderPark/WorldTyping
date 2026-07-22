// @vitest-environment jsdom
//
// spec: docs/06 §6.5(11항 아웃라인 + ko/en 병기), WT-M6-01 [완료 조건] "privacy 페이지가 ko/en
// 병기로 렌더, 11항 전부 존재".
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/providers';
import { PrivacyPage } from './index';

afterEach(() => cleanup());

function renderPage() {
  return render(
    <AppProviders>
      <PrivacyPage />
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

  it('renders both the Korean and English bodies side by side (§6.5 "ko/en 병기")', () => {
    renderPage();
    expect(screen.getByTestId('privacy-body-ko')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-en')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-ko').textContent).toContain('개인정보처리방침');
    expect(screen.getByTestId('privacy-body-en').textContent).toContain('Privacy Policy');
  });

  it('contains all 11 outline sections in Korean and English, as actual headings (§6.5 numbering)', () => {
    renderPage();
    const koHeadings = within(screen.getByTestId('privacy-body-ko'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    const enHeadings = within(screen.getByTestId('privacy-body-en'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    for (let n = 1; n <= 11; n += 1) {
      const prefix = `${n}. `;
      expect(koHeadings.some((h) => h.startsWith(prefix)), `ko section ${n} heading missing (got: ${JSON.stringify(koHeadings)})`).toBe(true);
      expect(enHeadings.some((h) => h.startsWith(prefix)), `en section ${n} heading missing (got: ${JSON.stringify(enHeadings)})`).toBe(true);
    }
    // 계정/이메일/실명 미수집 원칙이 실문안에 선명하게 등장하는지(§6.5 항목 2 지시).
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('수집하지 않습니다');
    expect(en).toContain('never collect');
  });

  it('leaves the operator/contact placeholders for the lead to fill in (§3 세션 조정 지시)', () => {
    renderPage();
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('{PLACEHOLDER');
    expect(en).toContain('{PLACEHOLDER');
  });

  it('renders the addendum version-history table (§6.5 "부칙: 변경 이력 표")', () => {
    renderPage();
    expect(screen.getByTestId('privacy-body-ko').textContent).toContain('v1.0');
    // 보유기간(§4)·변경이력(부칙) 두 개씩(ko/en) — 파이프 테이블이 실제로 <table>로 렌더되는지만 확인.
    expect(within(screen.getByTestId('privacy-body-ko')).getAllByRole('table').length).toBeGreaterThanOrEqual(2);
    expect(within(screen.getByTestId('privacy-body-en')).getAllByRole('table').length).toBeGreaterThanOrEqual(2);
  });

  it('renders the credits section with notice.disputed and ODbL/Natural Earth/flag-icons notices', () => {
    renderPage();
    const credits = screen.getByTestId('privacy-credits');
    expect(credits.textContent).toContain('ODbL');
    expect(credits.textContent).toContain('Natural Earth');
    expect(credits.textContent).toContain('flag-icons');
    expect(credits.textContent).toMatch(/정치적 입장을 나타내지 않습니다|do not reflect any political position/);
  });

  it('describes the self-service export/delete rights in both languages (§6.3)', () => {
    renderPage();
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('내 데이터 내려받기');
    expect(ko).toContain('데이터 초기화 및 삭제');
    expect(en).toContain('Download my data');
    expect(en).toContain('Reset and delete my data');
  });
});
