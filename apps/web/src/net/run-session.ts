// spec: docs/06 §3.1(runToken 생명주기)·§3.2(RunSubmission)·§3.4(inputDigest), docs/00 §11-D5·D21
//       (티어/데일리는 서버 salt 필수 — 클라 계산 금지)·D68(계정 로그인 하이브리드, 랭킹=로그인
//       전용), docs/07 WT-M3-06 구현 세부 지시 1·4, WT-AUTH-04(랭킹 게이팅 프론트)
//
// 판 시작(useRunStart)과 결과 제출(useRunSubmit) 배선을 모은 net 계층 훅. GamePage가 소유하는
// useGameSession/ResultView 양쪽에서 공유한다(단일 원천 — 시작/제출 로직을 페이지 컴포넌트에
// 중복 구현하지 않는다).
//
// [WT-AUTH-04 랭킹 게이팅] useRunSubmit은 이제 로그인 여부(useAuthStore)를 직접 구독한다 — net
// 계층이지만 이 파일은 애초에 React 훅(useState/useEffect)이라 순수 유틸(api-client.ts의 "net은
// 스토어를 직접 import하지 않는다" 원칙)과는 다른 층이다(AuthChip.tsx 등 다른 훅 파일도 스토어를
// 직접 구독하는 것과 동일 전례). 비로그인은 제출을 시도하지 않고 idle로 남아 ResultView가 CTA를
// 그린다 — 로그인 성공(스토어 전이) 또는 이미 로그인 상태인 마운트는 즉시 제출을 시도한다.
import { useEffect, useRef, useState } from 'react';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import { RUN_TOKEN_TTL_MS, type Continent, type CountryId, type DifficultyTier, type GameMode } from '@wt/shared';
import {
  ensureSession,
  getSessionToken,
  startRun,
  submitRun,
  type InputDigestSubmit,
  type RunResultSubmit,
  type RunStartReq,
  type RunVerdict,
} from './api-client';
import { enqueuePending } from './pending-queue';
import { selectIsLoggedIn, useAuthStore } from '../stores/auth';

// ───────────────────────── useRunStart ─────────────────────────

export type RunStartStatus = 'loading' | 'ready' | 'blocked' | 'offline-fallback';

export interface RunStartState {
  status: RunStartStatus;
  /** 서버가 확정한 세트(티어/데일리 전용 — 대륙/세계일주는 로컬 세트가 이미 서버와 결정적으로
   *  동일해 이 필드를 쓰지 않는다, workers/api/src/lib/set-builder.ts 참조). */
  countryIds: CountryId[] | null;
  runToken: string | null;
  runTokenIssuedAt: number | null;
}

/** 서버 salt 없이는 세트를 정할 수 없는 모드(§11-D5·D21) — start 실패 시 "차단"이 적용된다. */
export const SERVER_SET_MODES: ReadonlySet<GameMode> = new Set(['tier', 'daily']);

function initialRunStartState(): RunStartState {
  return { status: 'loading', countryIds: null, runToken: null, runTokenIssuedAt: null };
}

/**
 * 판 시작 배선. mode/trackId/lang/platform이 바뀔 때마다 POST /runs/start를 다시 태운다.
 * 대륙/세계일주는 로컬 세트로 즉시 플레이 가능(useGameSession)하므로 이 훅은 runToken 확보가
 * 목적이고, 실패해도 offline-fallback으로 내려 로컬 플레이를 막지 않는다. 티어/데일리는
 * countryIds 자체가 서버 산출물이라 ready 전에는 진짜 세트를 알 수 없다 — 실패 시 'blocked'
 * (BoardingPass가 CTA를 잠그고 안내로 대체한다, 구현 세부 지시 1).
 */
