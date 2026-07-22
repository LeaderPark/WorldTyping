// @vitest-environment jsdom
//
// spec: docs/01 §9.3(고스트 모드 언락·자기 최고 기록 대결), WT-M5-04
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameSessionEngine } from '@wt/engine';
import { isGhostUnlocked, loadGhost, saveGhostIfBest, useGhostProgress } from './ghost';

const engine = {} as GameSessionEngine;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadGhost/saveGhostIfBest', () => {
  it('저장된 값이 없으면 null', () => {
    expect(loadGhost('continent', 'asia')).toBeNull();
  });

  it('점수가 이전 최고보다 높을 때만 갱신하고, 누적합을 저장한다', () => {
    saveGhostIfBest('continent', 'asia', 100, [1000, 500, 1500]);
    expect(loadGhost('continent', 'asia')).toEqual({ score: 100, cumulativeMs: [1000, 1500, 3000] });

    saveGhostIfBest('continent', 'asia', 50, [10, 10, 10]); // 더 낮은 점수 — 무시
    expect(loadGhost('continent', 'asia')?.score).toBe(100);

    saveGhostIfBest('continent', 'asia', 200, [2000]); // 더 높은 점수 — 갱신
    expect(loadGhost('continent', 'asia')).toEqual({ score: 200, cumulativeMs: [2000] });
  });

  it('트랙 키가 다르면 서로 간섭하지 않는다', () => {
    saveGhostIfBest('continent', 'asia', 100, [1000]);
    saveGhostIfBest('continent', 'europe', 100, [2000]);
    expect(loadGhost('continent', 'asia')?.cumulativeMs).toEqual([1000]);
    expect(loadGhost('continent', 'europe')?.cumulativeMs).toEqual([2000]);
  });

  it('손상된 JSON은 null로 방어한다', () => {
    localStorage.setItem('wt:ghost:continent:asia', '{"broken"');
    expect(loadGhost('continent', 'asia')).toBeNull();
  });
});

describe('isGhostUnlocked', () => {
  it('completed:true 항목이 하나라도 있으면 true', () => {
    expect(isGhostUnlocked({})).toBe(false);
    expect(isGhostUnlocked({ 'continent:asia': { completed: false } })).toBe(false);
    expect(isGhostUnlocked({ 'continent:asia': { completed: false }, 'tier:1': { completed: true } })).toBe(true);
  });
});

describe('useGhostProgress', () => {
  it('enabled=false/ghost=null이면 항상 null', () => {
    const { result } = renderHook(() => useGhostProgress({ engine, ghost: null, enabled: true }));
    expect(result.current).toBeNull();

    const { result: r2 } = renderHook(() =>
      useGhostProgress({ engine, ghost: { score: 1, cumulativeMs: [100] }, enabled: false }),
    );
    expect(r2.current).toBeNull();
  });

  it('누적 시각 경계마다 인덱스를 1씩 전진시킨다(폴링이 아니라 타이머 체인)', () => {
    vi.useFakeTimers();
    const ghost = { score: 1, cumulativeMs: [1000, 2500, 4000] };
    const { result } = renderHook(() => useGhostProgress({ engine, ghost, enabled: true }));

    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(2);
  });

  it('unmount 시 남은 타이머를 해제한다(누수 방지)', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const ghost = { score: 1, cumulativeMs: [1000, 2000] };
    const { unmount } = renderHook(() => useGhostProgress({ engine, ghost, enabled: true }));

    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(clearSpy).toHaveBeenCalled();
  });
});
