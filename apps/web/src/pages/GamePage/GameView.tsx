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
import { useCallback, useEffect, useRef, useState } from 'react';
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

/** WT-DC-04(②): 생명 손실 하트 바운스(디자인 loseLife 450ms) / 비네트 플래시(700ms) / 경유지 배너
 *  유지(2200ms). */
const HEART_HIT_MS = 450;
const VIGNETTE_MS = 700;
const CHECKPOINT_BANNER_MS = 2200;

/** WT-DC-04(②): 하트 색 펄스 목표색(디자인 #e5484d). WAAPI 키프레임은 CSS var()를 못 풀므로
 *  런타임에 토큰(--continent-asia = 디자인 #e5484d)을 해석해 쓰고, 해석 불가 시 리터럴로 폴백한다. */
const DANGER_FALLBACK = '#e5484d';
function resolveDangerColor(): string {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return DANGER_FALLBACK;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--continent-asia').trim();
  return v || DANGER_FALLBACK;
}

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

  // WT-DC-04(②): 생명 손실 비네트 + 하트 바운스. 비네트는 자기 div, 하트는 GameAppBar가 ref로 넘긴
  // 요소. lifeChanged는 playing 진입 시 초기 라이프로도 1회 emit되므로(engine beginPlaying) "감소"만
  // 필터한다(prevLives 추적). 전부 WAAPI(비네트=opacity, 하트=transform+color) — 명령형·비블로킹.
  const vignetteRef = useRef<HTMLDivElement | null>(null);
  const livesElRef = useRef<HTMLElement | null>(null);
  const bindLivesEl = useCallback((el: HTMLElement | null) => {
    livesElRef.current = el;
  }, []);
  const prevLivesRef = useRef<number | null>(lives);
  useEffect(() => {
    const unsub = engine.subscribe((e) => {
      if (e.type !== 'lifeChanged') return;
      const prev = prevLivesRef.current;
      prevLivesRef.current = e.lives;
      // 초기 세팅/증가/동일은 손실 아님. 감소일 때만 연출.
      if (prev == null || e.lives >= prev) return;
      if (!juice) return;
      const v = vignetteRef.current;
      if (v && typeof v.animate === 'function') {
        v.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], {
          duration: VIGNETTE_MS,
          easing: 'ease-out',
        });
      }
      const h = livesElRef.current;
      if (h && typeof h.animate === 'function') {
        const danger = resolveDangerColor();
        h.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.5) rotate(-8deg)', color: danger },
            { transform: 'scale(1)' },
          ],
          { duration: HEART_HIT_MS, easing: 'ease-out' },
        );
      }
    });
    return unsub;
  }, [engine, juice]);

  // WT-DC-04(③): 세계일주 경유지 배너(디자인 L325~328). countryCommitted(비스킵)에서 10/20/30/40
  // 번째 도착(종착 제외) 시 상단 배너를 명령형으로 띄우고 2200ms 후 감춘다(React state 미경유 —
  // 국가 전환 단위 이하 빈도지만 리렌더 없이 처리). 지도 앰버 링은 GamePage가 별도 구독한다.
  const cpBannerRef = useRef<HTMLDivElement | null>(null);
  const cpBannerTextRef = useRef<HTMLSpanElement | null>(null);
  const cpBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'worldtour') return undefined;
    const total = countryIds.length;
    const unsub = engine.subscribe((e) => {
      if (e.type !== 'countryCommitted' || e.skipped) return;
      const reached = e.index + 1;
      if (reached % 10 !== 0 || reached >= total) return;
      const c = countries[e.index];
      const banner = cpBannerRef.current;
      const textEl = cpBannerTextRef.current;
      if (!c || !banner || !textEl) return;
      textEl.textContent = t('game.checkpoint.banner', {
        country: lang === 'ko' ? c.nameKo : c.nameEn,
        current: reached,
        total,
      });
      banner.classList.remove('wt-cp-banner--show');
      void banner.offsetWidth; // 애니메이션 재시작(읽기 1회 — 레이아웃 write 아님)
      banner.classList.add('wt-cp-banner--show');
      if (cpBannerTimer.current) clearTimeout(cpBannerTimer.current);
      cpBannerTimer.current = setTimeout(() => {
        banner.classList.remove('wt-cp-banner--show');
        cpBannerTimer.current = null;
      }, CHECKPOINT_BANNER_MS);
    });
    return () => {
      unsub();
      if (cpBannerTimer.current) clearTimeout(cpBannerTimer.current);
    };
  }, [engine, mode, countries, countryIds, lang, t]);

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
        title={race ? t('race.reveal.countries', { count: countryIds.length }) : routeLabel}
        continent={currentContinent}
        countryIds={countryIds}
        currentIndex={currentIndex}
        nextCountryName={nextName}
        lives={lives}
        ackIndex={race?.ackIndex ?? null}
        ghostIndex={race ? null : ghostIndex}
        bindLivesEl={bindLivesEl}
      />

      {/* WT-DC-05(②): 하드캡 칩 이설 — 디자인 S11의 라운드 헤더 밴드로 옮긴다(정본 L441). 기존
          DashboardCard(부유 대시보드) 슬롯에서 빼내(bindHardCapEl 미전달 → DashboardCard의 옵셔널
          슬롯 미렌더, DashboardCard 소스·계약 무변경) 여기 GameView race 분기가 직접 렌더한다.
          testid(race-hardcap / race-hardcap-time)와 bindHardCapEl 바인딩은 그대로 보존한다. 스코프
          CSS([data-variant='race'] .wt-race-hardcap-slot)가 640px 헤더 밴드 우측에 배치한다. */}
      {race && (
        <div className="wt-race-hardcap-slot">
          <div className="wt-race-hardcap" data-testid="race-hardcap">
            <span ref={race.bindHardCapEl} data-testid="race-hardcap-time" />
          </div>
        </div>
      )}

      <div className="wt-game-view__stage">
        {/* WT-DC-05(②): race variant에선 하드캡을 위 헤더 밴드로 이설했으므로 대시보드엔 넘기지
            않는다(디자인 S11엔 부유 대시보드 없음 — 스테이지 자체를 스코프 CSS로 숨긴다). 싱글은
            원래대로 bindHardCapEl 미전달(undefined)이라 동작 불변. */}
        <DashboardCard engine={engine} bindTimerEl={bindTimerEl} />
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
        mode={mode}
        showGauge={showGauge}
        bindGaugeEl={bindGaugeEl}
        juice={juice}
      />

      {/* WT-DC-04(②): 생명 손실 비네트(디자인 L324, z6). 평상시 opacity 0, lifeChanged 감소 시 WAAPI. */}
      <div ref={vignetteRef} className="wt-life-vignette" data-testid="life-vignette" aria-hidden="true" />

      {/* WT-DC-04(③): 세계일주 경유지 배너(디자인 L325~328, top 64px, z6). 기본 숨김 — 위 effect가
          도착 시 --show 토글 + textContent 갱신. race variant엔 없음(싱글 전용 연출). */}
      {!race && mode === 'worldtour' && (
        <div ref={cpBannerRef} className="wt-cp-banner" data-testid="checkpoint-banner" role="status" aria-live="polite">
          <span ref={cpBannerTextRef} className="wt-cp-banner__pill" />
        </div>
      )}

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
