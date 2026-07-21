// spec: docs/07-implementation-prompts.md WT-M3-01 [구현 세부 지시] #4 — 4개 마이그레이션 파일
// 순차 적용 후 주요 테이블·인덱스 존재(PRAGMA)·CHECK 제약 동작을 검증한다.
// 마이그레이션 적용 자체는 test/apply-migrations.ts(setupFiles)가 이미 수행했다 — 여기서는
// 적용된 스키마를 조회·검증만 한다.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface TableRow {
  name: string;
}
interface IndexRow {
  name: string;
}

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all<TableRow>();
  return results.map((r) => r.name);
}

async function indexNames(db: D1Database, table: string): Promise<string[]> {
  const { results } = await db.prepare(`PRAGMA index_list(${table})`).all<IndexRow>();
  return results.map((r) => r.name);
}

describe("WT-M3-01 D1 migrations 0001~0004", () => {
  it("creates every table from the 4 migration files (0001~0004)", async () => {
    const names = await tableNames(env.DB);
    expect(names).toEqual(
      expect.arrayContaining([
        // 0001_users_runs.sql
        "users",
        "runs",
        "user_unlocks",
        "daily_challenges",
        "shares",
        // 0002_leaderboard.sql
        "lb_best",
        "seasons",
        "kpi_daily",
        // 0003_matches.sql
        "matches",
        "match_participants",
        // 0004_moderation.sql
        "reports",
        "admin_audit",
      ]),
    );

    // docs/04 §4·docs/06 §4의 폐기 테이블은 절대 생성되지 않아야 한다(docs/00 §11-D9).
    for (const deprecated of ["scores", "leaderboard_snapshots", "players", "nicknames"]) {
      expect(names).not.toContain(deprecated);
    }
  });

  it("declares idx_runs_user / idx_runs_mode / idx_runs_flagged on runs", async () => {
    const idx = await indexNames(env.DB, "runs");
    expect(idx).toEqual(
      expect.arrayContaining(["idx_runs_user", "idx_runs_mode", "idx_runs_flagged"]),
    );
  });

  it("declares idx_lb_rank / idx_lb_geo on lb_best in the exact docs06-1.2 ranking-key order", async () => {
    const idx = await indexNames(env.DB, "lb_best");
    expect(idx).toEqual(expect.arrayContaining(["idx_lb_rank", "idx_lb_geo"]));

    const { results } = await env.DB.prepare("PRAGMA index_info(idx_lb_rank)").all<{
      seqno: number;
      cid: number;
      name: string;
    }>();
    // docs/06 §1.2: board_key, score DESC, elapsed_ms ASC, acc_milli DESC, achieved_at ASC
    expect(results.map((r) => r.name)).toEqual([
      "board_key",
      "score",
      "elapsed_ms",
      "acc_milli",
      "achieved_at",
    ]);
  });

  it("declares idx_mp_player / idx_matches_at (docs05-10.1)", async () => {
    expect(await indexNames(env.DB, "match_participants")).toEqual(
      expect.arrayContaining(["idx_mp_player"]),
    );
    expect(await indexNames(env.DB, "matches")).toEqual(
      expect.arrayContaining(["idx_matches_at"]),
    );
  });

  it("declares idx_reports_target (docs06-3.6)", async () => {
    expect(await indexNames(env.DB, "reports")).toEqual(
      expect.arrayContaining(["idx_reports_target"]),
    );
  });

  it("rejects an INSERT with an invalid runs.verdict (CHECK constraint)", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind("u_test_1", "hash_test_1", "테스트유저", "테스트유저", now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO runs (
           run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
           countries_cleared, countries_skipped, max_combo, completed, grade, session_id,
           verdict, detail_json, created_at
         ) VALUES (?1, ?2, 'continent:asia', 'ko', 'desktop', 100, 100, 300, 950, 60000,
                   10, 0, 5, 1, 'A', 'sess_1', 'not_a_real_verdict', '{}', ?3)`,
      )
        .bind("r_test_bad_verdict", "u_test_1", now)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an INSERT with an invalid users.status (CHECK constraint)", async () => {
    const now = Date.now();
    await expect(
      env.DB.prepare(
        `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3, 'not_a_real_status', ?4, ?4)`,
      )
        .bind("u_test_bad_status", "hash_test_bad_status", "배드유저", now)
        .run(),
    ).rejects.toThrow();
  });

  it("accepts a valid runs INSERT and upserts lb_best via the docs06-1.3 write path", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind("u_test_2", "hash_test_2", "정상유저", "정상유저", now)
      .run();

    await env.DB.prepare(
      `INSERT INTO runs (
         run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
         countries_cleared, countries_skipped, max_combo, completed, grade, session_id,
         verdict, detail_json, created_at
       ) VALUES (?1, ?2, 'continent:asia', 'ko', 'desktop', 900, 450, 300, 950, 60000,
                 47, 0, 47, 1, 'S', 'sess_2', 'valid', '{}', ?3)`,
    )
      .bind("r_test_ok", "u_test_2", now)
      .run();

    const boardKey = "continent:asia|ko|desktop|all";
    await env.DB.prepare(
      `INSERT INTO lb_best (board_key, user_id, run_id, score, elapsed_ms, acc_milli, achieved_at, geo)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (board_key, user_id) DO UPDATE SET
         run_id=excluded.run_id, score=excluded.score, elapsed_ms=excluded.elapsed_ms,
         acc_milli=excluded.acc_milli, achieved_at=excluded.achieved_at, geo=excluded.geo
       WHERE (excluded.score, -excluded.elapsed_ms, excluded.acc_milli, -excluded.achieved_at)
           > (lb_best.score, -lb_best.elapsed_ms, lb_best.acc_milli, -lb_best.achieved_at)`,
    )
      .bind(boardKey, "u_test_2", "r_test_ok", 900, 60000, 950, now, "KR")
      .run();

    const row = await env.DB.prepare(
      "SELECT score, user_id FROM lb_best WHERE board_key = ?1 AND user_id = ?2",
    )
      .bind(boardKey, "u_test_2")
      .first<{ score: number; user_id: string }>();
    expect(row?.score).toBe(900);
  });
});
