// spec: docs/06 §3.1(runToken 생명주기)·§3.2(RunSubmission)·§3.4(inputDigest), docs/00 §11-D5·D21
//       (티어/데일리는 서버 salt 필수 — 클라 계산 금지), docs/07 WT-M3-06 구현 세부 지시 1·4
//
// 판 시작(useRunStart)과 결과 제출(useRunSubmit) 배선을 모은 net 계층 훅. GamePage가 소유하는
// useGameSession/ResultView 양쪽에서 공유한다(단일 원천 — 시작/제출 로직을 페이지 컴포넌트에
// 중복 구현하지 않는다).
import { useEffect, useState } from 'react';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import type { Continent, CountryId, DifficultyTier, GameMode } from '@wt/shared';
import {
  ensureSession,
  startRun,
  submitRun,
  type InputDigestSubmit,
  type RunResultSubmit,
  type RunStartReq,
  type RunVerdict,
} from './api-client';
import { enqueuePending } from './pending-queue';

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
}

function initialRunSubmitState(): RunSubmitState {
  return { status: 'idle', verdict: null, rank: null, total: null, isPersonalBest: null };
}

/** docs/06 §1.3 세트별 초기 라이프(display-only — 서버는 livesLost를 검증하지 않는다, run-verify.ts
 *  §3.2 스키마 참조라 클라·서버 판정 패리티 대상이 아니다). */
const INITIAL_LIVES: Partial<Record<GameMode, number>> = { tier: 3, worldtour: 3, daily: 1 };

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

/**
 * 결과 제출 배선(ResultView 마운트 1회). practice/체크포인트 이어하기 판은 네트워크를 타지
 * 않고 즉시 practice로 표시한다(§5.1 — 애초에 랭킹 제출 대상이 아니다). runToken이 없으면
 * (오프라인 출발 — 대륙/세계일주만 도달, 티어/데일리는 애초에 시작 차단) 큐에 적재한다.
 * submitRun 자체가 실패(네트워크)해도 큐에 적재해 온라인 복귀 시 flush를 노린다.
 */
export function useRunSubmit(opts: UseRunSubmitOpts): RunSubmitState {
  const [state, setState] = useState<RunSubmitState>(initialRunSubmitState);

  useEffect(() => {
    let cancelled = false;

    if (opts.result.practice || opts.result.viaCheckpoint) {
      setState({ status: 'submitted', verdict: 'practice', rank: null, total: null, isPersonalBest: null });
      return;
    }

    const submission = opts.engine.buildSubmission();
    const body = buildResultBody(opts.result, submission.perCountry, opts.finalLives);
    const inputDigest = JSON.parse(submission.inputDigest) as InputDigestSubmit;
    const clientScore = opts.result.score.finalScore;
    const nickname = opts.nickname || undefined;

    const queueOffline = (runToken?: string, runTokenIssuedAt?: number): void => {
      setState({ status: 'queued', verdict: 'practice', rank: null, total: null, isPersonalBest: null });
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

    if (!opts.runToken) {
      queueOffline();
      return;
    }

    setState((s) => ({ ...s, status: 'submitting' }));
    submitRun({ runToken: opts.runToken, result: body, clientScore, inputDigest, nickname })
      .then((res) => {
        if (cancelled) return;
        setState({ status: 'submitted', verdict: res.verdict, rank: res.rank, total: res.total, isPersonalBest: res.isPersonalBest });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[run-session] runs/submit 실패 — 큐에 적재:', err);
        queueOffline(opts.runToken ?? undefined, opts.runTokenIssuedAt ?? undefined);
      });

    return () => {
      cancelled = true;
    };
    // result/engine/runToken 등은 ResultView 마운트 수명(phase==='finished') 동안 불변 — 마운트
    // 1회만 실행한다(ResultView.tsx의 recordRun 이펙트와 동일 전제·동일 패턴).
  }, []);

  return state;
}
