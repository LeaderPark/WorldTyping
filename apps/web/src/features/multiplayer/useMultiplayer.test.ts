// @vitest-environment jsdom
// spec: docs/05 §7.2(재접속), docs/00 §11-D89(WS 재연결 신규 티켓 재발급 + 터미널 중단),
// WT-FIX-FINISH-TRANSITION(완주 후 결과 전환 이중 안전망 — 리매치 start 클리어 회귀).
// 재연결 배선의 순수 판별기 2종을 단위 검증한다(비동기 훅 배선은 e2e E6/E7이 커버) + routeMessage의
// 'start' 핸들러가 이전 레이스의 raceResult/raceFinishedReason을 클리어하는지는 아래 마지막
// describe에서 실제 훅(useMultiplayer)을 global.WebSocket 목으로 구동해 프로덕션 경로를 검증한다.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@wt/shared';
import { ApiError } from '../../net/api-client';
import { useMultiplayerStore } from '../../stores/multiplayer';
import { isTerminalRejoinError, shouldRetryHelloNoResume, useMultiplayer, type WsGrant } from './useMultiplayer';

describe('isTerminalRejoinError (§11-D89 터미널 분류)', () => {
  it('터미널 5코드(방 소멸/진행 중/만원/인증 소실)는 true', () => {
    for (const code of ['ROOM_NOT_FOUND', 'ROOM_IN_PROGRESS', 'ROOM_FULL', 'LOGIN_REQUIRED', 'INVALID_TOKEN']) {
      expect(isTerminalRejoinError(new ApiError(409, code, 'x'))).toBe(true);
    }
  });

  it('일시 실패 코드·비-ApiError는 false(백오프 지속 대상)', () => {
    expect(isTerminalRejoinError(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'))).toBe(false);
    expect(isTerminalRejoinError(new ApiError(429, 'RATE_LIMIT', 'x'))).toBe(false);
    expect(isTerminalRejoinError(new Error('network'))).toBe(false);
    expect(isTerminalRejoinError(null)).toBe(false);
  });
});

describe('shouldRetryHelloNoResume (§11-D89 AUTH_FAILED 무-resume 1회 재시도)', () => {
  it('AUTH_FAILED + 미재시도 + playerId 보유(resume 시도한 재접속) → true', () => {
    expect(shouldRetryHelloNoResume('AUTH_FAILED', false, true)).toBe(true);
  });

  it('이미 이번 연결에서 재시도했으면 false(루프 방지)', () => {
    expect(shouldRetryHelloNoResume('AUTH_FAILED', true, true)).toBe(false);
  });

  it('playerId가 없으면(resume 자격 없음) false', () => {
    expect(shouldRetryHelloNoResume('AUTH_FAILED', false, false)).toBe(false);
  });

  it('AUTH_FAILED가 아닌 코드는 false(기존 표출 경로로 폴스루)', () => {
    expect(shouldRetryHelloNoResume('ROOM_FULL', false, true)).toBe(false);
    expect(shouldRetryHelloNoResume('NICKNAME_INVALID', false, true)).toBe(false);
  });
});

// ───────────────────────── routeMessage: 결과 상태 클리어(WT-FIX-FINISH-TRANSITION) ─────────────────────────
//
// MatchRoom.finishRace()가 room-state 브로드캐스트를 빠뜨려 클라 room.phase가 'racing'에 고정되던
// 결함의 클라측 이중 안전망(RoomPage :196 raceFinishedReason 폴백)이 리매치에서 stale 결과를
// 재표출하지 않으려면, 'start'(새 레이스 시작 — 최초든 리매치든) 수신 시 이전 raceResult/
// raceFinishedReason이 반드시 클리어돼야 한다. WsManager의 기본 소켓 팩토리(new WebSocket(url))를
// 겨냥해 global.WebSocket을 목으로 바꿔치기하고, 실제 useMultiplayer 훅을 구동해 프로덕션
// routeMessage 경로 자체를 검증한다(재구현 아님).
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {
    /* 프레임 전송은 이 테스트의 관심사가 아니다 — 서버→클라 방향만 검증 */
  }
  close(): void {
    /* no-op */
  }
}

describe("routeMessage 'start' → raceResult/raceFinishedReason 클리어 (WT-FIX-FINISH-TRANSITION)", () => {
  let sockets: FakeSocket[] = [];
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    sockets = [];
    class TrackedFakeSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    // @ts-expect-error 테스트 목 — WebSocketLike를 구조적으로 만족(ws-manager.ts의 기본 팩토리 대상).
    globalThis.WebSocket = TrackedFakeSocket;
    useMultiplayerStore.getState().reset();
  });
  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
  });

  const GRANT: WsGrant = { roomCode: 'ABC123', wsUrl: '/ws/room/ABC123', ticket: 't1', lang: 'en', title: null };

  it('race-finished+results로 채워진 raceResult/raceFinishedReason이 리매치 start 수신 시 둘 다 null로 클리어된다', () => {
    const { result } = renderHook(() => useMultiplayer());
    act(() => {
      result.current.connectWithGrant(GRANT, { nickname: 'Tester', passportCover: 'basic-green' });
    });
    expect(sockets).toHaveLength(1);
    act(() => sockets[0]!.onopen?.());

    const send = (m: ServerMessage): void => {
      act(() => sockets[0]!.onmessage?.({ data: JSON.stringify(m) }));
    };

    // 1차 레이스 종료 — room-state(FINISHED) 유실을 가정해도(§11-D89 이중 안전망 전제) race-finished
    // +results만으로 스토어가 채워짐을 먼저 확인.
    send({ v: 1, type: 'race-finished', reason: 'all-finished' });
    send({ v: 1, type: 'results', raceId: 'r1', rows: [], rematchDeadline: Date.now() + 30_000 });
    expect(useMultiplayerStore.getState().raceFinishedReason).toBe('all-finished');
    expect(useMultiplayerStore.getState().raceResult).not.toBeNull();

    // 리매치 카운트다운(MatchRoom.startCountdown)의 'start' 브로드캐스트 — 이전 결과를 클리어해야
    // COUNTDOWN 인원 미달로 F8 취소(cancelCountdown → WAITING)돼도 stale 결과가 재표출되지 않는다.
    send({
      v: 1,
      type: 'start',
      raceId: 'r2',
      seed: '0'.repeat(32),
      countries: ['KR', 'US'],
      dataVersion: 'v1',
      startAt: Date.now() + 3000,
      hardCapAt: Date.now() + 183_000,
      perCountryLimitMs: 10_000,
    });
    expect(useMultiplayerStore.getState().raceResult).toBeNull();
    expect(useMultiplayerStore.getState().raceFinishedReason).toBeNull();
  });
});
