// spec: docs/06 §1.4(조회 패턴 — keyset·rank-of-me·bypass)·§1.5(KV 1페이지/D1 커서·지역),
//       docs/00 §11-D9(06 canonical)·§11-D24(1분 dirty + 단일 KV lb:) + WT-M3-04
//
// GET /api/v1/lb        — Top-N 페이지. 커서·지역 없는 1페이지는 KV 히트 시 D1 미조회(§1.5),
//                         miss 시 D1 폴백 + 즉시 KV 백필. 커서/지역 페이지는 항상 D1 keyset.
// GET /api/v1/lb/me     — 내 순위/총원/백분위(§1.4-②). 제출 직후엔 no-cache 헤더로 bypass.
import { Hono } from "hono";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { requireAuth, type AuthVariables } from "../mw/auth";
import {
  LB_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  isValidBoardKey,
  queryPage,
  rankOfUser,
  readBoardCache,
  refreshBoardCache,
  type LbEntry,
  type PageResult,
} from "../lib/lb";

const GEO_RE = /^[A-Z]{2}$/;

export const lb = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ───────────────────────── GET /lb ─────────────────────────

lb.get("/lb", async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");

  const board = c.req.query("board");
  if (!board || !isValidBoardKey(board)) {
    throw new ApiHttpError(400, "INVALID_BOARD", "board 파라미터가 없거나 형식이 올바르지 않습니다.");
  }
  const cursorRaw = c.req.query("cursor");
  const geoRaw = c.req.query("geo");
  if (geoRaw !== undefined && !GEO_RE.test(geoRaw)) {
    throw new ApiHttpError(400, "INVALID_GEO", "geo는 ISO alpha-2 대문자 2자여야 합니다.");
  }
  const geo = geoRaw ?? null;

  // 커서·지역 없는 1페이지만 KV 경로(§1.5). 그 외는 항상 D1 keyset.
  if (!cursorRaw && !geo) {
    const served = await serveFirstPageFromCache(c.env, board);
    if (served) {
      c.header("Cache-Control", "public, max-age=60");
      return c.json(served);
    }
  }

  let after = null;
  if (cursorRaw) {
    after = decodeCursor(cursorRaw);
    if (!after) throw new ApiHttpError(400, "INVALID_CURSOR", "cursor가 유효하지 않습니다.");
  }
  const result = await queryPage(db, board, { after, geo });
  c.header("Cache-Control", "public, max-age=30");
  return c.json(result);
});

/**
 * KV `lb:{board}` 히트 시 캐시에서 1페이지 조립, miss 시 D1에서 top-100 백필 후 조립.
 * 총원 0이면 빈 페이지. 반환 null은 "캐시 경로로 서빙 불가"가 아니라 항상 결과를 준다
 * (여기선 null을 반환하지 않지만, 시그니처는 명시적 폴백 여지를 남긴다).
 */
async function serveFirstPageFromCache(env: Env, board: string): Promise<PageResult | null> {
  let cache = await readBoardCache(env.KV, board);
  if (!cache) {
    const total = await refreshBoardCache(env.DB, env.KV, board);
    if (total === 0) return { entries: [], nextCursor: null, total: 0 };
    cache = await readBoardCache(env.KV, board);
    if (!cache) return { entries: [], nextCursor: null, total: 0 };
  }
  return pageFromCacheEntries(cache.entries, cache.total);
}

function pageFromCacheEntries(entries: LbEntry[], total: number): PageResult {
  const page = entries.slice(0, LB_PAGE_SIZE);
  const hasNext = entries.length > LB_PAGE_SIZE;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last
      ? encodeCursor({ score: last.score, elapsedMs: last.elapsedMs, accMilli: last.accMilli, achievedAt: last.achievedAt })
      : null;
  return { entries: page, nextCursor, total };
}

// ───────────────────────── GET /lb/me ─────────────────────────

lb.get("/lb/me", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const pid = c.get("pid");

  const board = c.req.query("board");
  if (!board || !isValidBoardKey(board)) {
    throw new ApiHttpError(400, "INVALID_BOARD", "board 파라미터가 없거나 형식이 올바르지 않습니다.");
  }
  const geoRaw = c.req.query("geo");
  if (geoRaw !== undefined && !GEO_RE.test(geoRaw)) {
    throw new ApiHttpError(400, "INVALID_GEO", "geo는 ISO alpha-2 대문자 2자여야 합니다.");
  }

  const result = await rankOfUser(db, board, pid, geoRaw ?? null);

  // 제출 직후 요청은 캐시 bypass(§1.4-②) — 클라가 no-cache/fresh=1로 최신값을 강제.
  const bypass =
    c.req.query("fresh") === "1" || (c.req.header("Cache-Control")?.toLowerCase().includes("no-cache") ?? false);
  c.header("Cache-Control", bypass ? "private, no-store" : "private, max-age=60");
  return c.json(result);
});
