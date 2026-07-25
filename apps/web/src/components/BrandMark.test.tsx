// @vitest-environment jsdom
//
// spec: docs/00 §11-D74(좌상단 브랜드), 설계 §2 결정 3, WT-TWEAK-BRAND-LINK(전 페이지 홈 링크화 —
// D74의 "홈=비링크 span" 조항을 대체). 링크 렌더 + href '/' + testid + app.title 재사용 단언.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { useSettingsStore } from '../stores/settings';
import { BrandMark } from './BrandMark';

function renderMark() {
  return render(
    <AppProviders>
      <MemoryRouter>
        <BrandMark />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('BrandMark (D74, WT-TWEAK-BRAND-LINK)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setLang('en');
  });
  afterEach(() => cleanup());

  it('홈으로 가는 <a> 링크로 렌더한다(홈 포함 전 페이지 — 클릭 시 무해한 같은 경로 네비)', () => {
    renderMark();
    const mark = screen.getByTestId('brand-home-link');
    expect(mark.tagName).toBe('A');
    expect(mark).toHaveAttribute('href', '/');
    // ✈ 글리프 + app.title 워드마크(신규 키 0 — app.title 재사용).
    expect(mark.textContent).toContain('✈');
    expect(mark.textContent).toContain('TypeTrip');
  });
});
