// spec: docs/06 §2.1(세트 결정 전문 — 시드 산식·티어 분포·서버 salt)·§2.3(1일 1회·스트릭),
//       docs/00 §11-D13(mulberry32 공유)·§11-D21(서버 salt 전용), docs/07 WT-M3-05 [구현 세부
//       지시 1·2·4]·[완료 조건] — 시드 결정성, 티어 분포 3/3/2/1/1, 멱등 cron, /daily/today·/me.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COUNTRIES } from "@wt/data";
import type { CountryId, DifficultyTier } from "@wt/shared";
import { ensureDailySeed } from "../src/cron/daily-seed";
import { kstDate } from "../src/lib/kst";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";
const TIER_BY_ID = new Map<CountryId, DifficultyTier>(COUNTRIES.map((c) => [c.id, c.difficultyTier] as const));

function tierCounts(ids: CountryId[]): Record<DifficultyTier, number> {
  const counts: Record<DifficultyTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const id of ids) {
    const t = TIER_BY_ID.get(id);
    if (t) counts[t] += 1;
  }
  return counts;
}

async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

describe("ensureDailySeed (docs/06 §2.1)", () => {
  it("is deterministic: repeated calls for the same date return the identical 10-country set", async () => {
    const now = Date.parse("2026-08-01T00:00:00Z"); // KST 2026-08-01 09:00 — 같은 KST 날짜
    const first = await ensureDailySeed(env, now);
    const second = await ensureDailySeed(env, now + 60_000);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // 멱등 — 이미 있는 날짜는 no-op
    expect(second.dailyNo).toBe(first.dailyNo);
    expect(second.seed).toBe(first.seed);
    expect(second.countryIds).toEqual(first.countryIds);
    expect(first.countryIds).toHaveLength(10);
    expect(new Set(first.countryIds).size).toBe(10); // 중복 없음
  });

  it("tier distribution is exactly T1x3+T2x3+T3x2+T4x1+T5x1 (GDD §9.1)", async () => {
    const now = Date.parse("2026-08-02T00:00:00Z");
    const result = await ensureDailySeed(env, now);
    expect(tierCounts(result.countryIds)).toEqual({ 1: 3, 2: 3, 3: 2, 4: 1, 5: 1 });
  });

  it("idempotent cron re-run: daily_challenges keeps exactly one row for the date", async () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const dateKst = kstDate(now);
    await ensureDailySeed(env, now);
    await ensureDailySeed(env, now + 1000);
    await ensureDailySeed(env, now + 2000);

    const row = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM daily_challenges WHERE date_kst = ?1`)
      .bind(dateKst)
      .first<{ cnt: number }>();
    expect(row?.cnt).toBe(1);
  });

  it("different dates yield different (deterministic) seeds/sets", async () => {
    const a = await ensureDailySeed(env, Date.parse("2026-08-04T00:00:00Z"));
    const b = await ensureDailySeed(env, Date.parse("2026-08-05T00:00:00Z"));
    expect(a.seed).not.toBe(b.seed);
    expect(a.countryIds).not.toEqual(b.countryIds);
  });

  it("writes a KV cache readable by set-builder.ts's loadDailySet shape ({seed, countryIds})", async () => {
    const now = Date.parse("2026-08-06T00:00:00Z");
    const dateKst = kstDate(now);
    const result = await ensureDailySeed(env, now);

    const raw = await env.KV.get(KV_KEYS.daily(dateKst));
    expect(raw).not.toBeNull();
    const cached = JSON.parse(raw!) as { seed: string; countryIds: string[]; dailyNo: number };
    expect(cached.seed).toBe(result.seed);
    expect(cached.countryIds).toEqual(result.countryIds);
    expect(cached.dailyNo).toBe(result.dailyNo);
  });
});

describe("GET /api/v1/daily/today", () => {
  it("returns today's set with cron-not-yet-run fallback (lazy ensureDailySeed) and caches it", async () => {
    const res = await SELF.fetch(`${BASE}/daily/today`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");

    const body = (await res.json()) as { dailyNo: number; dateKst: string; seed: string; countryIds: string[] };
    expect(body.countryIds).toHaveLength(10);
    expect(tierCounts(body.countryIds as CountryId[])).toEqual({ 1: 3, 2: 3, 3: 2, 4: 1, 5: 1 });
    expect(body.dateKst).toBe(kstDate(Date.now()));

    // 두 번째 호출은 KV 캐시 히트로 동일 값을 반환한다(폴백이 두 번 새로 만들지 않음).
    const again = await SELF.fetch(`${BASE}/daily/today`);
    const bodyAgain = (await again.json()) as { seed: string; countryIds: string[] };
    expect(bodyAgain.seed).toBe(body.seed);
    expect(bodyAgain.countryIds).toEqual(body.countryIds);
  });
});

describe("GET /api/v1/daily/me", () => {
  it("401 without a session bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/daily/me`);
    expect(res.status).toBe(401);
  });

  it("reports alreadyPlayed=false and streakDaily=0 for a fresh user before playing today", async () => {
    const { token } = await bootstrap();
    const res = await SELF.fetch(`${BASE}/daily/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dateKst: string; alreadyPlayed: boolean; streakDaily: number };
    expect(body.alreadyPlayed).toBe(false);
    expect(body.streakDaily).toBe(0);
    expect(body.dateKst).toBe(kstDate(Date.now()));
  });

  it("reflects alreadyPlayed=true + streak once a valid daily run + streak update are recorded", async () => {
    const { token, pid } = await bootstrap();
    const dateKst = kstDate(Date.now());
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO runs (
         run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
         countries_cleared, countries_skipped, max_combo, completed, grade, seed, session_id,
         verdict, verdict_reason, geo, detail_json, created_at
       ) VALUES (?1, ?2, ?3, 'en', 'desktop', 100, 100, 100, 1000, 10000, 10, 0, 10, 1, 'A', 'x', ?1,
         'valid', NULL, NULL, '{}', ?4)`,
    )
      .bind(crypto.randomUUID(), pid, `daily:${dateKst}`, now)
      .run();
    await env.DB.prepare(`UPDATE users SET streak_daily = 3 WHERE user_id = ?1`).bind(pid).run();

    const res = await SELF.fetch(`${BASE}/daily/me`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { alreadyPlayed: boolean; streakDaily: number };
    expect(body.alreadyPlayed).toBe(true);
    expect(body.streakDaily).toBe(3);
  });
});
