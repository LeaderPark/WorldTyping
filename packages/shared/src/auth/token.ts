// spec: docs/04 §5.2(세션 토큰 stateless HMAC 포맷)·§5.3(WS 티켓)·§6.1(runToken 페이로드)·
//       §7(키 로테이션 시 구/신 2키 7일 병행 검증), docs/00 §11-D11(wt1 30일 rolling 확정), WT-M1-04
//
// 클라·서버 공유 stateless 토큰 모듈. 포맷: "wt1.<payloadB64url>.<sigB64url>",
// sig = HMAC-SHA256(secret, "wt1." + payloadB64url).
//
// 키 용도 격리(docs/04 §7): secret은 항상 호출측 파라미터다. 세션 토큰은 SESSION_HMAC_SECRET,
// runToken/WS 티켓은 RUN_HMAC_SECRET으로 서명한다 — 이 모듈은 어느 시크릿을 쓸지 결정하지 않는다.

import { z } from 'zod';
import { base64urlToBytes, bytesToBase64url, bytesToUtf8, utf8ToBytes } from './base64url';
import { hmacSign, hmacVerify } from './hmac';
import type { GameMode } from '../types/game';

const PREFIX = 'wt1';

// ───────────────────────── 유효기간(TTL) ─────────────────────────
// docs/04: 세션 30일 · runToken +30분 · WS 티켓 +60초.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RUN_TOKEN_TTL_MS = 30 * 60 * 1000;
export const WS_TICKET_TTL_MS = 60 * 1000;

// ───────────────────────── 페이로드 3종 ─────────────────────────
// 타입 정의(interface)와 zod 스키마를 함께 두고, 컴파일 타임 Equal 단언으로 둘의 일치를 강제한다
// (protocol/schemas.ts와 동일 패턴). verifyToken은 호출측이 이 스키마 중 하나를 주입한다.

/**
 * 세션 토큰 페이로드. exp = iat + 30일.
 * acct: Google 로그인으로 발급된 "계정" 세션이면 1(docs/00 §11-D68, docs/04 §5.5). 게스트(익명
 * 디바이스) 세션은 이 필드가 없다 — 기존 게스트 토큰 하위호환을 위해 옵션 필드로 둔다. 랭킹 등재·
 * 멀티 REST는 acct 세션 전용(requireAccountAuth)이고, 게스트 세션도 싱글/데일리 플레이는 그대로다.
 */
export interface SessionPayload {
  v: 1;
  pid: string;
  iat: number;
  exp: number;
  acct?: 1;
}

/** 싱글 판 runToken 페이로드(docs/04 §6.1). exp = startTs + 30분. */
export interface RunTokenPayload {
  rid: string;
  pid: string;
  mode: GameMode;
  modeKey: string;
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  setHash: string;
  seed: string;
  startTs: number;
  exp: number;
}

/** WS 접속 1회용 티켓 페이로드(docs/04 §5.3). exp = iat + 60초. */
export interface WsTicketPayload {
  v: 1;
  pid: string;
  room: string;
  iat: number;
  exp: number;
}

export const SessionPayloadSchema = z
  .object({
    v: z.literal(1),
    pid: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    acct: z.literal(1).optional(),
  })
  .strict();

