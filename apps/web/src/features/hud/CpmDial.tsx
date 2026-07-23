// spec: docs/01 §10.2(S6 HUD — 실시간 CPM), docs/03 §4.2(부유 대시보드)·§4.5(고빈도 값 규약 —
//       CPM은 React state 절대 금지, 엔진 statsTick 구독 → DOM 직접 갱신). WT-UI-03.
//
// 반원 SVG 다이얼. 바늘(needle)은 statsTick(500ms 스로틀) 이벤트를 구독해 el.style.transform =
// rotate()로만 회전시킨다 — React state를 경유하지 않는다(§4.5 불변식). CPM은 0~800으로 클램프한
// 각도(-90°..+90°)에 매핑한다. 중앙 수치(hud-cpm)는 textContent로 직접 갱신한다.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import { formatCpm } from '../../lib/format';

export interface CpmDialProps {
  engine: GameSessionEngine;
}

/** 다이얼 만눈금(§4.5 표시 상한 — 800타/분에서 바늘이 우측 끝). */
const CPM_MAX = 800;

/** clamp(cpm, 0, 800) → 반원 각도(-90°=0, +90°=800). */
function cpmToDeg(cpm: number): number {
  const clamped = Math.max(0, Math.min(CPM_MAX, Number.isFinite(cpm) ? cpm : 0));
  return -90 + (clamped / CPM_MAX) * 180;
}

export function CpmDial({ engine }: CpmDialProps) {
  const { t } = useTranslation();
  const needleRef = useRef<SVGGElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const render = (cpm: number): void => {
      const needle = needleRef.current;
      const value = valueRef.current;
      if (needle) needle.style.transform = `rotate(${cpmToDeg(cpm).toFixed(1)}deg)`;
      if (value) value.textContent = String(formatCpm(cpm));
    };
    render(0);
    const onEvent = (e: EngineEvent): void => {
      if (e.type === 'statsTick') render(e.cpm);
    };
    return engine.subscribe(onEvent);
  }, [engine]);

  return (
    <div className="wt-dial" data-testid="cpm-dial">
      <svg className="wt-dial__gauge" viewBox="0 0 120 68" aria-hidden="true">
        {/* 배경 반원 트랙 */}
        <path className="wt-dial__track" d="M12 60 A48 48 0 0 1 108 60" />
        {/* 눈금 3점(0 / 중앙 / 최대) — 장식 */}
        <line className="wt-dial__tick" x1="12" y1="60" x2="20" y2="60" />
        <line className="wt-dial__tick" x1="60" y1="12" x2="60" y2="20" />
        <line className="wt-dial__tick" x1="108" y1="60" x2="100" y2="60" />
        {/* 바늘: 기본 12시 방향, rotate()로만 회전(transform-origin=hub, CSS에서 지정) */}
        <g ref={needleRef} className="wt-dial__needle">
          <polygon points="57,60 63,60 60,18" />
        </g>
        <circle className="wt-dial__hub" cx="60" cy="60" r="5" />
      </svg>
      <div className="wt-dial__readout">
        <span ref={valueRef} className="wt-dial__value" data-testid="hud-cpm">
          0
        </span>
        <span className="wt-dial__unit">{t('dial.cpm.label')}</span>
      </div>
    </div>
  );
}
