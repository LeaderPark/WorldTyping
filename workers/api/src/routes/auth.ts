// spec: docs/00 §11-D68(계정 로그인 하이브리드)·docs/04 §2.2-#17/#18·§5.5(계정 계층) + WT-AUTH-01
//
// POST /auth/google — Google GIS ID-token(credential) 검증 → 계정 upsert → 계정 세션 토큰(wt1,
//   acct:1) 발급. 비인증(토큰 발급 전) + RL 'auth'(10/60s/IP).
// POST /auth/dev — 테스트 심(§11-D68-⑩). ENVIRONMENT==='dev'에서만 활성, 그 외 404. Google JWKS
//   검증을 우회해 {sub,name?,email?}로 곧장 동일 upsert 경로를 태운다(pool-workers/E2E가 계정
//   세션을 발급받기 위한 유일한 수단 — 실 Google 토큰을 테스트에서 만들 수 없기 때문).
//
// 신원 파생(docs/04 §5.5, D38 승계): 계정 user_id = derivePlayerId(SESSION_HMAC_SECRET,"google:"+sub),
// device_hash = deriveDeviceHash(SESSION_HMAC_SECRET,"google:"+sub). sub당 결정적이라 재로그인 멱등.
//
// 닉네임(WT-FIX-GOOGLENAME, §11 후속): Google 표시명을 최소 정제(sanitizeNickname)해 그대로 표시명
// 으로 쓴다 — ID형 값(USER_xxxx) 부여는 하지 않는다. 계정 유저의 nickname_norm은 `u#${userId}`로
// 고정한다(user_id가 PK라 구조적으로 항상 유일 — 표시명 중복은 전역 허용). NICK_RE/normalizeNickname
// 검사는 적용하지 않는다: 실명 표시명이라 오탐·강제 축약 위험이 크고, 유일성 판정도 더 이상 필요
// 없다(PUT /nickname은 D88로 클라 미사용이지만 API는 존치, 전체 moderation 파이프라인은 그 경로가
// 그대로 담당). 재로그인 시 정제된 Google 이름이 저장된 nickname과 다르면 자동 재동기화한다 — 과거
// USER_xxxx 폴백으로 강등됐던 계정도 다음 로그인에 원래 이름으로 치유된다.
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  derivePlayerId,
  deriveDeviceHash,
  signAccountSessionToken,
  SESSION_TTL_MS,
} from "@wt/shared";
import type { Env } from "../env";
import type { UserRow } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { getGeoCountry } from "../lib/ip-hash";
import { verifyGoogleIdToken, type GoogleIdentity } from "../lib/google-idtoken";
import { rateLimit } from "../mw/ratelimit";
import type { AuthVariables } from "../mw/auth";

type AuthEnv = { Bindings: Env; Variables: Partial<AuthVariables> };

export const auth = new Hono<AuthEnv>();

const GoogleReqSchema = z.object({ credential: z.string().min(1).max(8192) }).strict();

const DevReqSchema = z
  .object({
    sub: z.string().min(1).max(255),
    name: z.string().max(255).optional(),
    email: z.string().max(320).optional(),
  })
  .strict();

/** 계정 로그인 응답(계정 프로필 + 세션 토큰). SessionRes와 동형 + acct:true. */
interface AuthRes {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
  /** 가입 시 CF-IPCountry(§11-D44). 미확보 "XX". */
  geo: string;
  acct: true;
  /** email_verified인 경우에만. */
  email?: string;
}

// ───────────────────────── POST /auth/google ─────────────────────────

auth.post("/auth/google", rateLimit("auth"), async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");

  const parsed = GoogleReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "credential(Google ID-token)이 필요합니다.");

  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "GOOGLE_CLIENT_ID not configured");

  const result = await verifyGoogleIdToken(parsed.data.credential, { clientId, kv: c.env.KV });
  if (!result.ok) {
    // 검증 실패 세부(reason)는 메시지에만 — 401 단일 코드로 접는다(mw/auth requireAuth와 동일 톤).
    throw new ApiHttpError(401, "INVALID_TOKEN", `Google ID-token rejected (${result.reason})`);
  }

  return c.json(await issueAccountSession(c, result.identity));
});

// ───────────────────────── POST /auth/dev (dev 전용 테스트 심) ─────────────────────────

auth.post("/auth/dev", async (c) => {
  // §11-D68-⑩: dev에서만 활성. 그 외(staging/prod)는 라우트가 존재하지 않는 것처럼 404 — 어떤
  // DB 접근·검증보다 먼저 막는다.
  if (c.env.ENVIRONMENT !== "dev") {
    throw new ApiHttpError(404, "NOT_FOUND", `Route not found: ${c.req.method} ${c.req.path}`);
  }
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");

  const parsed = DevReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "sub가 필요합니다.");

  const identity: GoogleIdentity = {
    sub: parsed.data.sub,
    name: parsed.data.name,
    email: parsed.data.email,
    // dev 심은 항상 email_verified로 취급(email이 있으면 저장) — 테스트 단순화.
    emailVerified: parsed.data.email !== undefined,
  };
  return c.json(await issueAccountSession(c, identity));
});

