// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨, §11-D72(footer 제자리 모달 + 단일 언어), footer-ref.png, WT-AUTH-06, WT-LGL-01
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { useSettingsStore } from '../stores/settings';
import { SiteFooter } from './SiteFooter';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().setLang('ko');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderFooter() {
  return render(
    <AppProviders>
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('SiteFooter (§11-D72)', () => {
  it('renders the three legal triggers as buttons (no route navigation — href 없음)', () => {
    renderFooter();
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
    for (const id of ['footer-link-privacy', 'footer-link-terms', 'footer-link-support']) {
      const el = screen.getByTestId(id);
      expect(el.tagName).toBe('BUTTON');
      expect(el).not.toHaveAttribute('href');
    }
  });

  it('renders a copyright line with the current year and TypeTrip', () => {
    renderFooter();
    const year = String(new Date().getFullYear());
    const copyright = screen.getByTestId('site-footer').textContent ?? '';
    expect(copyright).toContain(year);
    expect(copyright).toContain('TypeTrip');
  });

  it('개인정보 버튼 클릭 → 제자리 모달(legal-modal) + 활성 언어(ko) 본문 렌더', () => {
    renderFooter();
    expect(screen.queryByTestId('legal-modal')).not.toBeInTheDocument();

    act(() => screen.getByTestId('footer-link-privacy').click());

    expect(screen.getByTestId('legal-modal')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-ko')).toBeInTheDocument();
    expect(screen.queryByTestId('privacy-body-en')).not.toBeInTheDocument();
    // privacy 모달은 크레딧 고지 + 데이터 열람/삭제 셀프서비스를 포함(§11-D72·D68-⑥).
    expect(screen.getByTestId('privacy-credits')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-my-data')).toBeInTheDocument();
  });

  it('닫기 버튼 클릭 → 모달 언마운트 + 포커스가 트리거(footer 버튼)로 복귀', async () => {
    renderFooter();
    const trigger = screen.getByTestId('footer-link-privacy');
    act(() => trigger.focus());
    act(() => trigger.click());

    // useModalA11y가 초기 포커스를 닫기 버튼으로 이동.
    const close = screen.getByTestId('legal-modal-close');
    await waitFor(() => expect(close).toHaveFocus());

    act(() => close.click());
    await waitFor(() => expect(screen.queryByTestId('legal-modal')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('ESC로 닫힌다', async () => {
    renderFooter();
    act(() => screen.getByTestId('footer-link-terms').click());
    expect(screen.getByTestId('legal-modal')).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('legal-modal')).not.toBeInTheDocument());
  });

  it('스크림 바깥 클릭(스크림 자기-클릭)으로 닫힌다', async () => {
    renderFooter();
    act(() => screen.getByTestId('footer-link-support').click());
    const scrim = screen.getByTestId('legal-modal');
    expect(scrim).toBeInTheDocument();

    // 스크림 요소 자신을 클릭(e.target === e.currentTarget) → 닫힘.
    act(() => {
      fireEvent.click(scrim);
    });
    await waitFor(() => expect(screen.queryByTestId('legal-modal')).not.toBeInTheDocument());
  });
});
