// spec: docs/09-chase-mode-goldrunner.md §7.1(브리핑)·§7.2(카운트다운)·§7.7(결과)·§8.1(화면 흐름·
//       ESC=자수 확인 모달)·§9.1~9.2(시드 발급·제출), docs/00 §11-D90(라우팅/스코프)·D68(랭킹 게이팅)·
//       D95(스킵·일시정지 부재, 자수는 심 비정지)·D96(체포 히트스톱은 CH-07 소관), CLAUDE.md Gotcha 3,
//       WT-CH-08.
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
import { CandidateCallouts } from './CandidateCallouts';
import { FocusStrip } from './FocusStrip';
import { WantedHud } from './WantedHud';
import { BriefingCard } from './BriefingCard';
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
      handle.setHome(homeId);
      setChaseHandle(handle);
    },
    [geoIndex, homeId],
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
          // CH-07 접점: 마커 레벨 팝만(파일 헤더 globe-chase.ts 주석) — 전체 타임라인(§7.6)은 CH-07.
          chaseHandle?.playPickup(e.at);
          chaseHandle?.setCarriedCount(engine.getSnapshot().carriedCount);
          break;
        case 'delivered':
          // CH-07 접점: playDelivery 훅 시그니처 호출 지점(§7.6 타임라인 본체는 CH-07 소관).
          chaseHandle?.playDelivery(e.payout, e.count);
          chaseHandle?.setCarriedCount(engine.getSnapshot().carriedCount);
          break;
        case 'arrested':
          // CH-07 접점: playArrest 훅 시그니처 호출 지점(히트스톱 등 타임라인 본체는 CH-07·D96).
          chaseHandle?.playArrest(e.at, e.by);
          setArrestInfo({ by: e.by, at: e.at });
          break;
        default:
          break;
      }
    });
    return unsub;
  }, [engine, chaseHandle, compiledGraph, homeId]);

  useEffect(() => {
    chaseHandle?.setIdleSpin(phase === 'idle' || phase === 'finished');
  }, [phase, chaseHandle]);

  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  useEffect(() => {
    chaseHandle?.setJuiceLevel(reducedActive ? 1 : 0);
  }, [reducedActive, chaseHandle]);

  // ESC = 자수 확인 모달(D95) — playing 중에만, 모달 표시 중에도 심은 계속 흐른다(모달에 경고 문구).
  useHotkeys(phase === 'playing' ? { Escape: () => setShowResign(true) } : {});
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
                onClick={() => setShowResign(false)}
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