// ───────────────────────── 공통 upsert + 토큰 발급 ─────────────────────────

/**
 * 검증된 Google 신원으로 계정을 upsert하고 계정 세션 토큰 + 프로필을 조립한다. /auth/google와
 * /auth/dev가 공유하는 유일한 발급 경로(둘의 차이는 신원 획득 방식뿐).
 */
async function issueAccountSession(c: Context<AuthEnv>, identity: GoogleIdentity): Promise<AuthRes> {
  const db = c.env.DB;
  const secret = c.env.SESSION_HMAC_SECRET;
  const now = Date.now();
  const geo = getGeoCountry(c);

  const user = await upsertGoogleAccount(db, secret, geo, identity, now);

  const token = await signAccountSessionToken(secret, user.user_id, now);
  const res: AuthRes = {
    token,
    playerId: user.user_id,
    nickname: user.nickname,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    geo: user.geo ?? "XX",
    acct: true,
  };
  if (identity.email) res.email = identity.email;
  return res;
}

/**
 * Google 계정 ↔ users upsert(WT-AUTH-01, WT-FIX-GOOGLENAME). user_id/device_hash는
 * "google:"+sub에서 결정적 파생.
 *  - users: 신규면 INSERT(Google name 정제 닉네임), status='deleted'면 신규처럼 reactivate,
 *    기존 활성 계정이면 정제된 Google 이름으로 재동기화(다르면만 UPDATE — resyncAccountNickname).
 *  - auth_identities(0005): (provider,subject) upsert — email(검증 시만)/name/last_login 갱신.
 */
export async function upsertGoogleAccount(
  db: D1Database,
  secret: string,
  geo: string | null,
  identity: GoogleIdentity,
  now: number,
): Promise<UserRow> {
  const derivInput = "google:" + identity.sub;
  const userId = await derivePlayerId(secret, derivInput);
  const deviceHash = await deriveDeviceHash(secret, derivInput);

  let user = await selectUser(db, userId);
  if (!user) {
    user = await insertAccountUser(db, userId, deviceHash, geo, identity.name, now);
  } else if (user.status === "deleted") {
    // 삭제된 계정으로 재로그인 — session.ts reactivateDeletedUser와 동일 정책으로 "사실상 신규
    // 계정" 복원(닉네임/스트릭/커버 초기화, device_hash 재파생). auth_identities 행은 DELETE
    // /users/me 시점에 함께 삭제됐으므로 아래 upsert가 새로 만든다.
    user = await reactivateAccountUser(db, userId, deviceHash, geo, identity.name, now);
  } else {
    // 기존 활성 계정 재로그인 — 정제된 Google 이름으로 닉네임을 자동 치유(§11 후속). 과거
    // USER_xxxx 폴백으로 강등됐던 계정도 다음 로그인에 원래 이름으로 복원된다.
    user = await resyncAccountNickname(db, user, identity.name, now);
  }

  const email = identity.emailVerified ? (identity.email ?? null) : null;
  await db
    .prepare(
      `INSERT INTO auth_identities (provider, subject, user_id, email, name, created_at, last_login)
       VALUES ('google', ?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(provider, subject) DO UPDATE SET
         email = excluded.email, name = excluded.name, last_login = excluded.last_login`,
    )
    .bind(identity.sub, userId, email, identity.name ?? null, now)
    .run();

  return user;
}

// ───────────────────────── 내부 헬퍼(session.ts 패턴 계승) ─────────────────────────

async function selectUser(db: D1Database, userId: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT user_id, device_hash, nickname, nickname_norm, passport_cover, geo, status,
              streak_daily, streak_updated, created_at, updated_at
         FROM users WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<UserRow>();
  return row ?? null;
}

/** sanitizeNickname 결과가 빈 문자열일 때의 상수 폴백(랜덤 접미사 금지 — 표시명 중복이 전역
 *  허용이므로 상수 하나로 충분하다). */
const ACCOUNT_NICKNAME_FALLBACK = "PLAYER";

/**
 * Google 표시명을 계정 닉네임으로 그대로 쓰기 위한 최소 정제(WT-FIX-GOOGLENAME). NFC 정규화 후
 * 모든 스크립트의 문자·숫자(\p{L}\p{M}\p{N})와 공백/`_`/`-`만 남긴다(제어·포맷 문자·이모지·기호는
 * 이 화이트리스트에 들지 않으므로 자연히 제거된다) → 연속 공백을 1개로 접기 → trim → 코드포인트
 * 12자로 클램프(클램프 경계에 남는 공백도 다시 trim). NICK_RE 검사는 하지 않는다(실명 표시명 정책
 * — docs/06 §4.2의 형식 제약은 게스트/PUT-닉네임 경로 소유). 결과가 빈 문자열이면
 * ACCOUNT_NICKNAME_FALLBACK.
 */
