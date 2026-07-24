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
// 닉네임: Google name을 NICK_RE 형식으로 정제해 최초 생성 시 초기 닉네임으로 쓰고, nickname_norm
// UNIQUE 충돌 시 GUEST_xxxx와 동형의 USER_xxxx로 폴백 재시도(session.ts insertNewUser 선례). 비속어
// 콘텐츠 필터는 여기서 적용하지 않는다 — 실명 표시명이라 오탐 위험이 크고, 유저는 PUT /nickname(전체
// moderation 파이프라인)으로 언제든 변경 가능하다. 재로그인 시에는 기존 닉네임을 보존한다(유저가
// 커스터마이즈했을 수 있으므로 Google name으로 덮어쓰지 않는다).
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  derivePlayerId,
  deriveDeviceHash,
  signAccountSessionToken,
  SESSION_TTL_MS,
} from "@wt/shared";
import { NICK_RE, normalizeNickname } from "@wt/moderation/src/nickname";
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
 * Google 계정 ↔ users upsert(WT-AUTH-01). user_id/device_hash는 "google:"+sub에서 결정적 파생.
 *  - users: 신규면 INSERT(Google name 정제 닉네임), status='deleted'면 신규처럼 reactivate,
 *    기존 활성 계정이면 그대로(닉네임 보존).
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

const MAX_INSERT_ATTEMPTS = 5;

/**
 * Google name을 닉네임 형식(NICK_RE, docs/06 §4.2)으로 정제. 허용 문자만 남기고 연속 `_`/`-`를
 * 접고 양끝 `_`/`-`를 제거한 뒤 12자로 클램프한다. 결과가 NICK_RE(2~12자·한글/라틴 1자 이상)를
 * 통과하지 못하면 null(호출측이 USER_xxxx 폴백).
 */
function sanitizeNickname(name: string | undefined): string | null {
  if (!name) return null;
  const kept = Array.from(name.normalize("NFC"))
    .filter((ch) => /[가-힣a-zA-Z0-9_-]/u.test(ch))
    .join("");
  let s = kept.replace(/[_-]{2,}/g, "_").replace(/^[_-]+/, "").replace(/[_-]+$/, "");
  const cp = Array.from(s);
  if (cp.length > 12) s = cp.slice(0, 12).join("").replace(/[_-]+$/, "");
  return NICK_RE.test(s) ? s : null;
}

function randomAccountSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
}

/**
 * 신규 계정 유저 INSERT. 최초 닉네임 = 정제된 Google name(있으면), 없으면 USER_xxxx. nickname_norm
 * UNIQUE 충돌 시 USER_xxxx로 재시도(session.ts insertNewUser의 GUEST_ 재시도와 동형).
 */
async function insertAccountUser(
  db: D1Database,
  userId: string,
  deviceHash: string,
  geo: string | null,
  googleName: string | undefined,
  now: number,
): Promise<UserRow> {
  const base = sanitizeNickname(googleName);
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const nickname = attempt === 0 && base ? base : `USER_${randomAccountSuffix()}`;
    const norm = normalizeNickname(nickname);
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
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE/i.test(msg)) throw err;
      // user_id(PK) 충돌 → 동시 요청이 이미 만든 행을 그대로 쓴다(멱등).
      const existing = await selectUser(db, userId);
      if (existing) return existing;
      // 아니면 nickname_norm 충돌 — 접미사를 바꿔 재시도.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("insertAccountUser: exhausted retries");
}

/**
 * 삭제된 계정을 재로그인으로 "사실상 신규 계정" 복원(session.ts reactivateDeletedUser와 동일 정책).
 * 닉네임은 Google name 재정제로 초기화한다(삭제 시 익명 닉네임으로 바뀌었으므로).
 */
async function reactivateAccountUser(
  db: D1Database,
  userId: string,
  deviceHash: string,
  geo: string | null,
  googleName: string | undefined,
  now: number,
): Promise<UserRow> {
  const base = sanitizeNickname(googleName);
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const nickname = attempt === 0 && base ? base : `USER_${randomAccountSuffix()}`;
    const norm = normalizeNickname(nickname);
    try {
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
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE/i.test(msg)) throw err;
      // nickname_norm 충돌 — 접미사를 바꿔 재시도.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("reactivateAccountUser: exhausted retries");
}
