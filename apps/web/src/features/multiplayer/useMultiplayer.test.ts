// @vitest-environment jsdom
// spec: docs/05 §7.2(재접속), docs/00 §11-D89(WS 재연결 신규 티켓 재발급 + 터미널 중단).
// 재연결 배선의 순수 판별기 2종을 단위 검증한다(비동기 훅 배선은 e2e E6/E7이 커버).
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../net/api-client';
import { isTerminalRejoinError, shouldRetryHelloNoResume } from './useMultiplayer';

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
