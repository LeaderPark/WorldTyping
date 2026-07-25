// spec: docs/09-chase-mode-goldrunner.md §7.1(브리핑)·§7.2(카운트다운)·§7.7(결과)·§8.1(화면 흐름·
//       ESC=자수 확인 모달)·§9.1~9.2(시드 발급·제출), docs/00 §11-D90(라우팅/스코프)·D68(랭킹 게이팅)·
//       D95(스킵·일시정지 부재, 자수는 심 비정지)·D96(체포 히트스톱은 CH-07 소관)·D111(첫 런 코치마크
//       마운트·phase 오버레이 은닉), CLAUDE.md Gotcha 3, WT-CH-08 → WT-CH-DEV-2.
//
// GamePage(mode=chase)의 페이지 루트 — pages/GamePage/index.tsx가 chase 라우트에서 lazy(dynamic
// import)로 불러온다(chase 코드는 entry/기존 5모드 "game" 청크와 분리된 별도 청크, vite.config.ts
// manualChunks 참조). 기존 GameSessionEngine 기반 흐름과 완전히 독립된 세션 오케스트레이션을
// 소유한다 — useGameSession/useTypingEngine/GameView/ResultView(고정 국가 배열 전제)는 무한 생존
// chase에 맞지 않아 재사용하지 않는다(대신 입력 계층·엔진 이벤트 계약은 CH-04/06이 이미 재사용).
//
// 여정: 로딩(시드+chase-graph fetch) → idle(BriefingCard) → countdown → playing(CandidateCallouts+
// FocusStrip+WantedHud) → finished(ChaseResultCard+제출). ESC(playing 중)는 자수 확인 모달만 제공하고
// 심은 정지하지 않는다(D95). 지구본은 전 phase에 걸쳐 항상 마운트되어 배경/무대를 겸한다(기존
// GamePage와 동일 관례).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Country, CountryId, ChaseGraph, ChaseWorld, DifficultyTier, GoldRing, PoliceKind } from '@wt/shared';
import { compileGraph, computeChaseScore, hopDistanceMap, mergeChaseConstants, simulateChase } from '@wt/shared';
import { ChaseSessionEngine, COUNTDOWN_MS, type ChaseSnapshot, type PoliceView, type SessionPhase } from '@wt/engine';
import { getBootData } from '../../app/bootLoader';
import { useSettingsStore } from '../../stores/settings';
import { useSessionStore } from '../../stores/session';
import { useAuthStore } from '../../stores/auth';
import { ensureSession, startChase } from '../../net/api-client';
import { useModalA11y } from '../../lib/useModalA11y';
import { useHotkeys } from '../../lib/hotkeys';
import { Mascot } from '../../components/Mascot';
import { GlobeMap, type GlobeMapHandle } from '../map/globe/GlobeMap';
import { useGlobeIndex } from '../map/globe/useGlobeIndex';
import { createGlobeChaseHandle, type GlobeChaseHandle } from '../map/globe/globe-chase';
import { ShareCard } from '../result/ShareCard';
import { loadChaseGraph } from './load-chase-graph';
import { useChaseEngine } from './use-chase-engine';
import { useChaseSubmission, type ChaseSubmissionState } from './use-chase-submission';
import { useChaseJuice } from './use-chase-juice';
import { CandidateCallouts } from './CandidateCallouts';
import { FocusStrip } from './FocusStrip';
import { WantedHud } from './WantedHud';
import { BriefingCard } from './BriefingCard';
import { ChaseFirstRunTips } from './ChaseFirstRunTips';
import { ChaseResultCard } from './ChaseResultCard';

interface ChaseBoot {
  seed: number;
  runToken: string;
  graph: ChaseGraph;
}

function realClock(): { now(): number; schedule(cb: () => void, ms: number): () => void } {
  return {
    now: () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    schedule: (cb, ms) => {
      const id = setTimeout(cb, ms);
      return () => clearTimeout(id);
    },
  };
}

