// spec: docs/04 §2.1(공통 규약)·§2.3-1(SessionReq/Res)·§5(신원/세션 모델 전문)·§6.5(레이트리밋),
//       docs/06 §4.1(bootstrap 의미론 — 없으면 생성 + 기본 닉네임 GUEST_{4자리}),
//       docs/00 §11-D10(device_hash 절충)·D11(wt1. 30일 rolling) + WT-M3-02
//
// POST /api/v1/session — 익명 신원 부트스트랩/갱신. deviceId 원문은 응답 조립이 끝나는 즉시
// 스코프를 벗어나며, 어디에도 로그·저장하지 않는다(derive.ts로 파생된 값만 다룬다).
//
// 설계 메모(§11 미확정 사항 중 코드가 내린 구현 결정 — 최종 보고 notes에도 요약):
//   users.user_id를 playerId(pid)와 동일값으로 둔다. pid = base58(HMAC(secret,"pid:"+deviceId))
//   [0:12]는 이미 결정적·사실상 유일하고, docs/04 §6.2 검증 파이프라인 1단계가
//   `token.pid === session.pid`를 그대로 D1 FK로 재사용할 것을 전제하므로(§6.1 runToken.pid),
//   user_id를 별도의 랜덤 UUIDv7로 두면 pid↔user_id 매핑 테이블이 추가로 필요해진다.
//   device_hash는 §11-D10이 요구하는 별도 파생값 그대로 유지·저장한다(도메인 분리, derive.ts).
//
// GET /api/v1/session/me — 이 태스크(WT-M3-02) 산출물 중 하나. docs/04 §2.2 표에는 없는 추가
// 엔드포인트지만, 이 마일스톤에는 mw/auth.ts를 실제로 거치는 다른 보호 라우트가 아직 없어
// (runs/nickname/rooms는 WT-M3-03+) acceptance의 "Bearer로 보호 라우트 접근 확인"을 검증할
// 대상이 필요하다. 세션 자기 조회는 부작용 없는 최소 라우트라 이 목적에 적합하다.
import { Hono } from "hono";
import { z } from "zod";
import { derivePlayerId, deriveDeviceHash, signSessionToken, verifyToken, SessionPayloadSchema, SESSION_TTL_MS } from "@wt/shared";
import type { Env } from "../env";
import type { UserRow } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { getClientIp, getGeoCountry, hashIp } from "../lib/ip-hash";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_PID_ABUSE_WINDOW_SEC = 60 * 60; // 1시간(docs/04 §10.3)
const NEW_PID_ABUSE_MAX = 20; // 동일 IP 해시 시간당 신규 pid 생성 상한
const BLOCK_IP_TTL_SEC = 24 * 60 * 60; // 24h

const SessionReqSchema = z
  .object({
    deviceId: z.string().uuid(),
    prevToken: z.string().min(1).max(1024).optional(),
  })
  .strict();

interface SessionRes {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
}

export const session = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

session.post("/session", rateLimit("session"), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = SessionReqSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "deviceId(UUIDv4)가 필요합니다.");
  }
  const { deviceId, prevToken } = parsed.data;

  const ipHash = await hashIp(getClientIp(c));
  if (c.env.KV && (await c.env.KV.get(KV_KEYS.blockIp(ipHash)))) {
    throw new ApiHttpError(403, "IP_BLOCKED", "이 네트워크에서의 신규 세션 발급이 일시 차단되었습니다.");
  }

  const pid = await derivePlayerId(c.env.SESSION_HMAC_SECRET, deviceId);
  const deviceHash = await deriveDeviceHash(c.env.SESSION_HMAC_SECRET, deviceId);

  // prevToken은 실패해도 요청 전체를 실패시키지 않는다 — "잘못된 prevToken 무시하고 deviceId
  // 재발급 경로"(WT-M3-02 구현 지시 #4). pid가 이 deviceId 파생값과 다르면 신뢰하지 않는다.
  let prevPayload: { pid: string; iat: number; exp: number } | undefined;
  if (prevToken) {
    const verified = await verifyToken(
      prevToken,
      [c.env.SESSION_HMAC_SECRET, c.env.SESSION_HMAC_SECRET_PREV],
      SessionPayloadSchema,
    );
    if (verified.ok && verified.payload.pid === pid) {
      prevPayload = verified.payload;
    }
  }

  const db = c.env.DB;
  if (!db) {
    throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  }

  let user = await selectUser(db, pid);
  let isNewUser = false;

  if (!user) {
    if (c.env.KV) {
      const blocked = await bumpNewPidAbuseCounter(c.env.KV, ipHash);
      if (blocked) {
        throw new ApiHttpError(
          403,
          "IP_BLOCKED",
          "이 네트워크에서 신규 세션 발급이 시간당 한도를 초과해 24시간 차단되었습니다.",
        );
      }
    }
    user = await insertNewUser(db, pid, deviceHash, getGeoCountry(c), Date.now());
    isNewUser = true;
  }

  const now = Date.now();
  let token: string;
  let expiresAtMs: number;

  if (prevPayload && !isNewUser) {
    const remaining = prevPayload.exp - now;
    if (remaining < SEVEN_DAYS_MS) {
      token = await signSessionToken(c.env.SESSION_HMAC_SECRET, pid, now);
      expiresAtMs = now + SESSION_TTL_MS;
    } else {
      token = prevToken as string;
      expiresAtMs = prevPayload.exp;
    }
  } else {
    token = await signSessionToken(c.env.SESSION_HMAC_SECRET, pid, now);
    expiresAtMs = now + SESSION_TTL_MS;
  }

  const body: SessionRes = {
    token,
    playerId: pid,
    nickname: user.nickname,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return c.json(body);
});

