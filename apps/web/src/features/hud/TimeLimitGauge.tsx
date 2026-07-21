// spec: docs/01 §10.2(S6 "[▓▓▓▓▓▓░░░░] 국가당 타이머(서바이벌만)"), docs/03 §4.4(useGameClock
//       bindGaugeEl), §4.5(고빈도 값 — rAF 직접 DOM 갱신, React state 미경유). WT-M2-06.
//
// 순수 레이아웃 셸. fill 폭 갱신은 전부 useGameClock의 rAF 루프가 담당한다(이 컴포넌트는
// ref만 내준다) — 티어/데일리(국가당 제한시간 존재) 모드에서만 부모가 렌더한다.
import type { RefCallback } from 'react';

export interface TimeLimitGaugeProps {
  /** useGameClock().bindGaugeEl. */
  bindGaugeEl: RefCallback<HTMLElement>;
}

export function TimeLimitGauge({ bindGaugeEl }: TimeLimitGaugeProps) {
  return (
    <div className="wt-gauge" data-testid="time-limit-gauge" aria-hidden="true">
      <div ref={bindGaugeEl} className="wt-gauge__fill" style={{ width: '100%' }} />
    </div>
  );
}
