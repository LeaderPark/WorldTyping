// spec: docs/01 §10.2(S6 인게임 HUD 전문·S11 레이스 전문)·§13.3(juice 1/2/3/4), docs/03 §4.2(GameView
//       컴포넌트 트리 — HudBar/PromptArea/ProgressLine/HiddenTypingInput, "GameView는 싱글/멀티가
//       동일 컴포넌트: 멀티는 race prop으로 OpponentTracks·하드캡 타이머만 추가")·§4.5(고빈도 값
//       규약)·§6.3(서버 ack 고스트 이중 표시), WT-M2-06, WT-M4-04(race overlay 추가 — 타이핑
//       파이프라인 코드 1벌 유지).
//
// countdown|playing phase의 뷰. 고빈도 값(입력 버퍼/CPM/ACC/콤보/경과시간/게이지)은 전부 엔진
// 구독 → DOM 직접 갱신(§4.5)이고, 여기 React state로 올리는 값은 §4.5가 명시 허용하는 국가 전환
// 단위 빈도의 것(콤보 ×5 글로우 on/off, 스탬프 트리거)뿐이다.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import type { Country, CountryId, GameMode } from '@wt/shared';
import { PromptArea } from '../../features/typing/PromptArea';
import { HudBar } from '../../features/hud/HudBar';
import { ProgressLine } from '../../features/hud/ProgressLine';
import { TimeLimitGauge } from '../../features/hud/TimeLimitGauge';
import { useLongTaskObserver } from '../../lib/useLongTaskObserver';
import { FirstRunTips } from '../../features/onboarding/FirstRunTips';

/** GDD §13.3-3 콤보 글로우 배수. */
const GLOW_STEP = 5;
const GLOW_MS = 500;

/** 멀티 레이스 오버레이(WT-M4-04) — 존재하면 GameView가 variant="race"로 동작한다(docs/03 §4.2).
 *  RaceView(pages/multi/RoomPage)가 조립해 넘긴다 — GameView 자체는 멀티플레이어 스토어/네트워크를
 *  모른다(계층 분리 유지). */
export interface RaceOverlay {
  /** OpponentTracks 등 상대 진행 UI — HUD 위에 렌더. */
  tracksSlot: ReactNode;
  /** 하드캡 카운트다운 텍스트 바인딩(§4.5와 동일한 취지 — rAF로 textContent만 직접 갱신). */
  bindHardCapEl: RefCallback<HTMLElement>;
  /** 서버가 마지막으로 확인한 인덱스(§6.3 진행바 고스트). null이면 아직 없음. */
  ackIndex: number | null;
}

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
  /** 지정 시 멀티 레이스 variant(docs/03 §4.2 "variant=race"). */
  race?: RaceOverlay;
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
  race,
}: GameViewProps) {
  const current = countries[currentIndex];
  const next = countries[currentIndex + 1];
  const nextName = next ? (lang === 'ko' ? next.nameKo : next.nameEn) : null;
  // 국가당 제한시간이 존재하는 모드만 게이지를 보여준다(GDD §10.2 "서바이벌만" + 멀티 레이스
  // 10초 고정, docs/01 §7.1 매트릭스).
  const showGauge = mode === 'tier' || mode === 'daily' || mode === 'race';

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
      data-variant={race ? 'race' : 'single'}
    >
      {race && (
        <div className="wt-race-overlay" data-testid="race-overlay-tracks">
          {race.tracksSlot}
        </div>
      )}

      <HudBar engine={engine} bindTimerEl={bindTimerEl} lives={lives} juice={juice} />

      {race && (
        <div className="wt-race-hardcap" data-testid="race-hardcap">
          <span ref={race.bindHardCapEl} data-testid="race-hardcap-time" />
        </div>
      )}

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

      <ProgressLine
        countryIds={countryIds}
        currentIndex={currentIndex}
        nextCountryName={nextName}
        ackIndex={race?.ackIndex ?? null}
      />

      {/* 온보딩 팁은 싱글 전용(§11.1) — 레이스 중 표시하면 상대와의 실시간 대결에 방해된다. */}
      {!race && <FirstRunTips controller={controller} currentIndex={currentIndex} />}
    </div>
  );
}
