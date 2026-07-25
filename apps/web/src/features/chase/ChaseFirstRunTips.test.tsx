// @vitest-environment jsdom
//
// spec: docs/09 §8.1(첫 플레이 온보딩)·§8.10(a11y), docs/00 §11-D96(연출 비블로킹)·D111 ①,
//       WT-CH-DEV-2 acceptance("온보딩 1회성(플래그)·비블로킹").
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { ChaseFirstRunTips } from './ChaseFirstRunTips';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().setReducedMotion('auto');
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderTips() {
  return render(
    <AppProviders>
      <ChaseFirstRunTips />
    </AppProviders>,
  );
}

describe('ChaseFirstRunTips — 첫 런 1회성(§11-D111 ①)', () => {
  it('팁 3개를 순차로 보여주고(콜아웃 → 수배 별 → 홈/레이더) 끝나면 사라진다', () => {
    renderTips();
    const anchorNow = (): string | null =>
      screen.queryByTestId('chase-first-run-tip')?.getAttribute('data-tip') ?? null;

    expect(anchorNow()).toBe('callouts');
    act(() => vi.advanceTimersByTime(2600));
    expect(anchorNow()).toBe('wanted');
    act(() => vi.advanceTimersByTime(2600));
    expect(anchorNow()).toBe('delivery');
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.queryByTestId('chase-first-run-tips')).not.toBeInTheDocument();
  });

  it('노출 즉시 localStorage 플래그를 남기고, 다음 마운트에서는 아무 것도 렌더하지 않는다', () => {
    const first = renderTips();
    expect(screen.getByTestId('chase-first-run-tips')).toBeInTheDocument();
    expect(localStorage.getItem('wt:chase:tipsSeen')).toBe('1');
    first.unmount();

    renderTips();
    expect(screen.queryByTestId('chase-first-run-tips')).not.toBeInTheDocument();
  });

  it('플래그가 이미 있으면(재방문) 첫 프레임부터 렌더하지 않는다', () => {
    localStorage.setItem('wt:chase:tipsSeen', '1');
    renderTips();
    expect(screen.queryByTestId('chase-first-run-tips')).not.toBeInTheDocument();
  });
});

describe('ChaseFirstRunTips — 비블로킹·a11y(D96·§8.10)', () => {
  it('모달이 아니다 — dialog role·aria-modal·포커스 탈취가 전혀 없다', () => {
    const before = document.activeElement;
    renderTips();
    const root = screen.getByTestId('chase-first-run-tips');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[aria-modal]')).toBeNull();
    expect(root.querySelector('button, input, a[href]')).toBeNull(); // 포커스 가능 요소 0
    expect(document.activeElement).toBe(before); // 포커스를 옮기지 않는다(입력 유지)
  });

  it('팁 텍스트를 aria-live=polite로 공지한다', () => {
    renderTips();
    const tip = screen.getByTestId('chase-first-run-tip');
    expect(tip).toHaveAttribute('aria-live', 'polite');
    expect((tip.textContent ?? '').trim().length).toBeGreaterThan(1);
  });
});

describe('ChaseFirstRunTips — reduced-motion(§7 강등표)', () => {
  it('reducedMotion 설정 시 정적 표시 신호(data-static)를 켠다', () => {
    act(() => useSettingsStore.getState().setReducedMotion(true));
    renderTips();
    expect(screen.getByTestId('chase-first-run-tips')).toHaveAttribute('data-static', 'true');
  });

  it('기본(auto·비-reduce)에서는 data-static을 붙이지 않는다', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    renderTips();
    expect(screen.getByTestId('chase-first-run-tips')).not.toHaveAttribute('data-static');
  });
});
