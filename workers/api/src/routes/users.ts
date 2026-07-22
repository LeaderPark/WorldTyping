// spec: docs/06 §4.3(아바타=여권 커버, GET /api/users/:id/passport KV 60s 캐시 전문), docs/01
//       §9.3(언락 트리)·§9.4(커버 12종 — "커버 선택은 획득분만"), docs/00 §11-D9(06 canonical) +
//       WT-M5-03
//
// GET /users/:id/passport — 공개 프로필(여권) 조회. 로그인 불필요(팀원/랭킹 상대 프로필도
// 봐야 하는 공개 정보라 requireAuth를 걸지 않는다 — lb.ts의 GET /lb와 동일 공개 조회 원칙).
// PUT /users/me/passport-cover — 본인 커버 선택. 산출물 목록에 명시되진 않았으나 "커버 선택
// (획득분만)" UI(PassportPage)가 실제로 동작하려면 서버 측 반영 경로가 필요해 이 파일에 추가한다
// (같은 라우트 파일 — 별도 산출물로 취급하지 않음, 최종 보고 notes 참조).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { UserRow, UserUnlockRow } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { GRANTABLE_COVERS } from "../lib/achievements";

const PASSPORT_CACHE_TTL_SEC = 60;

export interface PassportUnlock {
  type: UserUnlockRow["unlock_type"];
  id: string;
  meta: unknown;
  createdAt: number;
}

export interface PassportRes {
  userId: string;
  nickname: string;
  passportCover: string;
  streakDaily: number;
  bestPi: number | null;
  unlocks: PassportUnlock[];
}

export const users = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ───────────────────────── GET /users/:id/passport ─────────────────────────

users.get("/users/:id/passport", async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const userId = c.req.param("id");

  if (c.env.KV) {
    const cached = await c.env.KV.get(KV_KEYS.passport(userId));
    if (cached) {
      c.header("Cache-Control", "public, max-age=60");
      return c.json(JSON.parse(cached) as PassportRes);
    }
  }

  const user = await db
    .prepare(`SELECT user_id, nickname, passport_cover, streak_daily FROM users WHERE user_id = ?1 AND status != 'deleted'`)
    .bind(userId)
    .first<Pick<UserRow, "user_id" | "nickname" | "passport_cover" | "streak_daily">>();
  if (!user) throw new ApiHttpError(404, "NOT_FOUND", "유저를 찾을 수 없습니다.");

  const bestPiRow = await db
    .prepare(`SELECT MAX(pi) AS best_pi FROM runs WHERE user_id = ?1 AND verdict = 'valid'`)
    .bind(userId)
    .first<{ best_pi: number | null }>();

  const { results: unlockRows } = await db
    .prepare(
      `SELECT unlock_type, unlock_id, meta_json, created_at FROM user_unlocks WHERE user_id = ?1 ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all<UserUnlockRow>();

  const body: PassportRes = {
    userId: user.user_id,
    nickname: user.nickname,
    passportCover: user.passport_cover,
    streakDaily: user.streak_daily,
    bestPi: bestPiRow?.best_pi ?? null,
    unlocks: unlockRows.map((r) => ({
      type: r.unlock_type,
      id: r.unlock_id,
      meta: r.meta_json ? (JSON.parse(r.meta_json) as unknown) : null,
      createdAt: r.created_at,
    })),
  };

  if (c.env.KV) {
    await c.env.KV.put(KV_KEYS.passport(userId), JSON.stringify(body), {
      expirationTtl: PASSPORT_CACHE_TTL_SEC,
    });
  }
  c.header("Cache-Control", "public, max-age=60");
  return c.json(body);
});

// ───────────────────────── PUT /users/me/passport-cover ─────────────────────────

const PassportCoverReqSchema = z.object({ coverId: z.string().min(1).max(64) }).strict();

/** 가입 시 기본 지급(unlock 테이블에 올라가지 않음, session.ts insertNewUser 참조). */
const DEFAULT_COVER = "basic-green";

users.put("/users/me/passport-cover", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const pid = c.get("pid");

  const parsed = PassportCoverReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "coverId가 필요합니다.");
  const { coverId } = parsed.data;

  if (coverId !== DEFAULT_COVER) {
    if (!GRANTABLE_COVERS.includes(coverId as (typeof GRANTABLE_COVERS)[number])) {
      throw new ApiHttpError(400, "INVALID_COVER", "존재하지 않는 커버입니다.");
    }
    const owned = await db
      .prepare(`SELECT 1 FROM user_unlocks WHERE user_id = ?1 AND unlock_type = 'cover' AND unlock_id = ?2`)
      .bind(pid, `cover:${coverId}`)
      .first();
    if (!owned) throw new ApiHttpError(403, "COVER_NOT_OWNED", "아직 획득하지 않은 커버입니다.");
  }

  const now = Date.now();
  await db
    .prepare(`UPDATE users SET passport_cover = ?2, updated_at = ?3 WHERE user_id = ?1`)
    .bind(pid, coverId, now)
    .run();

  if (c.env.KV) await c.env.KV.delete(KV_KEYS.passport(pid));

  return c.json({ passportCover: coverId });
});
