// spec: docs/06 §3.6(신고 플로우 전문 — reports INSERT, 동일 대상 5건 → 대상 run flagged + 운영
//       알림), docs/05 §2.3-5(고스트 수집 — 클린 완주자 스플릿을 KV ghost 링 버퍼 적재),
//       docs/00 §11-D16(Queue wt-events = AE 적재·신고·고스트 저장 전용) + docs/07 WT-M3-05·WT-M4-05
//
// wt-events 컨슈머. report(신고) + ghost-collect(고스트 수집)를 처리한다. 알려지지 않은 type은
// 조용히 ack하고 무시해, 이후 다른 타입이 같은 큐에 추가돼도 이 컨슈머가 깨지지 않는다. 즉시
// 제재는 하지 않는다(제약/금지 — flagged 마킹까지만, 수동 리뷰가 최종 조치를 결정).
import { uuidv7 } from "../lib/uuid";
import type { Env } from "../env";
import { appendGhostRecording } from "../lib/ghost";
import { logError, logWarn } from "../lib/log";

export type ReportReason = "macro_suspected" | "nickname_inappropriate" | "other";

export interface ReportQueueMessage {
  type: "report";
  reporterUserId: string;
  targetUserId: string | null;
  targetRunId: string | null;
  reason: ReportReason;
  createdAt: number;
}

/** MatchRoom DO가 클린 완주자 스플릿을 적재 예약할 때 보내는 메시지(§2.3-5). */
export interface GhostCollectQueueMessage {
  type: "ghost-collect";
  lang: string;
  mode: string;
  piBucket: string;
  cumSplitsMs: number[];
  createdAt: number;
}

export type EventsQueueMessage = ReportQueueMessage | GhostCollectQueueMessage;

/** 동일 대상(target_user_id) OPEN 신고가 이 개수에 도달하면 대상 run을 자동 flagged(§3.6). */
const REPORT_FLAG_THRESHOLD = 5;

/** index.ts의 queue() 핸들러가 그대로 위임하는 진입점. */
export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body as Partial<EventsQueueMessage> | undefined;
      if (body?.type === "report") {
        // 바인딩 미설정 로컬 환경은 관대하게 skip(다른 라우트 톤과 동일) — ack로 재시도 폭주 방지.
        if (env.DB) await processReport(env.DB, body as ReportQueueMessage);
      } else if (body?.type === "ghost-collect") {
        if (env.KV) await processGhostCollect(env.KV, body as GhostCollectQueueMessage);
      }
      // 알 수 없는 type은 조용히 ack(향후 AE 등 추가 대비 — 파일 상단 주석).
      msg.ack();
    } catch (err) {
      logError("queue_consumer_error", { message: err instanceof Error ? err.message : String(err) });
      msg.retry();
    }
  }
}

async function processGhostCollect(kv: KVNamespace, m: GhostCollectQueueMessage): Promise<void> {
  if (!Array.isArray(m.cumSplitsMs) || m.cumSplitsMs.length === 0) return;
  if (!m.lang || !m.mode || !m.piBucket) return;
  await appendGhostRecording(kv, m.lang, m.mode, m.piBucket, { cumSplitsMs: m.cumSplitsMs });
}

async function processReport(db: D1Database, m: ReportQueueMessage): Promise<void> {
  const targetUserId = m.targetUserId ?? (m.targetRunId ? await resolveUserIdFromRun(db, m.targetRunId) : null);
  if (!targetUserId) return; // 대상 유저를 특정할 수 없으면 고아 신고 — 기록하지 않는다.

  const reportId = uuidv7(m.createdAt);
  await db
    .prepare(
      `INSERT INTO reports (report_id, reporter_user_id, target_user_id, target_run_id, reason, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)`,
    )
    .bind(reportId, m.reporterUserId, targetUserId, m.targetRunId, m.reason, m.createdAt)
    .run();

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM reports WHERE target_user_id = ?1 AND status = 'open'`)
    .bind(targetUserId)
    .first<{ cnt: number }>();
  const openCount = Number(countRow?.cnt ?? 0);

  if (openCount >= REPORT_FLAG_THRESHOLD && m.targetRunId) {
    // verdict != 'rejected' 가드 — 이미 rejected인 run을 flagged로 격하(완화)시키지 않는다.
    await db
      .prepare(`UPDATE runs SET verdict = 'flagged', verdict_reason = 'report_threshold' WHERE run_id = ?1 AND verdict != 'rejected'`)
      .bind(m.targetRunId)
      .run();
    // 운영 알림(구현 세부 지시 4). docs/06 §8.2 웹훅은 인프라 가용성/에러율 알림 전용이라 이
    // 신고 임계 알림에는 재사용하지 않는다 — v1은 wrangler tail 로그가 1차 관측 채널이다.
    logWarn("report_threshold_reached", { targetUserId, runId: m.targetRunId, openCount });
  }
}

async function resolveUserIdFromRun(db: D1Database, runId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT user_id FROM runs WHERE run_id = ?1`).bind(runId).first<{ user_id: string }>();
  return row?.user_id ?? null;
}
