// spec: docs/03 §4.4(useGameClock 시그니처 — bindTimerEl/bindGaugeEl), §4.5(고빈도 값 규약 —
//       rAF 루프에서 textContent/style만 직접 갱신, React state 미경유). WT-M2-03.
//
// 게임 시계. 경과 시간(⏱)과 국가별 제한시간 게이지를 rAF 루프에서 DOM에 직접 쓴다. 이 값들은
// 매 프레임 변하므로 절대 React state/Zustand로 끌어올리지 않는다(§4.5 불변식 — 위반은 리뷰 리젝).
// CPM/ACC 숫자는 HudBar(WT-M2-06)가 statsTick 이벤트로 바인딩하므로 여기서는 다루지 않는다.
import { useCallback, useEffect, useRef } from 'react';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import { formatMMSS } from '../../lib/format';

export interface UseGameClockResult {
  /** ⏱ 경과 시간 표시 요소를 바인딩(rAF로 textContent 갱신). */
  bindTimerEl(el: HTMLElement | null): void;
  /** 국가별 제한시간 게이지 요소를 바인딩(rAF로 style.width 갱신). */
  bindGaugeEl(el: HTMLElement | null): void;
}

interface LimitInfo {
  limitMs: number | null;
  shownAt: number;
}

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

export function useGameClock(engine: GameSessionEngine): UseGameClockResult {
  const timerElRef = useRef<HTMLElement | null>(null);
  const gaugeElRef = useRef<HTMLElement | null>(null);
  const limitRef = useRef<LimitInfo>({ limitMs: null, shownAt: 0 });
  const rafIdRef = useRef<number | null>(null);
  // WT-DC-04(④): 게이지 <25% 위험 상태(디자인 startGaugeLoop left<0.25). 임계 "교차 시에만"
  // style.background를 스왑해 매 프레임 write를 피한다(고빈도값 state 승격 금지 — 명령형).
  const gaugeDangerRef = useRef(false);

  const bindTimerEl = useCallback((el: HTMLElement | null) => {
    timerElRef.current = el;
  }, []);
  const bindGaugeEl = useCallback((el: HTMLElement | null) => {
    gaugeElRef.current = el;
  }, []);

  useEffect(() => {
    const tick = (): void => {
      const snap = engine.getSnapshot();
      const timerEl = timerElRef.current;
      if (timerEl) timerEl.textContent = formatMMSS(snap.elapsedMs);

      const gaugeEl = gaugeElRef.current;
      if (gaugeEl) {
        const { limitMs, shownAt } = limitRef.current;
        if (limitMs && limitMs > 0) {
          const remaining = limitMs - (now() - shownAt);
          const pct = Math.max(0, Math.min(100, (remaining / limitMs) * 100));
          gaugeEl.style.width = `${pct}%`;
          // WT-DC-04(④): <25% 임계 교차 시에만 색 스왑(디자인 #e5484d = 토큰 --continent-asia).
          // 안전 복귀 시 인라인 제거 → CSS 기본색(--grade-b)으로 환원.
          const danger = pct < 25;
          if (danger !== gaugeDangerRef.current) {
            gaugeDangerRef.current = danger;
            gaugeEl.style.background = danger ? 'var(--continent-asia)' : '';
          }
        } else {
          gaugeEl.style.width = '100%'; // 제한 없는 모드: 게이지 만충 고정
        }
      }

      if (engine.getSnapshot().phase === 'playing') {
        rafIdRef.current = raf(tick);
      } else {
        rafIdRef.current = null;
      }
    };

    const start = (): void => {
      if (rafIdRef.current == null) rafIdRef.current = raf(tick);
    };
    const stop = (): void => {
      if (rafIdRef.current != null) {
        cancelRaf(rafIdRef.current);
        rafIdRef.current = null;
      }
    };

    const onEvent = (e: EngineEvent): void => {
      if (e.type === 'countryShown') {
        limitRef.current = { limitMs: e.timeLimitMs, shownAt: now() };
        // WT-DC-04(④): 새 국가는 만충(안전)에서 시작 — 위험 상태·색을 초기화(잔상 방지).
        gaugeDangerRef.current = false;
        if (gaugeElRef.current) gaugeElRef.current.style.background = '';
      } else if (e.type === 'phase') {
        if (e.phase === 'playing') start();
        else stop();
      }
    };

    const unsub = engine.subscribe(onEvent);
    if (engine.getSnapshot().phase === 'playing') start();

    return () => {
      unsub();
      stop();
    };
  }, [engine]);

  return { bindTimerEl, bindGaugeEl };
}
