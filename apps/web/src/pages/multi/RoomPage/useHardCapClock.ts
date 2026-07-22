// spec: docs/01 §10.2(S11 "하드캡 ⏱ 1:12 남음"), docs/03 §4.5(고빈도 값은 rAF로 DOM 직접 갱신 —
//       React state 미경유. 같은 취지를 하드캡 카운트다운에도 적용), WT-M4-04
//
// useGameClock.ts(§4.4)와 동일한 bindXxxEl 패턴 — 하드캡 종료 시각까지 남은 시간을 rAF 루프에서
// textContent로 직접 쓴다.
import { useCallback, useEffect, useRef } from 'react';
import type { RefCallback } from 'react';
import { formatMMSS } from '../../../lib/format';

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function raf(cb: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => cb())
    : (setTimeout(cb, 16) as unknown as number);
}

function cancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

export interface UseHardCapClockResult {
  bindHardCapEl: RefCallback<HTMLElement>;
}

/** hardCapAt: 서버 epoch ms(null이면 미표시). getOffsetMs: 서버 epoch = 로컬 perf + offset. */
export function useHardCapClock(hardCapAt: number | null, getOffsetMs: () => number): UseHardCapClockResult {
  const elRef = useRef<HTMLElement | null>(null);
  const bindHardCapEl = useCallback<RefCallback<HTMLElement>>((el) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    if (hardCapAt === null) return;
    let rafId: number | null = null;
    const tick = (): void => {
      const el = elRef.current;
      if (el) {
        const localDeadline = hardCapAt - getOffsetMs();
        el.textContent = formatMMSS(Math.max(0, localDeadline - now()));
      }
      rafId = raf(tick);
    };
    rafId = raf(tick);
    return () => {
      if (rafId !== null) cancelRaf(rafId);
    };
  }, [hardCapAt, getOffsetMs]);

  return { bindHardCapEl };
}