// docs/04 §2.2에는 없는 추가 엔드포인트 — 파일 상단 주석 참조(보호 라우트 자기 검증용).
session.get("/session/me", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) {
    throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  }
  const pid = c.get("pid");
  const row = await db
    .prepare("SELECT user_id, nickname, status FROM users WHERE user_id = ?1")
    .bind(pid)
    .first<Pick<UserRow, "user_id" | "nickname" | "status">>();
  if (!row) {
    throw new ApiHttpError(404, "NOT_FOUND", "세션 pid에 해당하는 유저를 찾을 수 없습니다.");
  }
  return c.json({ playerId: row.user_id, nickname: row.nickname, status: row.status });
});

// ───────────────────────── 내부 헬퍼 ─────────────────────────

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

function nicknameNorm(nickname: string): string {
  return nickname.normalize("NFC").toLowerCase();
}

function randomGuestSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
}

const MAX_INSERT_ATTEMPTS = 5;

/**
 * 신규 유저 INSERT. 기본 닉네임 "GUEST_xxxx"(docs/06 §4.1)는 nickname_norm UNIQUE 제약과
 * 충돌할 수 있어(희박하지만 pid 접미사 재사용 가능성) 접미사를 바꿔가며 재시도한다.
 */
async function insertNewUser(
  db: D1Database,
  userId: string,
  deviceHash: string,
  geo: string | null,
  now: number,
): Promise<UserRow> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 0 ? userId.slice(-4).toUpperCase() : randomGuestSuffix();
    const nickname = `GUEST_${suffix}`;
    const norm = nicknameNorm(nickname);
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
      // user_id(PK) 충돌이면 동시 요청이 먼저 만든 행이 있다는 뜻 — 그 행을 그대로 쓴다.
      const existing = await selectUser(db, userId);
      if (existing) return existing;
      // 아니면 nickname_norm 충돌 — 접미사를 바꿔 재시도.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("insertNewUser: exhausted retries");
}

/**
 * 시간당 신규 pid 생성 카운터(docs/04 §10.3). 한도 초과 시 blk:ip:{hash}를 24h로 세팅하고
 * true(차단됨)를 반환한다 — 이 요청 자체도 거부한다(한도를 넘긴 요청부터 차단).
 */
async function bumpNewPidAbuseCounter(kv: KVNamespace, ipHash: string): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / NEW_PID_ABUSE_WINDOW_SEC) * NEW_PID_ABUSE_WINDOW_SEC;
  const key = KV_KEYS.rateLimit("session:new-pid", ipHash, windowStart);
  const raw = await kv.get(key);
  const count = raw ? Number(raw) : 0;

  if (count >= NEW_PID_ABUSE_MAX) {
    await kv.put(KV_KEYS.blockIp(ipHash), "1", { expirationTtl: BLOCK_IP_TTL_SEC });
    return true;
  }

  await kv.put(key, String(count + 1), { expirationTtl: NEW_PID_ABUSE_WINDOW_SEC + 5 });
  return false;
}
