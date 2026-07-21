// spec: docs/07 WT-M2-06 acceptance("인게임 중 PerformanceObserver로 long task(>50ms) 0건 로그
// 확인") + 세션 환경 어댑테이션 2항("long task 계측은 계측 훅만 심고, 실측은 WT-M2-08/리드 수동
// 확인으로 이관"). 개발 모드 전용 콘솔 계측 — 프로덕션 빌드에서는 완전히 no-op(옵저버조차
// 생성하지 않는다).
import { useEffect } from 'react';

const LONG_TASK_THRESHOLD_MS = 50;

/**
 * `active`가 true인 동안(보통 인게임: countdown|playing) 50ms 초과 태스크를 콘솔에 경고로
 * 남긴다. `longtask` PerformanceObserver 미지원 브라우저(Firefox 등)에서는 조용히 무시한다 —
 * 계측 훅일 뿐 게임 로직·판정과는 무관하다(§13.3-8 "입력 비블로킹"과 별개).
 */
export function useLongTaskObserver(active: boolean): void {
  useEffect(() => {
    if (!active || !import.meta.env.DEV) return;
    if (typeof PerformanceObserver === 'undefined') return;

    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > LONG_TASK_THRESHOLD_MS) {
            console.warn(
              `[wt:longtask] ${Math.round(entry.duration)}ms (>${LONG_TASK_THRESHOLD_MS}ms) — ${entry.name}`,
            );
          }
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, [active]);
}