function buildChaseWorld(graph: ChaseGraph, countries: readonly Country[]): ChaseWorld {
  const tiers: Record<CountryId, DifficultyTier> = {};
  for (const c of countries) tiers[c.id] = c.difficultyTier;
  return { graph, tiers };
}

/** GamePage(index.tsx)가 chase 라우트에서 React.lazy로 불러오는 페이지 루트. */
export function ChaseGameRoot() {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const platform = useSettingsStore((s) => s.platform);
  const guestId = useSettingsStore((s) => s.guestId);

  const [sessionKey, setSessionKey] = useState(0);
  const [boot, setBoot] = useState<ChaseBoot | null>(null);
  const [bootError, setBootError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBoot(null);
    setBootError(false);
    Promise.all([ensureSession(guestId).then(() => startChase({ lang, platform })), loadChaseGraph()])
      .then(([startRes, graph]) => {
        if (cancelled) return;
        setBoot({ seed: startRes.seed, runToken: startRes.runToken, graph });
      })
      .catch((err: unknown) => {
        console.warn('[chase] start/graph 로드 실패(오프라인 추정):', err);
        if (!cancelled) setBootError(true);
      });
    return () => {
      cancelled = true;
    };
    // sessionKey는 "재도전"(새 시드 재발급, §8.1) 트리거 전용 — 값 자체는 쓰지 않고 effect
    // 재실행만 유발한다.
  }, [lang, platform, guestId, sessionKey]);

  const retry = useCallback(() => setSessionKey((k) => k + 1), []);
  const countries = useMemo(() => getBootData().countries.countries, []);

  if (bootError) {
    return (
      <div className="wt-game-page" data-testid="chase-blocked">
        <div className="wt-game-page__content">
          <div className="wt-boarding__card wt-boarding__card--blocked">
            <div className="wt-boarding__main">
              <p className="wt-boarding__label">{t('boarding.blocked.title')}</p>
              <p className="wt-boarding__rules">{t('boarding.blocked.body')}</p>
              <button
                type="button"
                className="wt-btn wt-btn--primary"
                data-testid="chase-blocked-retry"
                onClick={retry}
              >
                {t('result.action.retry')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="wt-game-page" data-testid="chase-loading">
        <div className="wt-game-page__content">
          <p role="status">{t('boarding.connecting')}</p>
        </div>
      </div>
    );
  }

  return (
    <ChasePlaySession
      key={sessionKey}
      seed={boot.seed}
      runToken={boot.runToken}
      graph={boot.graph}
      countries={countries}
      lang={lang}
      platform={platform}
      retry={retry}
    />
  );
}

interface ChasePlaySessionProps {
  seed: number;
  runToken: string;
  graph: ChaseGraph;
  countries: readonly Country[];
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  retry(): void;
}