function sanitizeNickname(name: string | undefined): string {
  if (!name) return ACCOUNT_NICKNAME_FALLBACK;
  const kept = Array.from(name.normalize("NFC"))
    .filter((ch) => /[\p{L}\p{M}\p{N} _-]/u.test(ch))
    .join("");
  const collapsed = kept.replace(/ {2,}/g, " ").trim();
  const cp = Array.from(collapsed);
  const clamped = (cp.length > 12 ? cp.slice(0, 12).join("") : collapsed).trim();
  return clamped.length > 0 ? clamped : ACCOUNT_NICKNAME_FALLBACK;
}

/**
 * 계정 유저의 nickname_norm. user_id(PK)에서 결정적으로 파생해 `u#` 프리픽스를 붙인다 — user_id가
 * 구조적으로 항상 유일하므로 이 값도 항상 유일하고, 표시명(nickname) 자체의 중복은 전역 허용된다
 * (실명 정책이라 두 유저가 같은 Google 이름을 가질 수 있다). `u#` 프리픽스는 게스트 경로의
 * normalizeNickname(원문 NFC lowercase) 출력과 형태가 겹치지 않는다(원문 닉네임은 2~12자 한글/
 * 라틴/숫자/`_`/`-`만 허용되어 `#`을 포함할 수 없다 — NICK_RE).
 */
function accountNicknameNorm(userId: string): string {
  return `u#${userId}`;
}

/**
 * 신규 계정 유저 INSERT. 닉네임 = 정제된 Google name(sanitizeNickname, 없으면 PLAYER). nickname_norm
 * 은 user_id 기반이라 더 이상 충돌하지 않는다 — 남는 것은 user_id(PK) 충돌뿐이며, 동시 요청이 이미
 * 만든 행을 그대로 쓰는 멱등 처리로 해소한다(session.ts insertNewUser 선례).
 */
async function insertAccountUser(
  db: D1Database,
  userId: string,
  deviceHash: string,
  geo: string | null,
  googleName: string | undefined,
  now: number,
): Promise<UserRow> {
  const nickname = sanitizeNickname(googleName);
  const norm = accountNicknameNorm(userId);
  try {
    await db
      .prepare(
        `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, geo, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(userId, deviceHash, nickname, norm, geo, now)
      .run();
    return {
      user_id: userId,
      device_hash: deviceHash,
      nickname,
      nickname_norm: norm,
      passport_cover: "basic-green",
      geo,
      status: "active",
      streak_daily: 0,
      streak_updated: null,
      created_at: now,
      updated_at: now,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE/i.test(msg)) throw err;
    // user_id(PK) 충돌 → 동시 요청이 이미 만든 행을 그대로 쓴다(멱등).
    const existing = await selectUser(db, userId);
    if (existing) return existing;
    throw err;
  }
}

/**
 * 삭제된 계정을 재로그인으로 "사실상 신규 계정" 복원(session.ts reactivateDeletedUser와 동일 정책).
 * 닉네임은 Google name 재정제로 초기화한다(삭제 시 익명 닉네임으로 바뀌었으므로). nickname_norm이
 * user_id 기반이라 이 UPDATE는 UNIQUE 충돌이 구조적으로 불가능하다(재시도 불필요).
 */
async function reactivateAccountUser(
  db: D1Database,
  userId: string,
  deviceHash: string,
  geo: string | null,
  googleName: string | undefined,
  now: number,
): Promise<UserRow> {
  const nickname = sanitizeNickname(googleName);
  const norm = accountNicknameNorm(userId);
  await db
    .prepare(
      `UPDATE users SET device_hash = ?2, nickname = ?3, nickname_norm = ?4, geo = ?5,
              passport_cover = 'basic-green', status = 'active', streak_daily = 0,
              streak_updated = NULL, updated_at = ?6
         WHERE user_id = ?1`,
    )
    .bind(userId, deviceHash, nickname, norm, geo, now)
    .run();
  const updated = await selectUser(db, userId);
  if (!updated) throw new Error("reactivateAccountUser: row vanished after UPDATE");
  return updated;
}

/**
 * 기존 활성 계정 재로그인 시 닉네임 자동 재동기화(WT-FIX-GOOGLENAME). 정제된 Google 이름이 저장된
 * nickname과 다를 때만 nickname·nickname_norm(u#userId)·updated_at을 UPDATE한다 — 과거 USER_xxxx
 * 폴백으로 강등됐던 계정이 다음 로그인에 자동으로 치유된다. 클라는 서버 응답 nickname을 그대로
 * 쓰므로 이 계층 위에 별도 반영 로직이 필요 없다. 같으면(대부분의 재로그인) DB 쓰기를 하지 않는다.
 */
async function resyncAccountNickname(
  db: D1Database,
  user: UserRow,
  googleName: string | undefined,
  now: number,
): Promise<UserRow> {
  const nickname = sanitizeNickname(googleName);
  if (nickname === user.nickname) return user;
  const norm = accountNicknameNorm(user.user_id);
  await db
    .prepare(`UPDATE users SET nickname = ?2, nickname_norm = ?3, updated_at = ?4 WHERE user_id = ?1`)
    .bind(user.user_id, nickname, norm, now)
    .run();
  return { ...user, nickname, nickname_norm: norm, updated_at: now };
}