export function useRunStart(opts: {
  mode: GameMode;
  trackId: string;
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  /** 세션 부트스트랩(POST /session)에 쓰는 deviceId(settings 스토어 guestId). */
  guestId: string;
}): RunStartState {
  const { mode, trackId, lang, platform, guestId } = opts;
  const [state, setState] = useState<RunStartState>(initialRunStartState);

  useEffect(() => {
    if (mode === 'race') return; // 멀티는 useMultiplayer 소관 — 이 훅 대상 아님
    let cancelled = false;
    setState(initialRunStartState());

    const body: RunStartReq = {
      mode,
      lang,
      platform,
      ...(mode === 'continent' ? { continent: trackId as Continent } : {}),
      ...(mode === 'tier' ? { tier: Number(trackId) as DifficultyTier } : {}),
    };

    // 세션 토큰(Authorization) 없이 runs/start를 쏘면 401로 거절된다 — bootLoader의 부트스트랩이
    // 아직 안 끝났을 수 있어(부팅은 non-blocking, 첫 화면 렌더를 막지 않는다) 여기서 먼저
    // ensureSession으로 확정 짓는다. 이미 성공했다면(모듈 캐시) 즉시 resolve라 지연이 없다.
    ensureSession(guestId)
      .then(() => startRun(body))
      .then((res) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          countryIds: res.countryIds as CountryId[],
          runToken: res.runToken,
          runTokenIssuedAt: Date.now(),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[run-session] runs/start 실패(오프라인 추정):', err);
        setState({
          status: SERVER_SET_MODES.has(mode) ? 'blocked' : 'offline-fallback',
          countryIds: null,
          runToken: null,
          runTokenIssuedAt: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [mode, trackId, lang, platform, guestId]);

  return state;
}

// ───────────────────────── useRunSubmit ─────────────────────────

export interface RunSubmitState {
  status: 'idle' | 'submitting' | 'submitted' | 'queued';
  verdict: RunVerdict | null;
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean | null;
  /** 이번 제출로 새로 획득한 unlock_id(§9.2~9.4, WT-M5-03). queued/practice는 항상 빈 배열
   *  (오프라인 큐잉은 온라인 복귀 후 flush 시점에 판정되어 이 화면에서는 알 수 없다). */
  newUnlocks: string[];
  /** 데일리 전용 공유 텍스트(§2.3, WT-M5-04) — daily가 아니거나 아직 submitted 이전이면 null. */
  shareText: string | null;
}

function initialRunSubmitState(): RunSubmitState {
  return {
    status: 'idle',
    verdict: null,
    rank: null,
    total: null,
    isPersonalBest: null,
    newUnlocks: [],
    shareText: null,
  };
}

/** docs/06 §1.3 세트별 초기 라이프(display-only — 서버는 livesLost를 검증하지 않는다, run-verify.ts
 *  §3.2 스키마 참조라 클라·서버 판정 패리티 대상이 아니다). */
const INITIAL_LIVES: Partial<Record<GameMode, number>> = { tier: 3, worldtour: 3, daily: 1 };

/** 만료 임박 판정 안전 여유(pending-queue.ts의 동일 상수와 같은 값·같은 목적 — 그쪽은 패키지
 *  경계상 export되지 않은 지역 상수라 값만 그대로 복제한다). */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

function buildResultBody(
  result: EngineRunResult,
  perCountry: RunResultSubmit['perCountry'],
  finalLives: number | null,
): RunResultSubmit {
  const initial = INITIAL_LIVES[result.mode];
  const livesLost = initial !== undefined && finalLives !== null ? Math.max(0, initial - finalLives) : 0;
  return {
    elapsedMs: result.stats.elapsedMs,
    totalKeystrokes: result.stats.totalKeystrokes,
    correctKeystrokes: result.stats.correctKeystrokes,
    maxCombo: result.stats.maxCombo,
    countriesCleared: result.stats.countriesCleared,
    countriesSkipped: result.stats.countriesSkipped,
    livesLost,
    finished: result.outcome === 'completed',
    perCountry,
  };
}

export interface UseRunSubmitOpts {
  engine: GameSessionEngine;
  result: EngineRunResult;
  /** finished 시점의 잔여 라이프(GamePage가 engine.getSnapshot().lives를 캡처해 넘긴다). */
  finalLives: number | null;
  mode: 'continent' | 'tier' | 'worldtour' | 'daily';
  continent?: Continent;
  tier?: DifficultyTier;
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  runToken: string | null;
  runTokenIssuedAt: number | null;
  nickname: string;
}

export interface UseRunSubmitResult extends RunSubmitState {
  /** 로그인 게이트를 수동으로 재시도(테스트/방어적 재호출용). 훅 스스로 로그인 전이(isLoggedIn
   *  false→true)를 감지해 자동 호출하므로 정상 플로우에서 ResultView가 직접 부를 필요는 없다 —
   *  로그인 CTA는 openLogin()만 트리거한다. 이미 시도했으면(status!=='idle'이 될 시점 이후)
   *  no-op(중복 제출 방지, 아래 startedRef). */
  submitNow(): void;
}

/**
 * 결과 제출 배선(ResultView 마운트 수명 전체). practice/체크포인트 이어하기 판은 로그인 여부와
 * 무관하게 네트워크를 타지 않고 즉시 practice로 표시한다(§5.1 — 애초에 랭킹 제출 대상이 아니다).
 *
 * [WT-AUTH-04 랭킹 게이팅, §11-D68-①] 그 외(실제 랭킹 대상) 결과는 로그인 상태에서만 제출을
 * 시도한다 — 비로그인은 idle로 남아 ResultView가 로그인 CTA를 그린다. 이미 로그인 상태로
 * 마운트됐거나, CTA를 거쳐 로그인에 성공하면(useAuthStore 전이) 그 즉시 1회 제출을 시도한다.
 * 제출 시점엔 항상 계정 세션이므로 guestToken 브리지(§11-D68-④)를 함께 싣는다 — runToken이
 * 로그인 전(게스트 시절) 발급됐다면 서버가 이 값으로 두 신원 동시 보유를 확인해 계정 원장에
 * 등재한다(이미 계정 pid로 시작한 판이면 서버가 무시하므로 항상 첨부해도 무해).
 *
 * runToken이 없으면(오프라인 출발 — 대륙/세계일주만 도달, 티어/데일리는 애초에 시작 차단) 큐에
 * 적재한다. submitRun 자체가 실패(네트워크)해도 큐에 적재해 온라인 복귀 시 flush를 노린다.
 *
 * [에스컬레이션 기본 처리] 로그인 CTA는 사용자가 로그인을 마칠 때까지 기다리므로 runToken 발급과
 * 실제 제출 사이에 §3.1 TTL(30분)을 넘길 수 있다 — 이 경우 만료된 토큰을 그대로 제출 시도하지
 * 않고 "만료 시 로컬 저장" 기본 처리로 큐에 적재한다(아래 submitNow의 tokenStale 분기).
 */
export function useRunSubmit(opts: UseRunSubmitOpts): UseRunSubmitResult {
  const [state, setState] = useState<RunSubmitState>(initialRunSubmitState);
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  // 실제 제출 시도(네트워크 호출 또는 큐 적재)가 이미 있었는지 — 로그인 전이로 effect가 재실행돼도
  // 중복 제출하지 않게 막는 가드(리액트 18 StrictMode 이중 호출에도 동일하게 방어, features/typing/
  // useTypingEngine.ts의 ref 가드와 동일 패턴 — 같은 컴포넌트 인스턴스에서 ref는 불변 유지된다).
  const startedRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  const submitNow = (): void => {
    if (startedRef.current) return;
    startedRef.current = true;

    const submission = opts.engine.buildSubmission();
    const body = buildResultBody(opts.result, submission.perCountry, opts.finalLives);
    const inputDigest = JSON.parse(submission.inputDigest) as InputDigestSubmit;
    const clientScore = opts.result.score.finalScore;
    const nickname = opts.nickname || undefined;
    // 이 함수는 아래 effect의 게이트(!isLoggedIn → 조기 return)를 통과해야만 호출되므로 도달
    // 시점엔 항상 계정 세션이다 — guestToken 브리지 값을 항상 실어 보낸다(위 함수 주석 참조).
    const guestToken = getSessionToken() ?? undefined;

    const queueOffline = (runToken?: string, runTokenIssuedAt?: number): void => {
      setState({
        status: 'queued',
        verdict: 'practice',
        rank: null,
        total: null,
        isPersonalBest: null,
        newUnlocks: [],
        shareText: null,
      });
      // IndexedDB 자체가 없거나(사생활 모드·구형 브라우저·테스트 환경) 쿼터 초과 등으로 큐 적재가
      // 실패해도 결과 화면은 이미 "큐에 적재됨" 라벨로 안내를 마쳤다 — 조용히 로그만 남긴다
      // (throw 전파는 unhandled rejection을 남길 뿐 사용자에게 되돌릴 수단이 없다).
      enqueuePending({
        mode: opts.mode,
        continent: opts.continent,
        tier: opts.tier,
        lang: opts.lang,
        platform: opts.platform,
        runToken,
        runTokenIssuedAt,
        result: body,
        clientScore,
        inputDigest,
        nickname,
      }).catch((err: unknown) => {
        console.warn('[run-session] enqueuePending 실패:', err);
      });
    };

    // [WT-AUTH-04 에스컬레이션] 로그인 CTA는 사용자 행동(로그인 완료)을 기다리므로, runToken 발급
    // (게임 종료 시점)과 실제 제출 시도 사이에 §3.1 TTL(30분)을 넘길 수 있다 — 이미 만료된 토큰을
    // 그대로 submitRun에 태우면 서버가 rejected로 되돌려 "기록이 검토 중입니다"라는 오해의 소지가
    // 있는 라벨이 뜬다. 만료(또는 임박)로 판단되면 애초에 시도하지 않고 큐에 적재해 "온라인 연결
    // 시 자동 제출됩니다" 라벨로 안내한다 — flush 시점에 pending-queue.ts가 이 값이 stale임을 다시
    // 확인하고 새 토큰으로 재시작하므로 결과적으로 로컬 저장 후 자동 재시도가 보장된다(기본 처리).
    const tokenStale =
      opts.runTokenIssuedAt !== null &&
      Date.now() - opts.runTokenIssuedAt >= RUN_TOKEN_TTL_MS - TOKEN_SAFETY_MARGIN_MS;

    if (!opts.runToken || tokenStale) {
      queueOffline(opts.runToken ?? undefined, opts.runTokenIssuedAt ?? undefined);
      return;
    }

    setState((s) => ({ ...s, status: 'submitting' }));
    submitRun({ runToken: opts.runToken, result: body, clientScore, inputDigest, nickname, guestToken })
      .then((res) => {
        if (unmountedRef.current) return;
        setState({
          status: 'submitted',
          verdict: res.verdict,
          rank: res.rank,
          total: res.total,
          isPersonalBest: res.isPersonalBest,
          newUnlocks: res.newUnlocks ?? [],
          shareText: res.shareText ?? null,
        });
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        console.warn('[run-session] runs/submit 실패 — 큐에 적재:', err);
        queueOffline(opts.runToken ?? undefined, opts.runTokenIssuedAt ?? undefined);
      });
  };

  useEffect(() => {
    if (startedRef.current) return;

    if (opts.result.practice || opts.result.viaCheckpoint) {
      startedRef.current = true;
      setState({
        status: 'submitted',
        verdict: 'practice',
        rank: null,
        total: null,
        isPersonalBest: null,
        newUnlocks: [],
        shareText: null,
      });
      return;
    }

    // 랭킹 게이팅(§11-D68-①) — 비로그인은 idle 유지(ResultView가 로그인 CTA를 그린다). 로그인
    // 전이(또는 이미 로그인된 마운트)만 제출을 트리거한다. result/engine/runToken 등은 ResultView
    // 마운트 수명 동안 불변(기존 전제 유지)이라 isLoggedIn 외엔 재실행 트리거가 필요 없다.
    if (!isLoggedIn) return;
    submitNow();
    // eslint(react-hooks/exhaustive-deps)는 이 레포에 미설정 — opts 전체를 매 렌더 새 객체로
    // 만드는 호출부(ResultView) 특성상 의도적으로 isLoggedIn만 의존성으로 둔다.
  }, [isLoggedIn]);

  return { ...state, submitNow };
}
