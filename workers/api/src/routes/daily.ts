// spec: docs/06 §2.1(세트 조회 계약 — KV 캐시 max-age=60)·§2.3(1일 1회·스트릭 필드), docs/00 §11-D21
//       (클라 계산 금지 — 세트는 서버 응답으로만), docs/07 WT-M3-05
//
// GET /daily/today — 오늘의 데일리 세트(공개, 비인증). KV daily:{date} 히트 시 D1 미조회, miss 시
//   ensureDailySeed로 즉석 발행(cron이 아직 안 돈 상태 폴백, 구현 세부 지시 2 — 레이스는
//   daily_challenges PK로 흡수).
// GET /daily/me — 이 유저가 오늘 데일리를 이미 정식 제출했는지(연습 모드 라벨용) + 현재 스트릭.
import { Hono } from "hono";
import type { Env } from "../env";
import type { CountryId } from "@wt/shared";
import type { UserRow } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { KV_KEYS } from "../lib/kv-keys";
import { kstDate } from "../lib/kst";
import { ensureDailySeed } from "../cron/daily-seed";

interface DailyTodayRes {
  dailyNo: number;
  dateKst: string;
  seed: string;
  countryIds: CountryId[];
}

interface DailyMeRes {
  dateKst: string;
  alreadyPlayed: boolean;
  streakDaily: number;
}

export const daily = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

daily.get("/daily/today", async (c) => {
  const dateKst = kstDate(Date.now());

  const cached = c.env.KV ? parseTodayCache(await c.env.KV.get(KV_KEYS.daily(dateKst)), dateKst) : null;
  const body = cached ?? (await ensureAndBuildRes(c.env));

  c.header("Cache-Control", "public, max-age=60");
  return c.json(body);
});

daily.get("/daily/me", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const pid = c.get("pid");
  const dateKst = kstDate(Date.now());
  const modeKey = `daily:${dateKst}`;

  const [played, user] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM runs WHERE user_id = ?1 AND mode_key = ?2 AND verdict = 'valid'`)
      .bind(pid, modeKey)
      .first<{ cnt: number }>(),
    db.prepare(`SELECT streak_daily FROM users WHERE user_id = ?1`).bind(pid).first<Pick<UserRow, "streak_daily">>(),
  ]);

  const body: DailyMeRes = {
    dateKst,
    alreadyPlayed: Number(played?.cnt ?? 0) > 0,
    streakDaily: user?.streak_daily ?? 0,
  };
  return c.json(body);
});

// ───────────────────────── 내부 헬퍼 ─────────────────────────

async function ensureAndBuildRes(env: Env): Promise<DailyTodayRes> {
  // Date.now() 그대로 위임 — ensureDailySeed 내부의 kstDate(now)가 dateKst를 다시 계산한다.
  // 위에서 이미 계산해 둔 dateKst 문자열을 재사용하지 않는 이유: 자정 경계 밀리초 오차보다
  // "kstDate 계산은 항상 kst.ts 한 곳에서" 원칙을 지키는 편이 더 안전하다(set-builder.ts와 동형).
  const ensured = await ensureDailySeed(env);
  return { dailyNo: ensured.dailyNo, dateKst: ensured.dateKst, seed: ensured.seed, countryIds: ensured.countryIds };
}

/**
 * KV 캐시 값 파싱. set-builder.ts의 loadDailySet과 저장소는 같지만(daily-seed.ts가 dailyNo까지
 * 함께 쓴다), 소비 목적이 달라 파싱 로직은 이 파일에 독립적으로 둔다(그쪽 주석 — "KV 저장 shape는
 * WT-M3-05 소관"). 형태가 다르면 무시하고 D1 경로(ensureDailySeed)로 폴백한다.
 */
function parseTodayCache(raw: string | null, dateKst: string): DailyTodayRes | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as { dailyNo?: unknown; seed?: unknown; countryIds?: unknown };
  if (
    typeof o.dailyNo === "number" &&
    typeof o.seed === "string" &&
    Array.isArray(o.countryIds) &&
    o.countryIds.every((x) => typeof x === "string")
  ) {
    return { dailyNo: o.dailyNo, dateKst, seed: o.seed, countryIds: o.countryIds as CountryId[] };
  }
  return null;
}
