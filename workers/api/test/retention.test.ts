// spec: docs/06 §5.2(game_abandon)·§5.4(kpi_daily 일 스냅샷)·§6.2(보존 — detail_json 90일,
//       lb_best d:/w: 정리), docs/00 §11-D25 + WT-M6-03
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { runRetentionJob, runAbuseSurgeCheck } from "../src/cron/retention";
import { kstDate } from "../src/lib/kst";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

async function bootstrapUser(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { playerId: string };
  return body.playerId;
}

function insertRun(
  runId: string,
  userId: string,
  createdAt: number,
  overrides: Partial<{ verdict: string; completed: number; modeKey: string; detailJson: string }> = {},
): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO runs (
       run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
       countries_cleared, countries_skipped, max_combo, completed, grade, seed, session_id,
       verdict, verdict_reason, geo, detail_json, created_at
     ) VALUES (?1,?2,?3,'ko','desktop',100,100,300,950,60000,10,0,5,?4,'A',NULL,?1,?5,NULL,'KR',?6,?7)`,
  )
    .bind(
      runId,
      userId,
      overrides.modeKey ?? "worldtour",
      overrides.completed ?? 1,
      overrides.verdict ?? "valid",
      overrides.detailJson ?? '{"result":{}}',
      createdAt,
    )
    .run();
}

function insertLbBest(boardKey: string, userId: string): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO lb_best (board_key, user_id, run_id, score, elapsed_ms, acc_milli, achieved_at, geo)
     VALUES (?1, ?2, 'r-'||?2, 100, 60000, 950, 1, 'KR')`,
  )
    .bind(boardKey, userId)
    .run();
}

