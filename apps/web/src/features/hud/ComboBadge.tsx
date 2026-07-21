// spec: docs/01 §10.2(S6 "×12 STREAK"), §13.3-3(콤보 ×5 단위 글로우+배지 바운스), docs/03 §4.2
//       (HudBar 하위 — bindEl 직접 갱신), §4.5(콤보는 고빈도 값 — React state 절대 금지). WT-M2-06.
//
// 엔진의 comboChanged 이벤트를 직접 구독해 자신의 DOM만 갱신한다(PromptArea/prompt-renderer와
// 동일 패턴 — 국가 확정마다 바뀌는 값이라도 React state에 올리지 않는다). ×5 배수마다 bounce
// 클래스를 재트리거한다(§13.3-3). juice 0(모션 줄이기)이면 bounce를 건너뛴다.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';

export interface ComboBadgeProps {
  engine: GameSessionEngine;
  /** true(기본)면 ×5 배수 바운스 연출. reduced-motion/모션 줄이기 시 false로 억제. */
  juice?: boolean;
}

const GLOW_STEP = 5;
const BOUNCE_MS = 260;

export function ComboBadge({ engine, juice = true }: ComboBadgeProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement | null>(null);
  const bounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const render = (combo: number): void => {
      el.textContent = t('hud.streak', { count: combo });
      el.classList.toggle('wt-combo--hidden', combo <= 0);
    };
    render(engine.getSnapshot().combo);

    const onEvent = (e: EngineEvent): void => {
      if (e.type !== 'comboChanged') return;
      render(e.combo);
      if (juice && e.combo > 0 && e.combo % GLOW_STEP === 0) {
        el.classList.remove('wt-combo--bounce');
        void el.offsetWidth; // 재트리거를 위한 강제 리플로우 읽기(레이아웃 write 아님)
        el.classList.add('wt-combo--bounce');
        if (bounceTimer.current) clearTimeout(bounceTimer.current);
        bounceTimer.current = setTimeout(() => {
          el.classList.remove('wt-combo--bounce');
          bounceTimer.current = null;
        }, BOUNCE_MS);
      }
    };
    const unsub = engine.subscribe(onEvent);
    return () => {
      unsub();
      if (bounceTimer.current) clearTimeout(bounceTimer.current);
    };
  }, [engine, juice, t]);

  return <span ref={ref} className="wt-combo-badge wt-combo--hidden" data-testid="combo-badge" />;
}