export const RunTokenPayloadSchema = z
  .object({
    rid: z.string().min(1),
    pid: z.string().min(1),
    // 'chase'(골드 러너, §11-D90)를 GameMode 유니온에 추가하면 하단 _CheckRunToken(Equal 컴파일 검증)이
    // 이 enum과 정확히 일치해야 하므로 여기도 반드시 동기화한다(WT-CH-02 — 유니온 확장이 auth를 자동
    // 수용하지 못하는 실제 좌표. 킷의 "auth 무수정" 전제 정정). chase runToken(CH-09) 검증에도 필수.
    mode: z.enum(['continent', 'tier', 'worldtour', 'daily', 'race', 'chase']),
    modeKey: z.string(),
    lang: z.enum(['ko', 'en']),
    platform: z.enum(['desktop', 'mobile']),
    setHash: z.string().min(1),
    seed: z.string().min(1),
    startTs: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export const WsTicketPayloadSchema = z
  .object({
    v: z.literal(1),
    pid: z.string().min(1),
    room: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

// 타입 ↔ 스키마 일치 컴파일 타임 검증(런타임 비용 0). 불일치 시 여기서 빌드가 깨진다.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _CheckSession = Assert<Equal<z.infer<typeof SessionPayloadSchema>, SessionPayload>>;
type _CheckRunToken = Assert<Equal<z.infer<typeof RunTokenPayloadSchema>, RunTokenPayload>>;
type _CheckWsTicket = Assert<Equal<z.infer<typeof WsTicketPayloadSchema>, WsTicketPayload>>;

// ───────────────────────── 서명 ─────────────────────────

/**
 * 페이로드에 wt1 HMAC 서명을 붙여 토큰 문자열을 만든다.
 * 제네릭 P는 { exp: number }를 요구한다 — exp 없는 페이로드는 검증 단계에서 무의미하기 때문.
 */
export async function signToken<P extends { exp: number }>(
  payload: P,
  secret: string,
): Promise<string> {
  const payloadB64 = bytesToBase64url(utf8ToBytes(JSON.stringify(payload)));
  const signingInput = PREFIX + '.' + payloadB64;
  const sig = await hmacSign(secret, signingInput);
  return signingInput + '.' + bytesToBase64url(sig);
}

// ───────────────────────── 검증 ─────────────────────────

export type VerifyFailReason = 'malformed' | 'bad_signature' | 'expired' | 'schema';

export type VerifyResult<P> =
  | { ok: true; payload: P }
  | { ok: false; reason: VerifyFailReason };

/** zod 스키마의 최소 인터페이스(호출측이 주입하는 검증기). */
export interface PayloadSchema<P> {
  safeParse(data: unknown): { success: true; data: P } | { success: false };
}

/**
 * 토큰 검증. 순서(docs/04 §5.2·§6.2-1 고정): ①포맷 파싱 ②서명(crypto.subtle.verify, 상수 시간)
 * ③exp 만료 ④zod 스키마(호출측 주입).
 *
 * 2키 병행: secrets에 [currentSecret, prevSecret?]를 넘기면 어느 하나로든 서명이 맞으면 통과한다
 * (로테이션 7일 병행, docs/04 §7). 단일 문자열도 허용한다.
 *
 * @param now 만료 기준 시각(기본 Date.now()). 테스트·시간 봉투 검사에서 주입 가능.
 */
export async function verifyToken<P extends { exp: number }>(
  token: string,
  secrets: string | ReadonlyArray<string | undefined>,
  schema: PayloadSchema<P>,
  now: number = Date.now(),
): Promise<VerifyResult<P>> {
  // ① 포맷 파싱: 정확히 "wt1.<payload>.<sig>" 3분절.
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;
  const signingInput = PREFIX + '.' + payloadB64;

  let sig: Uint8Array;
  try {
    sig = base64urlToBytes(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // ② 서명 검증: current → prev 순으로 시도(상수 시간 비교는 subtle.verify 내부).
  const secretList = typeof secrets === 'string' ? [secrets] : secrets;
  let sigOk = false;
  for (const secret of secretList) {
    if (!secret) continue;
    if (await hmacVerify(secret, signingInput, sig)) {
      sigOk = true;
      break;
    }
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  // 페이로드 역직렬화(서명이 맞았으므로 우리 발급분 — 그래도 방어적으로 파싱).
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(base64urlToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // ③ exp 만료 검사.
  const expRaw =
    typeof json === 'object' && json !== null ? (json as { exp?: unknown }).exp : undefined;
  if (typeof expRaw !== 'number' || expRaw <= now) {
    return { ok: false, reason: 'expired' };
  }

  // ④ zod 스키마(호출측 주입).
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'schema' };

  return { ok: true, payload: parsed.data };
}

// ───────────────────────── 편의 서명기(TTL 고정) ─────────────────────────
// 발급 시점의 iat/startTs + 규정 TTL로 exp를 계산해 오사용을 막는다. 시크릿은 여전히 호출측 주입.

/** 게스트(익명 디바이스) 세션 토큰 발급. exp = iat + 30일. secret = SESSION_HMAC_SECRET. */
export function signSessionToken(
  secret: string,
  pid: string,
  iat: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { v: 1, pid, iat, exp: iat + SESSION_TTL_MS };
  return signToken(payload, secret);
}

/**
 * 계정(Google 로그인) 세션 토큰 발급 — `acct: 1` 클레임을 실어 게스트 세션과 구별한다
 * (docs/00 §11-D68, docs/04 §5.5). exp = iat + 30일, secret = SESSION_HMAC_SECRET로 게스트와 동일.
 * pid는 계정 신원 파생값(derivePlayerId(secret, "google:" + sub))이 들어온다 — 이 함수는 pid를
 * 어떻게 파생하는지 알지 못하며, 게스트/계정의 유일한 차이는 이 클레임 하나다.
 */
export function signAccountSessionToken(
  secret: string,
  pid: string,
  iat: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { v: 1, pid, iat, exp: iat + SESSION_TTL_MS, acct: 1 };
  return signToken(payload, secret);
}

/** runToken 발급. exp = startTs + 30분. secret = RUN_HMAC_SECRET. */
export function signRunToken(
  secret: string,
  fields: Omit<RunTokenPayload, 'startTs' | 'exp'>,
  startTs: number = Date.now(),
): Promise<string> {
  const payload: RunTokenPayload = { ...fields, startTs, exp: startTs + RUN_TOKEN_TTL_MS };
  return signToken(payload, secret);
}

/** WS 티켓 발급. exp = iat + 60초. secret = RUN_HMAC_SECRET. */
export function signWsTicket(
  secret: string,
  pid: string,
  room: string,
  iat: number = Date.now(),
): Promise<string> {
  const payload: WsTicketPayload = { v: 1, pid, room, iat, exp: iat + WS_TICKET_TTL_MS };
  return signToken(payload, secret);
}
