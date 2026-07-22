// spec: docs/05 §2.2(방 코드 — 31자 알파벳 6자리·crypto.getRandomValues·claim 재시도 ×5·
//       하이픈/공백 제거+대문자화 정규화·3-3 하이픈 표시), docs/00 §11-D17(31자 알파벳 6자리 확정)
//       + WT-M4-02
//
// 방 코드 순수 유틸(생성·정규화·표시)과 MatchRoom DO에 대한 claim(충돌 회피 발급)만 담당한다.
// 혼동 문자(0/O/1/I/L) 제외 31자라 31⁶ ≈ 8.9×10⁸ 공간 — 충돌 확률은 사실상 0이지만, CLOSED 후
// 코드 재사용 가능성(§2.1)이 있어 발급 시 대상 DO의 활성 여부를 조회해 재시도한다.

/** 혼동 문자(0/O/1/I/L) 제외 31자 알파벳(§2.2, §11-D17). 순서·구성 변경 금지 — 코드 유효성 판정에 쓰인다. */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

const ALPHABET_SET = new Set(ROOM_CODE_ALPHABET.split(''));

/**
 * 6자 방 코드 1개를 생성한다. crypto.getRandomValues 바이트를 거부 표집(rejection sampling)해
 * 31개 알파벳에 균등 분포시킨다(256 % 31 편향 제거 — 248 이상 바이트 버림).
 *
 * @param randomBytes 테스트 주입용. 기본은 crypto.getRandomValues. 충돌 재시도 경로를 결정적으로
 *   재현할 수 있도록 seam을 연다(생산은 항상 crypto).
 */
export function generateRoomCode(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const out: string[] = [];
  while (out.length < ROOM_CODE_LENGTH) {
    const chunk = randomBytes(ROOM_CODE_LENGTH);
    for (const b of chunk) {
      if (out.length >= ROOM_CODE_LENGTH) break;
      if (b >= 248) continue; // 248 = 31*8 — 이 이상은 버려 균등성 확보
      out.push(ROOM_CODE_ALPHABET[b % 31]!);
    }
  }
  return out.join('');
}

function defaultRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/**
 * 사용자 입력 방 코드 정규화(§2.2): 하이픈/공백 제거 + 대문자화. 정규화 결과가 6자·전부 알파벳
 * 집합이면 그 코드를, 아니면 null을 반환한다(호출측이 ROOM_NOT_FOUND로 처리).
 */
export function normalizeRoomCode(raw: string): string | null {
  const cleaned = raw.replace(/[-\s]/g, '').toUpperCase();
  if (cleaned.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET_SET.has(ch)) return null;
  return cleaned;
}

/** 표시용 3-3 하이픈("KX73QP" → "KX7-3QP"). 서버는 canonical(하이픈 없는) 코드만 저장한다. */
export function formatRoomCode(code: string): string {
  return code.length === ROOM_CODE_LENGTH ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** MatchRoom DO의 internal/room-status 응답 중 claim 판정에 쓰는 필드. */
interface RoomStatus {
  phase: string;
  roomCode: string | null;
}

/**
 * 미사용(활성 방이 없는) 코드를 하나 발급한다. 대상 MatchRoom DO의 internal/room-status를 조회해
 * roomCode가 아직 null(= config 미생성 = 빈 방)인 코드만 채택한다(§2.2 "이미 활성이면 재생성").
 * 최대 maxTries회 시도 후에도 전부 충돌이면 throw(호출측이 500).
 *
 * 발급만 하고 internal/create는 호출측(Matchmaker/rooms 라우트)이 수행한다 — 이 함수는 코드 공간
 * 조회에만 관여한다. internal/create 자체가 멱등이라(config 있으면 기존 반환) claim↔create 사이의
 * 미세 경합도 상태를 오염시키지 않는다.
 */
export async function claimRoomCode(
  ns: DurableObjectNamespace,
  opts: { maxTries?: number; gen?: (randomBytes?: (n: number) => Uint8Array) => string } = {},
): Promise<string> {
  const maxTries = opts.maxTries ?? 5;
  const gen = opts.gen ?? ((): string => generateRoomCode());
  for (let i = 0; i < maxTries; i += 1) {
    const code = gen();
    const id = ns.idFromName('room:' + code);
    const stub = ns.get(id);
    const res = await stub.fetch('http://do/internal/room-status');
    if (!res.ok) continue;
    const status = (await res.json()) as RoomStatus;
    if (status.roomCode === null) return code; // 빈 슬롯 — 이 코드를 채택
  }
  throw new Error('room-code: exhausted claim retries (all candidates active)');
}
