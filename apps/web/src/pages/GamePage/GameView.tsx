// spec: docs/01 §10.2(S6 인게임 3밴드·S11 레이스 전문)·§13.3(juice 2/3), docs/03 §4.2(GameView
//       컴포넌트 트리 — "GameView는 싱글/멀티가 동일 컴포넌트: 멀티는 race prop으로 OpponentTracks·
//       하드캡 타이머만 추가")·§4.5(고빈도 값 규약), WT-M2-06, WT-M4-04, WT-UI-03(원작 3밴드
//       재배치 — ① 상단 앱바(GameAppBar) ② 부유 대시보드(DashboardCard) ③ 하단 보딩패스 스트립
//       (BoardingStrip). HudBar는 GameAppBar+DashboardCard로 분해·대체. GameViewProps·RaceOverlay
//       시그니처 불변 — RaceView.tsx 무수정 컴파일이 계약 보존의 증거).
//
// countdown|playing phase의 뷰. 고빈도 값(입력 버퍼/CPM/ACC/콤보/경과시간/게이지)은 전부 엔진
// 구독 → DOM 직접 갱신(§4.5)이고, 여기 React state로 올리는 값은 §4.5가 명시 허용하는 국가 전환
// 단위 빈도의 것(콤보 ×5 글로우 on/off)뿐이다. 스탬프(juice #2)는 BoardingStrip이, 국가 채색은
// prompt-renderer가 각각 DOM을 직접 다룬다.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import type { Country, CountryId, GameMode } from '@wt/shared';
import { GameAppBar } from '../../features/hud/GameAppBar';
import { DashboardCard } from '../../features/hud/DashboardCard';
import { useLongTaskObserver } from '../../lib/useLongTaskObserver';
import { useLayoutMode } from '../../lib/useLayoutMode';
import { FirstRunTips } from '../../features/onboarding/FirstRunTips';
import { BoardingStrip } from './BoardingStrip';
import { describeRouteLabel } from './route-label';

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
  /** 모바일 우하단 고정 스킵 버튼(§7.2)용 — ESC와 동일 경로(useTypingEngine.requestSkip). */
  requestSkip?(): void;
  /** 싱글 자기 최고 기록 고스트 마커(§9.3, WT-M5-04) — GamePage의 useGhostProgress가 계산해
   *  넘긴다. race variant에서는 항상 null/undefined(GamePage가 전달하지 않는다). */
  ghostIndex?: number | null;
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
  requestSkip,
  ghostIndex = null,
}: GameViewProps) {
  const { t } = useTranslation();
  const current = countries[currentIndex];
  const next = countries[currentIndex + 1];
  const nextName = next ? (lang === 'ko' ? next.nameKo : next.nameEn) : null;
  // 국가당 제한시간이 존재하는 모드만 게이지를 보여준다(GDD §10.2 "서바이벌만" + 멀티 레이스
  // 10초 고정, docs/01 §7.1 매트릭스).
  const showGauge = mode === 'tier' || mode === 'daily' || mode === 'race';

  // 앱바 모드·트랙 표시명(route-label 재사용). trackId는 GameViewProps에 없으므로(계약 불변) 세트의
  // 첫 국가에서 도출한다 — 대륙 모드 trackId = 대륙 슬러그(countries[0].continent), 티어 = 티어 번호
  // (countries[0].difficultyTier). 세계일주/데일리/레이스는 정적 라벨이라 trackId를 쓰지 않는다.
  const derivedTrackId =
    mode === 'continent'
      ? countries[0]?.continent ?? ''
      : mode === 'tier'
        ? String(countries[0]?.difficultyTier ?? '')
        : '';
  const routeLabel = describeRouteLabel(mode, derivedTrackId, countryIds.length, t);
  // 진행바 대륙색은 현재 출제국 기준(세계일주에서 구간마다 색이 바뀐다).
  const currentContinent = current?.continent ?? null;

  // 인게임 long task 계측 훅(개발 모드 전용 콘솔 로그) — 실측 판정은 리드/WT-M2-08 수동·E2E.
  useLongTaskObserver(true);

  // 인게임 레이아웃 모드(§7.1) — 모바일 스킵 고정 버튼 노출 여부에만 쓴다. 미디어쿼리가 아니라
  // 이 훅(폭 기반, 소프트 키보드로 인한 높이 변화에 오판 없음)을 쓴다는 게 spec 요지다.
  const { mode: layoutMode } = useLayoutMode();

  const announceRef = useRef<HTMLDivElement | null>(null);
  const [edgeGlow, setEdgeGlow] = useState(false);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 스크린리더 국가 전환 낭독(§7.3 "국가 전환 시 '다음: 몽골, 12번째, 45개 중' 낭독 — 매
  // 키스트로크 낭독 금지"). textContent 직접 갱신(§4.5와 동일 취지 — 국가당 최대 1회뿐).
  useEffect(() => {
    const unsub = engine.subscribe((e) => {
      if (e.type !== 'countryShown') return;
      const el = announceRef.current;
      const c = countries[e.index];
      if (!el || !c) return;
      const name = lang === 'ko' ? c.nameKo : c.nameEn;
      el.textContent = t('hud.announceNext', {
        country: name,
        position: e.index + 1,
        total: countryIds.length,
      });
    });
    return unsub;
  }, [engine, countries, countryIds.length, lang, t]);

  // juice #3: 콤보 ×5 배수마다 화면 가장자리 글로우(§13.3-3, ComboBadge의 배지 바운스와 별개).
  useEffect(() => {
    if (!juice) return;
    const unsub = engine.subscribe((e) => {
      if (e.type === 'comboChanged' && e.combo > 0 && e.combo % GLOW_STEP === 0) {
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

      <GameAppBar
        engine={engine}
        title={routeLabel}
        continent={currentContinent}
        countryIds={countryIds}
        currentIndex={currentIndex}
        nextCountryName={nextName}
        lives={lives}
        ackIndex={race?.ackIndex ?? null}
        ghostIndex={race ? null : ghostIndex}
      />

      <div className="wt-game-view__stage">
        <DashboardCard engine={engine} bindTimerEl={bindTimerEl} bindHardCapEl={race?.bindHardCapEl} />
        {/* 온보딩 팁은 싱글 전용(§11.1) — 레이스 중엔 상대와의 실시간 대결에 방해된다. */}
        {!race && <FirstRunTips controller={controller} currentIndex={currentIndex} />}
      </div>

      <BoardingStrip
        engine={engine}
        controller={controller}
        getInputValue={getInputValue}
        countries={countries}
        currentIndex={currentIndex}
        lang={lang}
        showGauge={showGauge}
        bindGaugeEl={bindGaugeEl}
        juice={juice}
      />

      {/* 스크린리더 전용 낭독 영역(§7.3) — 시각 표시가 아니라 위 useEffect가 국가 전환 단위로만 채운다. */}
      <div ref={announceRef} aria-live="polite" className="sr-only" data-testid="game-country-announce" />

      {/* 모바일 스킵 고정 버튼(§7.2 "스킵은 화면 우하단 고정 버튼(ESC 없음)") — 데스크톱 ESC와
          동일 경로(useTypingEngine.requestSkip, 판정 로직 복제 없음). */}
      {layoutMode === 'mobile' && requestSkip && (
        <button
          type="button"
          className="wt-mobile-skip"
          data-testid="mobile-skip-button"
          aria-label={t('hud.skipHint')}
          onClick={requestSkip}
        >
          {t('hud.skipButton')}
        </button>
      )}
    </div>
  );
}
