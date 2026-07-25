// @vitest-environment jsdom
//
// spec: docs/09 §9.2(제출 계약), docs/00 §11-D68(랭킹 게이팅), WT-CH-08. net/run-session.ts
// (ResultView.test.tsx)와 동일한 목킹 전례: stores/auth가 net/api-client를 모듈 로드 시 호출하므로
// 그 전체를 vi.mock해야 한다.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseSessionEngine, ChaseSnapshot } from '@wt/engine';
import type { ChaseScoreResult } from '@wt/shared';
import { useAuthStore, type AccountSession } from '../../stores/auth';
import { useChaseSubmission } from './use-chase-submission';

const submitChaseRunMock = vi.fn();
vi.mock('../../net/api-client', () => ({
  submitChaseRun: (...args: unknown[]) => submitChaseRunMock(...args),
  getSessionToken: () => 'wt1.guest-session-token',
  getAuthToken: () => 'wt1.acct',
  setAuthToken: () => true,
  onLoginRequired: () => () => {},
  onAccountTokenRejected: () => () => {},
}));

function loginSession(over: Partial<AccountSession> = {}): AccountSession {
  return {
    token: 'wt1.acct',
    playerId: 'p-acct',
    nickname: 'Traveler',
    expiresAt: Date.now() + 60_000,
    geo: 'KR',
    profile: { name: 'Traveler', picture: null, email: null },
    ...over,
  };
}

function fakeEngine(): ChaseSessionEngine {
  return {
    buildSubmission: (token: string) => ({
      token,
      seed: 1,
      moveLog: [{ hopIndex: 0, countryId: 'FR', tMs: 500 }],
      endedAtMs: 5000,
      outcome: 'arrested',
      practice: false,
      perHop: [{ code: 'FR', ms: 500, keystrokes: 3, errors: 0, skipped: false, inputUsed: '프랑스' }],
      inputDigest: '{}',
    }),
  } as unknown as ChaseSessionEngine;
}

function fakeSnapshot(overrides: Partial<ChaseSnapshot> = {}): ChaseSnapshot {
  return {
    phase: 'finished',
    mode: 'chase',
    lang: 'ko',
    home: 'KR',
    player: 'FR',
    stars: 2,
    carriedCount: 0,
    hopsCommitted: 1,
    candidates: [],
    combo: 1,
    maxCombo: 1,
    totalKeystrokes: 3,
    correctKeystrokes: 3,
    elapsedMs: 5000,
    practice: false,
    outcome: 'arrested',
    endedAtMs: 5000,
    countdownEndsAt: null,
    finalState: { arrestedAtMs: 5000 } as ChaseSnapshot['finalState'],
    ...overrides,
  };
}

function fakeScore(): ChaseScoreResult {
  return {
    cpm: 480,
    acc: 1,
    pi: 480,
    grade: 'A',
    delivered: 0,
    typingScore: 100,
    goldScore: 0,
    survivalScore: 0,
    accFactor: 1,
    comboFactor: 1,
    finalScore: 100,
  };
}

afterEach(() => {
  useAuthStore.getState().logout();
  useAuthStore.getState().closeLogin();
  vi.clearAllMocks();
});

describe('useChaseSubmission', () => {
  it('snapshot/scoreResult가 없으면 idle에 머문다(네트워크 호출 없음)', () => {
    const { result } = renderHook(() =>
      useChaseSubmission({ engine: fakeEngine(), runToken: 'rt', snapshot: null, scoreResult: null }),
    );
    expect(result.current.status).toBe('idle');
    expect(submitChaseRunMock).not.toHaveBeenCalled();
  });

  it('practice 스냅샷은 로그인 여부와 무관하게 즉시 submitted/practice로 표시한다(네트워크 없음)', () => {
    const { result } = renderHook(() =>
      useChaseSubmission({
        engine: fakeEngine(),
        runToken: 'rt',
        snapshot: fakeSnapshot({ practice: true }),
        scoreResult: fakeScore(),
      }),
    );
    expect(result.current.status).toBe('submitted');
    expect(result.current.verdict).toBe('practice');
    expect(submitChaseRunMock).not.toHaveBeenCalled();
  });

  it('비로그인이면 idle 유지(제출 시도하지 않음 — §11-D68-① 로그인 CTA 게이팅)', () => {
    const { result } = renderHook(() =>
      useChaseSubmission({
        engine: fakeEngine(),
        runToken: 'rt',
        snapshot: fakeSnapshot(),
        scoreResult: fakeScore(),
      }),
    );
    expect(result.current.status).toBe('idle');
    expect(submitChaseRunMock).not.toHaveBeenCalled();
  });

  it('로그인 상태면 buildSubmission+제출을 수행하고 서버 verdict/rank를 반영한다', async () => {
    submitChaseRunMock.mockResolvedValue({
      verdict: 'valid',
      score: 100,
      pi: 480,
      cpm: 480,
      accMilli: 1000,
      grade: 'A',
      completed: false,
      rank: 3,
      total: 50,
      isPersonalBest: true,
      newUnlocks: [],
      shareText: null,
      shareId: null,
    });
    act(() => useAuthStore.getState().login(loginSession()));

    const { result } = renderHook(() =>
      useChaseSubmission({
        engine: fakeEngine(),
        runToken: 'rt',
        snapshot: fakeSnapshot(),
        scoreResult: fakeScore(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('submitted'));
    expect(result.current.verdict).toBe('valid');
    expect(result.current.rank).toBe(3);
    expect(result.current.isPersonalBest).toBe(true);

    const body = submitChaseRunMock.mock.calls[0]![0];
    expect(body.runToken).toBe('rt');
    expect(body.moveLog).toEqual([{ hopIndex: 0, countryId: 'FR', tMs: 500 }]);
    expect(body.runLog).toEqual([{ hopIndex: 0, keystrokes: 3, errors: 0 }]);
    expect(body.clientResult.outcome).toBe('arrested');
    expect(body.clientResult.arrestedAtMs).toBe(5000);
    expect(body.guestToken).toBe('wt1.guest-session-token');
  });

  it('제출 실패(네트워크 예외)는 rejected로 표시한다', async () => {
    submitChaseRunMock.mockRejectedValue(new Error('offline'));
    act(() => useAuthStore.getState().login(loginSession()));

    const { result } = renderHook(() =>
      useChaseSubmission({
        engine: fakeEngine(),
        runToken: 'rt',
        snapshot: fakeSnapshot(),
        scoreResult: fakeScore(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('submitted'));
    expect(result.current.verdict).toBe('rejected');
  });

  it('중복 제출하지 않는다(재렌더에도 1회만 호출)', async () => {
    submitChaseRunMock.mockResolvedValue({
      verdict: 'valid', score: 100, pi: 480, cpm: 480, accMilli: 1000, grade: 'A', completed: false,
      rank: null, total: null, isPersonalBest: null, newUnlocks: [], shareText: null, shareId: null,
    });
    act(() => useAuthStore.getState().login(loginSession()));

    const snapshot = fakeSnapshot();
    const scoreResult = fakeScore();
    const { result, rerender } = renderHook(
      (props: { s: ChaseSnapshot }) =>
        useChaseSubmission({ engine: fakeEngine(), runToken: 'rt', snapshot: props.s, scoreResult }),
      { initialProps: { s: snapshot } },
    );
    await waitFor(() => expect(result.current.status).toBe('submitted'));
    rerender({ s: snapshot });
    rerender({ s: snapshot });

    expect(submitChaseRunMock).toHaveBeenCalledTimes(1);
  });
});
