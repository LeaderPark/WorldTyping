// @vitest-environment jsdom
// spec: docs/03 §7.1(useLayoutMode — 뷰포트+visualViewport 합성), WT-M5-02
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLayoutMode } from './useLayoutMode';

function setInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop: number;

  constructor(height: number, offsetTop: number) {
    super();
    this.height = height;
    this.offsetTop = offsetTop;
  }

  set(height: number, offsetTop: number): void {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event('resize'));
  }
}

describe('useLayoutMode', () => {
  afterEach(() => {
    setInnerWidth(1024);
    delete (window as unknown as Record<string, unknown>).visualViewport;
    document.documentElement.style.removeProperty('--vv-height');
    document.documentElement.style.removeProperty('--vv-offset-top');
  });

  it('classifies mobile/tablet/desktop by width alone', () => {
    setInnerWidth(375);
    const mobile = renderHook(() => useLayoutMode());
    expect(mobile.result.current.mode).toBe('mobile');
    mobile.unmount();

    setInnerWidth(800);
    const tablet = renderHook(() => useLayoutMode());
    expect(tablet.result.current.mode).toBe('tablet');
    tablet.unmount();

    setInnerWidth(1440);
    const desktop = renderHook(() => useLayoutMode());
    expect(desktop.result.current.mode).toBe('desktop');
  });

  it('does not reclassify mode when only visualViewport height shrinks (soft keyboard)', () => {
    setInnerWidth(375);
    const vv = new FakeVisualViewport(700, 0);
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

    const { result } = renderHook(() => useLayoutMode());
    expect(result.current.mode).toBe('mobile');
    expect(result.current.vvHeight).toBe(700);

    // 소프트 키보드 등장 — 높이 절반, 폭은 불변.
    act(() => {
      vv.set(340, 0);
    });

    expect(result.current.mode).toBe('mobile'); // 오판 없음(§7.1)
    expect(result.current.vvHeight).toBe(340);
  });

  it('reflects visualViewport resize/scroll into --vv-height/--vv-offset-top CSS vars', () => {
    const vv = new FakeVisualViewport(600, 10);
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

    renderHook(() => useLayoutMode());
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('600px');
    expect(document.documentElement.style.getPropertyValue('--vv-offset-top')).toBe('10px');

    act(() => {
      vv.set(420, 180);
    });

    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('420px');
    expect(document.documentElement.style.getPropertyValue('--vv-offset-top')).toBe('180px');
  });

  it('falls back to innerHeight/0 when visualViewport is unavailable', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const { result } = renderHook(() => useLayoutMode());
    expect(result.current.vvHeight).toBe(900);
    expect(result.current.vvOffsetTop).toBe(0);
  });
});
