// spec: docs/09-chase-mode-goldrunner.md §9.2(제출 계약 — moveLog/runLog/clientResult), docs/00
//       §11-D68(랭킹 등재 로그인 게이팅)·D95(자수 종료도 제출 가능), WT-CH-08.
//
// net/run-session.ts의 useRunSubmit chase 대응물. 그 파일은 mode==='chase'를 조기 return으로
// 제외해 무수정 유지되므로(§11-D90 좌표 정정·킷 지시 "run-session.ts chase early-return 유지"),
// chase 제출 배선은 이 훅이 전담한다 — 로그인 게이팅(§11-D68-①)·게스트→계정 브리지(guestToken)
// 계약은 useRunSubmit과 동일하되, 오프라인 큐잉(pending-queue.ts)은 이번 배선에 포함하지 않는다
// (5모드 큐 스키마가 이 페이로드 모양과 달라 확장이 별도 태스크 스코프 — 최종 보고 기재).
import { useEffect, useRef, useState } from 'react';
import type { ChaseSessionEngine, ChaseSnapshot } from '@wt/engine';
import type { ChaseScoreResult } from '@wt/shared';
import { getSessionToken, submitChaseRun, type ChaseSubmitReq, type RunVerdict } from '../../net/api-client';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';

export interface ChaseSubmissionState {
  status: 'idle' | 'submitting' | 'submitted';
  verdict: RunVerdict | null;
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean | null;
}

function initialState(): ChaseSubmissionState {
  return { status: 'idle', verdict: null, rank: null, total: null, isPersonalBest: null };
}

export interface UseChaseSubmissionOpts {
  engine: ChaseSessionEngine;
  runToken: string;
  /** finished 전이 시점에 캡처된 스냅샷(outcome/endedAtMs/practice/keystroke 통계 원천) — null이면
   *  아직 종료 전(제출 시도하지 않는다). */
  snapshot: ChaseSnapshot | null;
  /** computeChaseScore(snapshot.finalState, …) 1회 계산 결과 — null이면 아직 미계산. */
  scoreResult: ChaseScoreResult | null;
}

/**
 * finished 전이(snapshot·scoreResult 확보) + 로그인 상태를 보고 1회 제출을 시도한다(§11-D68-①과
 * 동일 게이팅: practice면 네트워크 없이 즉시 practice, 비로그인은 idle 유지 — 호출부가 로그인 CTA를
 * 그린다, 로그인 전이를 감지하면 자동 재시도).
 */
export function useChaseSubmission(opts: UseChaseSubmissionOpts): ChaseSubmissionState {
  const [state, setState] = useState<ChaseSubmissionState>(initialState);
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const startedRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  useEffect(() => {
    if (startedRef.current) return;
    const { snapshot, scoreResult } = opts;
    if (!snapshot || !scoreResult || snapshot.outcome === null || snapshot.endedAtMs === null) return;

    if (snapshot.practice) {
      startedRef.current = true;
      setState({ status: 'submitted', verdict: 'practice', rank: null, total: null, isPersonalBest: null });
      return;
    }

    if (!isLoggedIn) return; // idle 유지 — 호출부가 로그인 CTA를 그린다.
    startedRef.current = true;

    const submission = opts.engine.buildSubmission(opts.runToken);
    const runLog = submission.perHop.map((h, i) => ({ hopIndex: i, keystrokes: h.keystrokes, errors: h.errors }));
    const body: ChaseSubmitReq = {
      runToken: submission.token,
      moveLog: submission.moveLog,
      runLog,
      clientResult: {
        score: scoreResult.finalScore,
        pi: scoreResult.pi,
        stats: {
          totalKeystrokes: snapshot.totalKeystrokes,
          correctKeystrokes: snapshot.correctKeystrokes,
          elapsedMs: snapshot.elapsedMs,
          maxCombo: snapshot.maxCombo,
        },
        outcome: submission.outcome,
        endedAtMs: submission.endedAtMs,
        ...(snapshot.finalState?.arrestedAtMs != null ? { arrestedAtMs: snapshot.finalState.arrestedAtMs } : {}),
      },
      guestToken: getSessionToken() ?? undefined,
    };

    setState((s) => ({ ...s, status: 'submitting' }));
    submitChaseRun(body)
      .then((res) => {
        if (unmountedRef.current) return;
        setState({
          status: 'submitted',
          verdict: res.verdict,
          rank: res.rank,
          total: res.total,
          isPersonalBest: res.isPersonalBest,
        });
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        console.warn('[chase] runs/submit 실패:', err);
        // 오프라인 큐잉 미배선(파일 상단 주석) — 실패는 rejected로 표시해 사용자가 알 수 있게 한다.
        setState({ status: 'submitted', verdict: 'rejected', rank: null, total: null, isPersonalBest: null });
      });
    // eslint(react-hooks/exhaustive-deps)는 이 레포에 미설정(net/run-session.ts useRunSubmit과 동일
    // 전례) — snapshot/scoreResult는 finished 전이 이후 불변이라 참조로 충분하다.
  }, [isLoggedIn, opts.snapshot, opts.scoreResult, opts.engine, opts.runToken]);

  return state;
}
