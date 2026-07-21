// spec: docs/01 §10.2(S6 HUD 와이어프레임 "⏱ ⚡ 🎯 ×N STREAK ♥♥♥"), docs/03 §4.2(HudBar —
//       bindEl 직접 갱신), §4.4(useGameClock), §4.5(고빈도 값 규약: CPM/ACC/콤보는 React state
//       절대 금지 — lives는 §4.3 SessionState가 국가 전환 단위 빈도로 명시 허용). WT-M2-06.
//
// ⏱(타이머)는 부모(GameView)가 useGameClock으로 바인딩한 요소 ref를 그대로 받는다(rAF 루프
// 1개 공유). CPM/ACC는 statsTick(500ms 스로틀) 이벤트를 직접 구독해 textContent만 갱신한다.
// 콤보는 ComboBadge(자체 구독)에 위임. 라이프는 저빈도 값이라 prop(React state)으로 받는다.
import { useEffect, useRef } from 'react';
import type { RefCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import { formatCpm, formatPercent } from '../../lib/format';
import { ComboBadge } from './ComboBadge';

export interface HudBarProps {
  engine: GameSessionEngine;
  /** useGameClock().bindTimerEl. */
  bindTimerEl: RefCallback<HTMLElement>;
  /** null이면 라이프 없는 모드(대륙/레이스) — 하트 UI 자체를 숨긴다. */
  lives: number | null;
  juice?: boolean;
}

export function HudBar({ engine, bindTimerEl, lives, juice = true }: HudBarProps) {
  const { t } = useTranslation();
  const cpmRef = useRef<HTMLSpanElement | null>(null);
  const accRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const cpmEl = cpmRef.current;
    const accEl = accRef.current;
    if (cpmEl) cpmEl.textContent = t('hud.cpm', { cpm: 0 });
    if (accEl) accEl.textContent = t('hud.accuracy', { accuracy: 100 });

    const onEvent = (e: EngineEvent): void => {
      if (e.type !== 'statsTick') return;
      if (cpmEl) cpmEl.textContent = t('hud.cpm', { cpm: formatCpm(e.cpm) });
      if (accEl) accEl.textContent = t('hud.accuracy', { accuracy: formatPercent(e.acc) });
    };
    return engine.subscribe(onEvent);
  }, [engine, t]);

  return (
    <div className="wt-hud" data-testid="hud-bar">
      <span ref={bindTimerEl} className="wt-hud__timer" data-testid="hud-timer" />
      <span ref={cpmRef} className="wt-hud__cpm" data-testid="hud-cpm" />
      <span ref={accRef} className="wt-hud__acc" data-testid="hud-acc" />
      <ComboBadge engine={engine} juice={juice} />
      {lives !== null && (
        <span
          className="wt-hud__lives"
          data-testid="hud-lives"
          aria-label={t('hud.lives', { count: lives })}
        >
          {'♥'.repeat(Math.max(0, lives))}
        </span>
      )}
    </div>
  );
}
