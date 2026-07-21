// spec: docs/06 §3.6(신고 플로우 전문 — reports INSERT, 동일 대상 5건 → flagged), docs/00 §11-D16
//       (Queue=신고 전용), docs/07 WT-M3-05 [구현 세부 지시 4]·[완료 조건] — 신고 5건 임계.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleQueueBatch, type ReportQueueMessage } from "../src/queue/consumer";

const BASE = "http://local/api/v1";

async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

function postReport(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** MessageBatch 최소 페이크 — 실제 큐 배달 타이밍에 기대지 않고 컨슈머 로직만 결정적으로 검증. */
function fakeBatch(messages: ReportQueueMessage[]): MessageBatch<unknown> {
  return {
    queue: "wt-events-dev",
    messages: messages.map((body) => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => {},
    ackAll: () => {},
  };
}

async function insertUser(userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(userId, `dh-${userId}`, `N-${userId}`, `n-${userId}`, now)
    .run();
}

async function insertRun(runId: string, userId: string, verdict: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (
       run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
       countries_cleared, countries_skipped, max_combo, completed, grade, seed, session_id,
       verdict, verdict_reason, geo, detail_json, created_at
     ) VALUES (?1, ?2, 'worldtour', 'en', 'desktop', 100, 100, 100, 1000, 10000, 10, 0, 10, 1, 'A',
       NULL, ?1, ?3, NULL, NULL, '{}', ?4)`,
  )
    .bind(runId, userId, verdict, now)
    .run();
}

describe("POST /api/v1/report", () => {
  it("401 without a session bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: "u1", reason: "other" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 INVALID_BODY when neither targetRunId nor targetUserId is provided", async () => {
    const { token } = await bootstrap();
    const res = await postReport(token, { reason: "other" });
    expect(res.status).toBe(400);
  });

  it("400 INVALID_BODY for an unknown reason code", async () => {
    const { token } = await bootstrap();
    const res = await postReport(token, { targetUserId: "u1", reason: "not-a-real-reason" });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed report and enqueues it (200 accepted:true)", async () => {
    const { token } = await bootstrap();
    const res = await postReport(token, { targetUserId: "some-other-user", reason: "macro_suspected" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it("self-reports are accepted but harmless (accepted:true without erroring)", async () => {
    const { token, pid } = await bootstrap();
    const res = await postReport(token, { targetUserId: pid, reason: "other" });
    expect(res.status).toBe(200);
  });
});

describe("queue consumer: report threshold (docs/06 §3.6)", () => {
  it("inserts a reports row per message and flags the target run once 5 open reports accumulate", async () => {
    const target = `target-${crypto.randomUUID().slice(0, 8)}`;
    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    await insertUser(target);
    await insertRun(runId, target, "valid");

    // 4건까지는 flagged로 승격되지 않는다.
    for (let i = 0; i < 4; i += 1) {
      const msg: ReportQueueMessage = {
        type: "report",
        reporterUserId: `reporter-${i}`,
        targetUserId: target,
        targetRunId: i === 0 ? runId : null,
        reason: "macro_suspected",
        createdAt: Date.now(),
      };
      await handleQueueBatch(fakeBatch([msg]), env);
    }
    const beforeThreshold = await env.DB.prepare(`SELECT verdict FROM runs WHERE run_id = ?1`)
      .bind(runId)
      .first<{ verdict: string }>();
    expect(beforeThreshold?.verdict).toBe("valid");

    const countBefore = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reports WHERE target_user_id = ?1 AND status = 'open'`)
      .bind(target)
      .first<{ cnt: number }>();
    expect(countBefore?.cnt).toBe(4);

    // 5번째 신고(이 신고에 targetRunId 포함) — 임계 도달 → flagged.
    const fifth: ReportQueueMessage = {
      type: "report",
      reporterUserId: "reporter-4",
      targetUserId: target,
      targetRunId: runId,
      reason: "nickname_inappropriate",
      createdAt: Date.now(),
    };
    await handleQueueBatch(fakeBatch([fifth]), env);

    const after = await env.DB.prepare(`SELECT verdict, verdict_reason FROM runs WHERE run_id = ?1`)
      .bind(runId)
      .first<{ verdict: string; verdict_reason: string | null }>();
    expect(after?.verdict).toBe("flagged");
    expect(after?.verdict_reason).toBe("report_threshold");

    const countAfter = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reports WHERE target_user_id = ?1`)
      .bind(target)
      .first<{ cnt: number }>();
    expect(countAfter?.cnt).toBe(5);
  });

  it("does not downgrade an already-rejected run even if the report threshold is reached", async () => {
    const target = `target-${crypto.randomUUID().slice(0, 8)}`;
    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    await insertUser(target);
    await insertRun(runId, target, "rejected");

    for (let i = 0; i < 5; i += 1) {
      const msg: ReportQueueMessage = {
        type: "report",
        reporterUserId: `reporter-${i}`,
        targetUserId: target,
        targetRunId: runId,
        reason: "other",
        createdAt: Date.now(),
      };
      await handleQueueBatch(fakeBatch([msg]), env);
    }

    const row = await env.DB.prepare(`SELECT verdict FROM runs WHERE run_id = ?1`).bind(runId).first<{ verdict: string }>();
    expect(row?.verdict).toBe("rejected"); // flagged로 격하(완화)되지 않는다
  });

  it("resolves target_user_id from targetRunId when only the run is given", async () => {
    const target = `target-${crypto.randomUUID().slice(0, 8)}`;
    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    await insertUser(target);
    await insertRun(runId, target, "valid");

    const msg: ReportQueueMessage = {
      type: "report",
      reporterUserId: "reporter-x",
      targetUserId: null,
      targetRunId: runId,
      reason: "other",
      createdAt: Date.now(),
    };
    await handleQueueBatch(fakeBatch([msg]), env);

    const row = await env.DB.prepare(`SELECT target_user_id FROM reports WHERE target_run_id = ?1`)
      .bind(runId)
      .first<{ target_user_id: string }>();
    expect(row?.target_user_id).toBe(target);
  });

  it("drops a report whose targetRunId cannot be resolved to any user (no orphan row)", async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reports`).first<{ cnt: number }>();
    const msg: ReportQueueMessage = {
      type: "report",
      reporterUserId: "reporter-y",
      targetUserId: null,
      targetRunId: "nonexistent-run-id",
      reason: "other",
      createdAt: Date.now(),
    };
    await handleQueueBatch(fakeBatch([msg]), env);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reports`).first<{ cnt: number }>();
    expect(after?.cnt).toBe(before?.cnt);
  });
});
