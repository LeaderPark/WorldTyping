// spec: docs/01 §10.2(S6 인게임 HUD 전문)·§13.3(juice 1/2/3/4), docs/03 §4.2(GameView 컴포넌트
//       트리 — HudBar/PromptArea/ProgressLine/HiddenTypingInput)·§4.5(고빈도 값 규약), WT-M2-06.
//
// countdown|playing phase의 뷰. 고빈도 값(입력 버퍼/CPM/ACC/콤보/경과시간/게이지)은 전부 엔진
// 구독 → DOM 직접 갱신(§4.5)이고, 여기 React state로 올리는 값은 §4.5가 명시 허용하는 국가 전환
// 단위 빈도의 것(콤보 ×5 글로우 on/off, 스탬프 트리거)뿐이다.
import { useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import type { Country, CountryId, GameMode } from '@wt/shared';
import { PromptArea } from '../../features/typing/PromptArea';
import { HudBar } from '../../features/hud/HudBar';
import { ProgressLine } from '../../features/hud/ProgressLine';
import { TimeLimitGauge } from '../../features/hud/TimeLimitGauge';
import { useLongTaskObserver } from '../../lib/useLongTaskObserver';

/** GDD §13.3-3 콤보 글로우 배수. */
const GLOW_STEP = 5;
const GLOW_MS = 500;

export interface GameViewProps {
  engine: GameSessionEngine;
  controller: TypingInputController | null;
  getInputValue(): string;
  lang: 'ko' | 'en';
  mode: GameMode;
  countries: readonly Country[];
  countryIds: readonly CountryId[];
  currentIndex: number;
  lives: number | null;
  bindTimerEl: RefCallback<HTMLElement>;
  bindGaugeEl: RefCallback<HTMLElement>;
  juice?: boolean;
}

export function GameView({
  engine,
  controller,
  getInputValue,
  lang,
  mode,
  countries,
  countryIds,
  currentIndex,
  lives,
  bindTimerEl,
  bindGaugeEl,
  juice = true,
}: GameViewProps) {
  const current = countries[currentIndex];
  const next = countries[currentIndex + 1];
  const nextName = next ? (lang === 'ko' ? next.nameKo : next.nameEn) : null;
  // 국가당 제한시간이 존재하는 모드만 게이지를 보여준다(GDD §10.2 "서바이벌만").
  const showGauge = mode === 'tier' || mode === 'daily';

  // 인게임 long task 계측 훅(개발 모드 전용 콘솔 로그) — 실측 판정은 리드/WT-M2-08 수동·E2E.
  useLongTaskObserver(true);

  const stampRef = useRef<HTMLDivElement | null>(null);
  const [edgeGlow, setEdgeGlow] = useState(false);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // juice #2: 국가 확정(스킵 제외) 시 프롬프트 위에 스탬프가 15° 기울어져 찍힌다(§13.3-2).
  // juice #3: 콤보 ×5 배수마다 화면 가장자리 글로우(§13.3-3, ComboBadge의 배지 바운스와 별개).
  useEffect(() => {
    if (!juice) return;
    const unsub = engine.subscribe((e) => {
      if (e.type === 'countryCommitted' && !e.skipped) {
        const el = stampRef.current;
        if (el) {
          el.classList.remove('wt-stamp--active');
          void el.offsetWidth;
          el.classList.add('wt-stamp--active');
        }
      } else if (e.type === 'comboChanged' && e.combo > 0 && e.combo % GLOW_STEP === 0) {
        setEdgeGlow(true);
        if (glowTimer.current) clearTimeout(glowTimer.current);
        glowTimer.current = setTimeout(() => {
          setEdgeGlow(false);
          glowTimer.current = null;
        }, GLOW_MS);
      }
    });
    return () => {
      unsub();
      if (glowTimer.current) clearTimeout(glowTimer.current);
    };
  }, [engine, juice]);

  return (
    <div
      className={`wt-game-view${edgeGlow ? ' wt-game-view--glow' : ''}`}
      data-testid="game-view"
    >
      <HudBar engine={engine} bindTimerEl={bindTimerEl} lives={lives} juice={juice} />

      {current && (
        <div className="wt-game-view__prompt" data-testid="game-stamp-anchor">
          <PromptArea
            country={current}
            lang={lang}
            controller={controller}
            getInputValue={getInputValue}
            juiceLevel={juice ? 2 : 0}
          >
            {showGauge && <TimeLimitGauge bindGaugeEl={bindGaugeEl} />}
          </PromptArea>
          <div ref={stampRef} className="wt-stamp" aria-hidden="true" />
        </div>
      )}

      <ProgressLine countryIds={countryIds} currentIndex={currentIndex} nextCountryName={nextName} />
    </div>
  );
}