describe("cron/retention — runRetentionJob(WT-M6-03)", () => {
  it("game_abandon: KV tel:starts/tel:submits 차분으로 근사 카운트를 낸다", async () => {
    const now = Date.parse("2026-07-22T01:30:00+09:00"); // KST 01:30 실행 시점
    const yesterdayKst = kstDate(now - DAY_MS);
    await env.KV.put(KV_KEYS.telStarts(yesterdayKst), "10");
    await env.KV.put(KV_KEYS.telSubmits(yesterdayKst), "7");

    const result = await runRetentionJob(env, now);
    expect(result.dateKst).toBe(yesterdayKst);
    expect(result.abandonCount).toBe(3);
  });

  it("game_abandon: 제출이 시작보다 많으면(정상) 0으로 클램프한다", async () => {
    const now = Date.parse("2026-08-01T01:30:00+09:00");
    const yesterdayKst = kstDate(now - DAY_MS);
    await env.KV.put(KV_KEYS.telStarts(yesterdayKst), "3");
    await env.KV.put(KV_KEYS.telSubmits(yesterdayKst), "5");

    const result = await runRetentionJob(env, now);
    expect(result.abandonCount).toBe(0);
  });

  it("kpi_daily: D1에서 계산 가능한 열(completed_runs/daily_play_users/flagged/rejected/total)을 채워 INSERT한다", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-08-10T01:30:00+09:00");
    const targetDateKst = kstDate(now - DAY_MS);
    const dayStartMs = Date.parse(`${targetDateKst}T00:00:00+09:00`);

    await insertRun("kpi-run-1", pid, dayStartMs + 1000, { completed: 1, verdict: "valid" });
    await insertRun("kpi-run-2", pid, dayStartMs + 2000, { completed: 0, verdict: "flagged" });
    await insertRun("kpi-run-3", pid, dayStartMs + 3000, { completed: 1, verdict: "rejected" });
    await insertRun("kpi-run-4-daily", pid, dayStartMs + 4000, {
      completed: 1,
      verdict: "valid",
      modeKey: `daily:${targetDateKst}`,
    });

    const result = await runRetentionJob(env, now);
    expect(result.kpiInserted).toBe(true);
    // CF_ACCOUNT_ID/CF_AE_API_TOKEN 미설정 로컬 환경 — AE 조회는 스킵되어야 한다(실패 위장 금지).
    expect(result.aeSnapshotSkipped).toBe(true);

    const row = await env.DB.prepare(`SELECT * FROM kpi_daily WHERE date_kst = ?1`).bind(targetDateKst).first<{
      completed_runs: number;
      daily_play_users: number;
      flagged_runs: number;
      rejected_runs: number;
      total_runs: number;
      dau: number;
    }>();
    expect(row).toBeTruthy();
    expect(row!.completed_runs).toBe(3); // kpi-run-1, kpi-run-3, kpi-run-4-daily(completed=1)
    expect(row!.daily_play_users).toBe(1); // kpi-run-4-daily만 daily:* + valid
    expect(row!.flagged_runs).toBe(1);
    expect(row!.rejected_runs).toBe(1);
    expect(row!.total_runs).toBe(4);
    expect(row!.dau).toBe(0); // AE 스킵 — D1만으로는 계산 불가한 열은 0
  });

  it("kpi_daily: 같은 날짜로 재실행하면 ON CONFLICT UPDATE로 덮어쓴다(중복 행 없음)", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-08-15T01:30:00+09:00");
    const targetDateKst = kstDate(now - DAY_MS);
    const dayStartMs = Date.parse(`${targetDateKst}T00:00:00+09:00`);
    await insertRun("kpi-dup-1", pid, dayStartMs + 1000);

    await runRetentionJob(env, now);
    await insertRun("kpi-dup-2", pid, dayStartMs + 2000);
    await runRetentionJob(env, now);

    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM kpi_daily WHERE date_kst = ?1`)
      .bind(targetDateKst)
      .first<{ n: number }>();
    expect(countRow!.n).toBe(1);
    const row = await env.DB.prepare(`SELECT total_runs FROM kpi_daily WHERE date_kst = ?1`)
      .bind(targetDateKst)
      .first<{ total_runs: number }>();
    expect(row!.total_runs).toBe(2); // 재집계 반영
  });

  it("detail_json 보존 정리: 90일 초과 run만 '{}'로 클리어하고 최근 run은 손대지 않는다", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-09-01T01:30:00+09:00");
    const old = now - 91 * DAY_MS;
    const recent = now - 10 * DAY_MS;
    await insertRun("old-run", pid, old, { detailJson: '{"secret":"stuff"}' });
    await insertRun("recent-run", pid, recent, { detailJson: '{"secret":"stuff"}' });

    await runRetentionJob(env, now);

    const oldRow = await env.DB.prepare(`SELECT detail_json FROM runs WHERE run_id = 'old-run'`).first<{ detail_json: string }>();
    const recentRow = await env.DB
      .prepare(`SELECT detail_json FROM runs WHERE run_id = 'recent-run'`)
      .first<{ detail_json: string }>();
    expect(oldRow!.detail_json).toBe("{}");
    expect(recentRow!.detail_json).toBe('{"secret":"stuff"}');
  });

  it("lb_best 보존 정리: d: 보드는 90일, w: 보드는 180일 지나면 삭제하고 all 보드는 절대 건드리지 않는다", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-09-10T01:30:00+09:00");

    const oldDailyBoard = `tier:1|ko|desktop|d:${kstDate(now - 91 * DAY_MS)}`;
    const freshDailyBoard = `tier:1|ko|desktop|d:${kstDate(now - 5 * DAY_MS)}`;
    const oldWeeklyBoard = `tier:1|ko|desktop|w:2020-W01`; // 확실히 180일보다 오래된 과거 주차
    const allBoard = `tier:1|ko|desktop|all`;

    await insertLbBest(oldDailyBoard, pid);
    await insertLbBest(freshDailyBoard, pid);
    await insertLbBest(oldWeeklyBoard, pid);
    await insertLbBest(allBoard, pid);

    await runRetentionJob(env, now);

    const remaining = await env.DB
      .prepare(`SELECT board_key FROM lb_best WHERE user_id = ?1 ORDER BY board_key`)
      .bind(pid)
      .all<{ board_key: string }>();
    const keys = (remaining.results ?? []).map((r) => r.board_key);
    expect(keys).toContain(freshDailyBoard);
    expect(keys).toContain(allBoard);
    expect(keys).not.toContain(oldDailyBoard);
    expect(keys).not.toContain(oldWeeklyBoard);
  });

  it("주간 D1 리포트: KST 월요일에만 채워지고, 그 외 요일은 null이다", async () => {
    const pid = await bootstrapUser();
    const monday = Date.parse("2026-08-10T01:30:00+09:00"); // 위 테스트로 검증된 월요일
    const tuesday = Date.parse("2026-08-11T01:30:00+09:00");
    await insertRun("weekly-run-1", pid, monday - DAY_MS);

    const mondayResult = await runRetentionJob(env, monday);
    expect(mondayResult.weeklyReport).not.toBeNull();
    expect(mondayResult.weeklyReport!.usersCount).toBeGreaterThan(0);
    expect(mondayResult.weeklyReport!.runsCount).toBeGreaterThan(0);

    const tuesdayResult = await runRetentionJob(env, tuesday);
    expect(tuesdayResult.weeklyReport).toBeNull();
  });
});

describe("cron/retention — runAbuseSurgeCheck(WT-M6-04, docs/06 §8.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("표본이 최소치(20) 미만이면 비율이 높아도 triggered=false(오탐 방지)", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-10-01T12:00:00+09:00");
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insertRun(`surge-lowsample-${i}`, pid, now - 60_000, { verdict: "rejected" });
    }
    const result = await runAbuseSurgeCheck(env, now);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(5);
    expect(result!.triggered).toBe(false);
  });

  it("표본 충분(≥20) + flagged/rejected 비율 > 5%이면 triggered=true이고 Slack webhook을 호출한다", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-10-02T12:00:00+09:00");
    for (let i = 0; i < 20; i += 1) {
      const verdict = i < 5 ? "rejected" : "valid"; // 5/20 = 25% > 5%
      // eslint-disable-next-line no-await-in-loop
      await insertRun(`surge-hi-${i}`, pid, now - 60_000, { verdict });
    }
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "https://hooks.slack.example/test" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      const result = await runAbuseSurgeCheck(env, now);
      expect(result!.triggered).toBe(true);
      expect(result!.total).toBe(20);
      expect(result!.flaggedOrRejected).toBe(5);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://hooks.slack.example/test",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      await env.KV.delete(KV_KEYS.configOps);
    }
  });

  it("config:ops에 webhook이 없으면(부재) 급증이 감지돼도 fetch를 호출하지 않고 skip 로그만 남긴다", async () => {
    const pid = await bootstrapUser();
    const now = Date.parse("2026-10-03T12:00:00+09:00");
    for (let i = 0; i < 20; i += 1) {
      const verdict = i < 10 ? "flagged" : "valid";
      // eslint-disable-next-line no-await-in-loop
      await insertRun(`surge-nowebhook-${i}`, pid, now - 60_000, { verdict });
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runAbuseSurgeCheck(env, now);
    expect(result!.triggered).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("DB 미바인딩이면 null을 반환한다(관대한 폴백)", async () => {
    const result = await runAbuseSurgeCheck({ ...env, DB: undefined as unknown as typeof env.DB });
    expect(result).toBeNull();
  });
});