function ChasePlaySession({ seed, runToken, graph, countries, lang, platform, retry }: ChasePlaySessionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);

  const constants = useMemo(() => mergeChaseConstants(), []);
  const world = useMemo(() => buildChaseWorld(graph, countries), [graph, countries]);
  const compiledGraph = useMemo(() => compileGraph(graph), [graph]);

  // 홈 국가는 seed에서 결정적으로 파생된다(D91) — engine.start() 이전(브리핑 idle 단계)에도
  // 미션 텍스트에 실제 홈 국가명을 보여줘야 하므로, simulateChase(moveLog:[], endMs:0)를 미리
  // 1회 peek한다(재구현 아님 — 순수 함수를 그대로 import해 다른 시점에 호출할 뿐. engine이
  // beginPlaying()에서 동일 입력으로 다시 호출하는 값과 항상 일치한다).
  const homeId = useMemo<CountryId>(
    () => simulateChase({ seed, moveLog: [], endMs: 0, constants }, world).home,
    [seed, world, constants],
  );
  const countryById = useMemo(() => {
    const m = new Map<CountryId, Country>();
    for (const c of countries) m.set(c.id, c);
    return m;
  }, [countries]);
  const homeCountry = countryById.get(homeId) ?? null;
  const homeName = homeCountry ? (lang === 'ko' ? homeCountry.nameKo : homeCountry.nameEn) : '';
  const countryName = useCallback(
    (id: CountryId): string => {
      const c = countryById.get(id);
      return c ? (lang === 'ko' ? c.nameKo : c.nameEn) : id;
    },
    [countryById, lang],
  );

  const engine = useMemo(
    () => new ChaseSessionEngine({ ...realClock(), seed, graph, countries, constants }, lang),
    [seed, graph, countries, constants, lang],
  );
  useEffect(() => () => engine.abort(), [engine]);

  const { inputRef, focusInput, controller } = useChaseEngine(engine, countries);

  const [phase, setPhase] = useState<SessionPhase>(() => engine.getSnapshot().phase);
  const [finishedSnapshot, setFinishedSnapshot] = useState<ChaseSnapshot | null>(null);
  const [arrestInfo, setArrestInfo] = useState<{ by: PoliceKind; at: CountryId } | null>(null);
  const [showResign, setShowResign] = useState(false);

  const geoIndex = useGlobeIndex();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [chaseHandle, setChaseHandle] = useState<GlobeChaseHandle | null>(null);

  const onMapReady = useCallback(
    (core: GlobeMapHandle) => {
      const container = pageRef.current?.querySelector<HTMLElement>('.wt-game-page__map');
      if (!container || !geoIndex) return;
      const handle = createGlobeChaseHandle({ core, container, index: geoIndex });
      // 전 국가(un195) 노드 도트 레이어(§11-D108-B) — chase-graph의 ids가 곧 un195 정확 집합이라
      // 별도 국가 목록 필터를 두지 않는다(심이 이동 가능하다고 보는 노드 = 화면에 보이는 노드).
      handle.setCountryNodes(graph.ids);
      handle.setHome(homeId);
      setChaseHandle(handle);
    },
    [geoIndex, homeId, graph],
  );

  // 경찰/위협 상태 추적용 ref(엔진이 policeUpdated 이벤트로만 라이브 유닛을 실어 보낸다 —
  // ChaseSnapshot엔 police 필드가 없다, chase-session.ts 헤더 참조).
  const policeIdsRef = useRef<Set<number>>(new Set());
  const lastPoliceUnitsRef = useRef<readonly PoliceView[]>([]);
  const goldMapRef = useRef<Map<CountryId, GoldRing>>(new Map());

  useEffect(() => {
    policeIdsRef.current = new Set();
    lastPoliceUnitsRef.current = [];
    goldMapRef.current = new Map();

    function refreshThreat(units: readonly PoliceView[]): void {
      if (!chaseHandle) return;
      const snap = engine.getSnapshot();
      if (!snap.player || units.length === 0) {
        chaseHandle.setThreatLevel(snap.stars, 99);
        return;
      }
      const distMap = hopDistanceMap(compiledGraph, snap.player);
      let nearest = 99;
      for (const u of units) {
        const d = distMap.get(u.at);
        if (d !== undefined && d < nearest) nearest = d;
      }
      chaseHandle.setThreatLevel(snap.stars, nearest);
    }

    const unsub = engine.subscribe((e) => {
      switch (e.type) {
        case 'phase': {
          setPhase(e.phase);
          useSessionStore.getState().setPhase(e.phase);
          if (e.phase === 'playing') {
            chaseHandle?.moveVehicle(homeId, homeId, { durationMs: 0 });
          } else if (e.phase === 'finished') {
            setFinishedSnapshot(engine.getSnapshot());
          }
          break;
        }
        case 'hopCommitted':
          chaseHandle?.moveVehicle(e.from, e.to);
          refreshThreat(lastPoliceUnitsRef.current);
          break;
        case 'wantedChanged':
          refreshThreat(lastPoliceUnitsRef.current);
          break;
        case 'policeUpdated': {
          const newIds = new Set(e.units.map((u) => u.id));
          for (const id of policeIdsRef.current) {
            if (!newIds.has(id)) chaseHandle?.removePoliceMarker(id);
          }
          policeIdsRef.current = newIds;
          for (const u of e.units) chaseHandle?.upsertPoliceMarker(u);
          lastPoliceUnitsRef.current = e.units;
          refreshThreat(e.units);
          break;
        }
        case 'goldSpawned':
          goldMapRef.current.set(e.at, e.ring);
          chaseHandle?.setGoldMarkers(Array.from(goldMapRef.current, ([at, ring]) => ({ at, ring })));
          break;
        case 'goldPicked':
          goldMapRef.current.delete(e.at);
          chaseHandle?.setGoldMarkers(Array.from(goldMapRef.current, ([at, ring]) => ({ at, ring })));
          // playPickup(마커 레벨 폴리곤 플래시) 호출 자체는 useChaseJuice(ChaseJuiceLayer 아래)가
          // 마운트하는 sequences.ts §7.6 타임라인이 소유한다(WT-CH-07) — 여기서 다시 부르면 플래시가
          // 2회 발생한다. 이 훅은 지구본 마커(금 목록·소지 수)만 갱신한다.
          chaseHandle?.setCarriedCount(engine.getSnapshot().carriedCount);
          break;
        case 'delivered':
          // playDelivery 호출도 위와 동일한 이유로 sequences.ts(useChaseJuice) 전담 — 중복 호출 금지.
          chaseHandle?.setCarriedCount(engine.getSnapshot().carriedCount);
          break;
        case 'arrested':
          // playArrest 호출도 sequences.ts(useChaseJuice)가 §7.6·D96 히트스톱 타임라인 안에서
          // 오프셋(520ms)에 맞춰 직접 부른다 — 여기서는 결과 카드용 로컬 상태만 기록한다.
          setArrestInfo({ by: e.by, at: e.at });
          break;
        default:
          break;
      }
    });
    return unsub;
  }, [engine, chaseHandle, compiledGraph, homeId]);

  // idle spin(브리핑·결과)과 chase 오버레이 표시는 정확히 반대로 묶인다(§11-D111 ②-a).
  // 코어 idle spin은 canvas만 회전시키고 globe-chase.ts의 미러 카메라는 따라가지 않으므로(미러는
  // 홉 카메라 접점 3메서드로만 갱신 — D67 "상시 rAF 신설 금지" 계약), 스핀 구간에는 마커·노드·
  // 연결선이 돌아가는 지구본 위에 고정돼 좌표가 어긋난 채로 남는다(D108 "알려진 잔여"). 리드
  // 결정에 따라 그 구간에서는 오버레이를 은닉한다 — 브리핑·결과 화면에 마커 정보는 불필요하다
  // (필요한 정보는 브리핑 카드·결과 카드가 이미 전달).
  // [체포 시퀀스와의 관계 — 최종 보고 기재] 'arrested'는 즉시 phase='finished'라 오버레이도 즉시
  // 페이드아웃한다. 그 결과 §7.6 체포 타임라인 520ms의 **마커 레벨 팝(playArrest)만** 보이지 않게
  // 되는데, 같은 순간 이미 idle spin이 시작돼 그 팝은 어차피 어긋난 좌표에 찍히던 것이고(현행
  // 동작), 풀스크린 체포 연출(히트스톱·플래시·톤다운·ARRESTED 스탬프·"○○에서 검거" 플로팅)은
  // 별도 레이어(.wt-chase-fx)라 2,800ms 타임라인 전체가 그대로 재생된다 — 연출 타이밍 충돌 없음.
  useEffect(() => {
    const spinning = phase === 'idle' || phase === 'finished';
    chaseHandle?.setIdleSpin(spinning);
    chaseHandle?.setOverlayVisible(!spinning);
  }, [phase, chaseHandle]);

  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  useEffect(() => {
    chaseHandle?.setJuiceLevel(reducedActive ? 1 : 0);
  }, [reducedActive, chaseHandle]);

  // ESC = 자수 확인 모달(D95) — playing 중에만, 모달 표시 중에도 심은 계속 흐른다(모달에 경고 문구).
  // [controller.detach() 시점 — 실측 확인, 최종 보고 기재] useModalA11y가 모달을 열며 첫 포커스
  // 가능 요소(Stay 버튼)로 focus()를 옮기면 이전에 포커스돼 있던 FocusStrip 히든 input이 네이티브
  // blur를 발생시킨다. TypingInputController.attach()는 그 blur를 selfInducedBlur 가드 없이 그대로
  // 'blurred' TypingEvent로 승격하고(input-controller.ts, 수정 금지 대상), chase-session.ts의
  // handleInput은 모든 'blurred'를 무조건 degrade('blur')로 처리해(practice는 단방향, 최초 1회뿐)
  // ESC를 누르는 순간(확인 여부와 무관하게, "머무르기"를 눌러도) 런이 영구 practice로 강등된다 —
  // D95 "자수는 체포와 동일한 정상 종료로 처리(제출 가능)"이 실제로는 이 UI 경로로 절대 도달할 수
  // 없게 되는 회귀(ChaseGameRoot.test.tsx가 이 회귀를 실행 중 실제로 잡아냈다). packages/engine은
  // 수정 금지이므로, 모달이 포커스를 훔치기 전에 컨트롤러를 detach()해 그 blur 자체가 리스너 없이
  // 지나가게 한다 — 모달이 화면을 덮는 동안 타이핑을 받지 않는 것은 어차피 정상적인 모달 UX이고,
  // 심(경찰 이동·수배 로직)은 D95대로 detach와 무관하게 계속 흐른다(controller는 표시/입력 계층일
  // 뿐 심 타이머와 분리). "머무르기"를 누르면 attach()+focusInput()으로 정확히 복원한다.
  useHotkeys(
    phase === 'playing'
      ? {
          Escape: () => {
            controller?.detach();
            setShowResign(true);
          },
        }
      : {},
  );
  const resignModalRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(resignModalRef, showResign && phase === 'playing');

  // ── 결과 계산(finished 전이 시점 1회 — Gotcha 3: computeChaseScore를 그대로 import해 재계산) ──
  const countryLookup = useMemo(() => {
    const m: Record<string, Country> = {};
    for (const c of countries) m[c.id] = c;
    return m;
  }, [countries]);

  const scoreResult = useMemo(() => {
    if (!finishedSnapshot?.finalState) return null;
    return computeChaseScore(
      finishedSnapshot.finalState,
      countryLookup,
      {
        totalKeystrokes: finishedSnapshot.totalKeystrokes,
        correctKeystrokes: finishedSnapshot.correctKeystrokes,
        elapsedMs: finishedSnapshot.elapsedMs,
        maxCombo: finishedSnapshot.maxCombo,
      },
      lang,
      constants,
    );
  }, [finishedSnapshot, countryLookup, lang, constants]);

  const fledDistanceKm = useMemo(() => {
    const visited = finishedSnapshot?.finalState?.visited;
    if (!visited) return 0;
    let sum = 0;
    for (let i = 0; i < visited.length - 1; i++) sum += compiledGraph.dist(visited[i]!, visited[i + 1]!);
    return sum;
  }, [finishedSnapshot, compiledGraph]);

  const maxStars = useMemo(() => {
    const finalState = finishedSnapshot?.finalState;
    if (!finalState) return 0;
    let max = finalState.stars;
    for (const e of finalState.events) if (e.type === 'starChanged') max = Math.max(max, e.to);
    return max;
  }, [finishedSnapshot]);

  const deliveredPayout = useMemo(() => {
    const finalState = finishedSnapshot?.finalState;
    if (!finalState) return 0;
    let sum = 0;
    for (const e of finalState.events) if (e.type === 'delivered') sum += e.payout;
    return Math.round(sum);
  }, [finishedSnapshot]);

  const visitedCount = useMemo(() => {
    const visited = finishedSnapshot?.finalState?.visited;
    return visited ? new Set(visited).size : 0;
  }, [finishedSnapshot]);

  const submission = useChaseSubmission({ engine, runToken, snapshot: finishedSnapshot, scoreResult });

  const cardRef = useRef<HTMLDivElement>(null);
  const shareTitle =
    scoreResult && finishedSnapshot
      ? t('chase.share.caption', {
          count: visitedCount,
          home: homeName,
          n: scoreResult.delivered,
          score: scoreResult.finalScore,
        })
      : '';

  return (
    <div className="wt-game-page" data-testid="chase-game-page" ref={pageRef}>
      {geoIndex && <GlobeMap index={geoIndex} className="wt-game-page__map" onReady={onMapReady} />}

      {/* useChaseJuice(§7.6~7.8 연출 트리거, WT-CH-07 산출물) 마운트 지점 — CandidateCallouts/
          WantedHud와 달리 phase 게이팅을 하지 않는다: 체포 시퀀스(2,800ms)는 엔진이 'arrested' 즉시
          phase를 'finished'로 넘긴 뒤에도 끝까지 재생돼야 하므로(§7.6 "2,800ms 결과 카드 슬라이드
          인" — 아래 결과 카드는 그 이전에 이미 렌더되지만, 연출은 지구본 위에서 별도로 계속 재생),
          지구본과 동일하게 chaseHandle이 존재하는 한(세션 전 phase) 상주시킨다. */}
      {chaseHandle && (
        <ChaseJuiceLayer engine={engine} globe={chaseHandle} countries={countries} lang={lang} />
      )}

      {(phase === 'idle' || phase === 'countdown' || phase === 'playing') && (
        <FocusStrip inputRef={inputRef} controller={controller} />
      )}

      {phase === 'idle' && (
        <div className="wt-game-page__content">
          <BriefingCard homeName={homeName} focusInput={focusInput} onStart={() => engine.start()} />
        </div>
      )}

      {phase === 'countdown' && (
        <>
          <div className="wt-countdown-scrim" data-testid="chase-countdown-scrim" aria-hidden="true" />
          <ChaseCountdownOverlay engine={engine} />
        </>
      )}

      {(phase === 'countdown' || phase === 'playing') && chaseHandle && (
        <>
          <CandidateCallouts engine={engine} controller={controller} globe={chaseHandle} countries={countries} lang={lang} />
          <WantedHud engine={engine} />
        </>
      )}

      {/* 첫 런 한정 코치마크 3개(§11-D111 ① — playing 진입 후에만, 카운트다운·결과에는 뜨지 않는다).
          비모달·비블로킹이라 이 위치(HUD/콜아웃 형제)에 그대로 얹어도 입력을 가리지 않는다. */}
      {phase === 'playing' && <ChaseFirstRunTips />}

      {phase === 'playing' && showResign && (
        <div
          ref={resignModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="wt-chase-resign-title"
          aria-describedby="wt-chase-resign-body"
          className="wt-confirm-leave"
          data-testid="chase-resign-confirm"
        >
          <div className="wt-confirm-leave__box">
            <p id="wt-chase-resign-title" className="wt-confirm-leave__title">
              {t('chase.resign.title')}
            </p>
            <p id="wt-chase-resign-body" className="wt-confirm-leave__body">
              {t('chase.resign.body')}
            </p>
            <div className="wt-confirm-leave__actions">
              <button
                type="button"
                className="wt-btn"
                data-testid="chase-resign-stay"
                onClick={() => {
                  // attach()를 먼저 호출해 두면, 이 클릭 이후 useModalA11y 클린업(닫힘 시 "열기 전
                  // 포커스였던 요소로 복귀" — 위 useHotkeys 주석 참조)이 히든 input에 걸어 주는
                  // 네이티브 focus를 컨트롤러가 다시 수신해 정상적으로 'refocused'를 방출한다.
                  controller?.attach();
                  setShowResign(false);
                }}
              >
                {t('chase.resign.stay')}
              </button>
              <button
                type="button"
                className="wt-btn wt-btn--danger"
                data-testid="chase-resign-confirm-btn"
                onClick={() => {
                  setShowResign(false);
                  engine.resign();
                }}
              >
                {t('chase.resign.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'finished' && finishedSnapshot && scoreResult && (
        <div className="wt-game-page__content">
          <h1 className="wt-result-view__title" tabIndex={-1}>
            {finishedSnapshot.outcome === 'arrested' ? t('chase.arrest.stamp') : t('chase.mode.title')}
          </h1>
          <p role="status" aria-live="assertive" className="sr-only" data-testid="chase-result-announce">
            {t('result.announce', { grade: scoreResult.grade, score: scoreResult.finalScore })}
          </p>

          <div ref={cardRef} className="wt-result-view__card">
            <ChaseResultCard
              grade={scoreResult.grade}
              finalScore={scoreResult.finalScore}
              pi={scoreResult.pi}
              survivalMs={finishedSnapshot.elapsedMs}
              fledDistanceKm={fledDistanceKm}
              maxStars={maxStars}
              deliveredCount={scoreResult.delivered}
              deliveredPayout={deliveredPayout}
              maxCombo={finishedSnapshot.maxCombo}
              cpm={scoreResult.cpm}
              accuracy={scoreResult.acc}
              outcome={finishedSnapshot.outcome ?? 'resigned'}
              arrestedBy={arrestInfo?.by}
              arrestedCountryName={arrestInfo ? countryName(arrestInfo.at) : undefined}
            />
          </div>

          <ChaseSubmissionStatus submission={submission} />

          <div className="wt-result-view__actions">
            <button type="button" data-testid="chase-result-retry" className="wt-btn wt-btn--primary" onClick={retry}>
              {t('result.action.retry')}
            </button>
            <Link to="/rank?mode=chase" data-testid="chase-result-ranking" className="wt-btn">
              {t('result.action.ranking')}
            </Link>
            <ShareCard cardRef={cardRef} platform={platform} shareTitle={shareTitle} />
            <button type="button" data-testid="chase-result-home" className="wt-btn" onClick={() => navigate('/')}>
              {t('nav.home')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** useChaseJuice(WT-CH-07 산출물) 마운트 어댑터 — 훅이 반환하는 layerRef를 CandidateCallouts의
 *  `.wt-candidate-overlay`와 동일한 절대 위치 형제 레이어(`.wt-chase-fx`)에 붙인다(use-chase-juice.ts
 *  파일 헤더 예시 그대로). engine/globe는 세션당 1회 생성되는 안정 참조라 훅의 "마운트 상수" 계약과
 *  맞물린다. onArrestComplete는 넘기지 않는다 — ChaseGameRoot는 'arrested' 시 엔진 'phase' 이벤트로
 *  즉시 finished 전이·결과 계산을 하므로(위 engine.subscribe 'phase' 분기) 콜백 없이도 결과 화면
 *  표시가 정상 동작한다(훅 자체 JSDoc의 "콜백 없이도 정상 동작" 각주와 동일 결론). */
function ChaseJuiceLayer({
  engine,
  globe,
  countries,
  lang,
}: {
  engine: ChaseSessionEngine;
  globe: GlobeChaseHandle;
  countries: readonly Country[];
  lang: 'ko' | 'en';
}) {
  const { layerRef } = useChaseJuice(engine, globe, { lang, countries });
  return <div ref={layerRef} className="wt-chase-fx" data-testid="chase-fx-layer" aria-hidden="true" />;
}

/** §7.2 카운트다운 — 기존 GamePage 카운트다운 문법(비프 케이던스 0/1000/2000ms) 재사용, 억센트만
 *  --chase-siren-red로 교체. */
function ChaseCountdownOverlay({ engine }: { engine: ChaseSessionEngine }) {
  const { t } = useTranslation();
  const numRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = numRef.current;
    if (!el) return undefined;
    const nowMs =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    const endsAt = engine.getSnapshot().countdownEndsAt;
    let duration = endsAt != null ? endsAt - nowMs : COUNTDOWN_MS;
    if (!Number.isFinite(duration) || duration <= 0) duration = COUNTDOWN_MS;
    const beepTimes = [0, 1000, 2000].filter((ms) => ms < duration);
    const startNum = beepTimes.length;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const showAt = (i: number): void => {
      el.textContent = String(startNum - i);
    };
    beepTimes.forEach((ms, i) => {
      if (ms === 0) showAt(0);
      else timers.push(setTimeout(() => showAt(i), ms));
    });
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [engine]);

  return (
    <div className="wt-game-intro" data-testid="chase-countdown" role="status" aria-live="polite">
      <div className="wt-game-intro__box">
        <Mascot width={46} tail="var(--chase-siren-red)" />
        <p className="wt-game-intro__title">{t('game.intro.title')}</p>
        <p className="wt-game-intro__hint">{t('game.intro.hint')}</p>
      </div>
      <span
        ref={numRef}
        className="wt-game-intro__count"
        data-testid="chase-countdown-number"
        style={{ color: 'var(--chase-siren-red)' }}
        aria-hidden="true"
      />
    </div>
  );
}

/** 제출 상태 표시(§11-D68-① 로그인 게이팅) — ResultView.tsx SubmissionStatus와 동일 i18n 키 재사용
 *  (오프라인 큐잉 'queued'는 use-chase-submission.ts가 배선하지 않아 이 화면엔 없다 — 최종 보고 기재). */
function ChaseSubmissionStatus({ submission }: { submission: ChaseSubmissionState }) {
  const { t } = useTranslation();
  const openLogin = useAuthStore((s) => s.openLogin);

  if (submission.status === 'idle') {
    return (
      <button
        type="button"
        data-testid="chase-result-login-cta"
        className="wt-btn wt-btn--primary"
        onClick={() => openLogin('ranking')}
      >
        {t('result.loginToRank')}
      </button>
    );
  }
  if (submission.status === 'submitting') {
    return (
      <p className="wt-result-view__submission" data-testid="chase-result-verdict-label">
        {t('result.verdict.submitting')}
      </p>
    );
  }
  if (submission.verdict === 'practice') {
    return (
      <p className="wt-result-view__submission" data-testid="chase-result-verdict-label">
        {t('result.verdict.practice')}
      </p>
    );
  }
  if (submission.verdict === 'rejected') {
    return (
      <p className="wt-result-view__submission" data-testid="chase-result-verdict-label">
        {t('result.verdict.rejected')}
      </p>
    );
  }
  const registered = (
    <p
      className="wt-result-view__submission wt-result-view__submission--registered"
      data-testid="chase-result-registered"
    >
      {t('result.registered')}
    </p>
  );
  if (submission.rank !== null && submission.total !== null && submission.total > 0) {
    const topPercent = Math.max(1, Math.round((submission.rank / submission.total) * 100));
    return (
      <div className="wt-result-view__status">
        {registered}
        <p
          className={`wt-result-view__rank${submission.isPersonalBest ? ' wt-result-view__rank--best' : ''}`}
          data-testid="chase-result-rank"
        >
          {t('result.rank.value', { rank: submission.rank, percent: topPercent })}
          {submission.isPersonalBest && ` · ${t('result.rank.personalBest')}`}
        </p>
      </div>
    );
  }
  return registered;
}
