// spec: docs/00 §11(문자열은 i18n 키 경유), workers/api/src/lib/api-error.ts(REST 코드)·
//       packages/shared/src/protocol/messages.ts(S2C_Error.code), WT-M4-04(작업 특이 조정 4 —
//       모든 문자열 i18n 키 경유)
//
// REST(ApiHttpError.code)와 WS(S2C_Error.code) 두 코드 공간은 서로 다르지만(예: ROOM_FULL은
// 겹치고 LANG_MISMATCH는 REST 전용), 화면(LobbyPage/RoomPage)에서 동일한 방식으로 i18n 키를
// 뽑아 쓸 수 있게 한 곳에 매핑을 모은다. 서버 원문 메시지(예: "방이 가득 찼습니다.")는 항상
// 한국어 고정 문자열이라 클라 표시에 직접 쓰지 않는다(§11 i18n 하드코딩 금지 원칙과 동일 취지).
const KNOWN_CODES = new Set([
  'BAD_MESSAGE',
  'ROOM_FULL',
  'ROOM_NOT_FOUND',
  'WRONG_PHASE',
  'NOT_HOST',
  'DATA_VERSION',
  'RATE_LIMIT',
  'AUTH_FAILED',
  'NICKNAME_INVALID',
  'LANG_MISMATCH',
  'ROOM_IN_PROGRESS',
  'ROOM_CODE_EXHAUSTED',
  'ROOM_CREATE_FAILED',
  'SERVICE_UNAVAILABLE',
  'INVALID_BODY',
  'MATCHMAKING_FAILED',
]);

/** 알 수 없는 코드는 'multi.error.generic'으로 폴백한다. */
export function multiErrorKey(code: string): string {
  if (!KNOWN_CODES.has(code)) return 'multi.error.generic';
  return `multi.error.${code.toLowerCase().replace(/_/g, '-')}`;
}
