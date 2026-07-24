// @vitest-environment jsdom
//
// spec: docs/00 §11-D74(좌상단 브랜드), 설계 §2 결정 3. link/span 분기 + testid + app.title 재사용.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { useSettingsStore } from '../stores/settings';
import { BrandMark } from './BrandMark';

function renderMark(props: { linkToHome?: boolean } = {}) {
  return render(
    <AppProviders>
      <MemoryRouter>
        <BrandMark {...props} />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('BrandMark (D74)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setLang('en');
  });
  afterEach(() => cleanup());

  it('기본(linkToHome)은 홈으로 가는 <a> 링크로 렌더한다', () => {
    renderMark();
    const mark = screen.getByTestId('brand-mark');
    expect(mark.tagName).toBe('A');
    expect(mark).toHaveAttribute('href', '/');
    // ✈ 글리프 + app.title 워드마크(신규 키 0 — app.title 재사용).
    expect(mark.textContent).toContain('✈');
    expect(mark.textContent).toContain('TypeTrip');
  });

  it('linkToHome={false}(홈)는 비링크 <span>으로 렌더한다', () => {
    renderMark({ linkToHome: false });
    const mark = screen.getByTestId('brand-mark');
    expect(mark.tagName).toBe('SPAN');
    expect(mark).not.toHaveAttribute('href');
  });
});
