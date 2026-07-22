// spec: docs/06 §5.2(이벤트 스키마 — game_abandon)·§5.4(KPI 일 스냅샷·조회 = AE SQL API 일 1회
//       Cron), docs/06 §6.2(보존 — detail_json 90일 NULL, AE 90일 기본)·docs/00 §11-D26(백업
//       경로 R2 wt-{env}/d1-backups/는 별도 잡, 이 파일 소관 아님) + WT-M6-03
//
// KST 01:30("30 16 * * *") 1일 1회. 전날(KST) 몫을 확정 집계한다:
//   1) game_abandon — KV tel:starts/tel:submits 카운터 차분(근사치, 구현 결정 — 아래 주석)
//   2) kpi_daily INSERT — D1에서 직접 계산 가능한 열은 D1로, AE 전용 열(DAU/share_clicks/
//      matchmaking_queued 등)은 AE SQL API 조회(계정 토큰 필요) 성공 시에만 채운다. 토큰
//      미설정/조회 실패는 스킵 로그 후 해당 열만 0으로 둔다(§11 "실패를 위장하지 않는다").
//   3) 보존 정리 — runs.detail_json 90일 NULL, lb_best d: 90일/w: 180일 삭제.
//
// [구현 결정 — 최종 보고 escalations 참조] game_abandon("start 후 2h 내 미제출")은 정확히
// 판정하려면 세션별 시작 타임스탬프 원장이 필요하다. 그런 원장(D1 테이블)이 이번 스코프에
// 없어(추가하려면 신규 마이그레이션이 필요 — append-only 제약상 이 태스크 범위 밖) KV 일별
// 카운터(tel:starts:{date}/tel:submits:{date}, routes/runs.ts가 증분)의 차분으로 근사한다.
// 자정 경계를 넘나드는 세션은 오차 요인이나(시작일과 제출일이 다를 수 있음), v1 근사치로는
// 충분하다고 판단했다 — 리드가 정밀화(전용 원장 마이그레이션)를 원하면 §11에 결정 추가 요망.
import type { Env } from "../env";
import { kstDate, kstIsoWeek } from "../lib/kst";
import { KV_KEYS } from "../lib/kv-keys";
import { trackGameAbandon } from "../lib/telemetry";
import type { KpiDailyRow } from "../db/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_JSON_RETENTION_DAYS = 90; // docs/06 §6.2
const LB_DAILY_RETENTION_DAYS = 90; // docs/06 §5(태스크 산출물 지시) — lb_best d: 보드
const LB_WEEKLY_RETENTION_DAYS = 180; // lb_best w: 보드

export interface RetentionResult {
  dateKst: string;
  abandonCount: number;
  kpiInserted: boolean;
  aeSnapshotSkipped: boolean;
  detailJsonCleared: number;
  lbDailyPruned: number;
  lbWeeklyPruned: number;
}

/** index.ts scheduled() "30 16 * * *"의 유일한 진입점. */
export async function runRetentionJob(env: Env, scheduledTimeMs?: number): Promise<RetentionResult> {
  const now = scheduledTimeMs ?? Date.now();
  // 이 크론은 KST 01:30에 돈다 — 방금 끝난 KST 하루(어제)를 확정 집계한다.
  const todayKst = kstDate(now);
  const dateKst = shiftKstDate(todayKst, -1);

  const abandonCount = await computeGameAbandon(env, dateKst);
  if (abandonCount > 0) trackGameAbandon(env, { dateKst, count: abandonCount });

  const kpiInserted = await upsertKpiDaily(env, dateKst);
  const aeSnapshotSkipped = !env.CF_ACCOUNT_ID || !env.CF_AE_API_TOKEN;

  const detailJsonCleared = await clearOldDetailJson(env, now);
  const lbDailyPruned = await pruneLbBoards(env, "d:", now, LB_DAILY_RETENTION_DAYS);
  const lbWeeklyPruned = await pruneLbBoards(env, "w:", now, LB_WEEKLY_RETENTION_DAYS);

  return { dateKst, abandonCount, kpiInserted, aeSnapshotSkipped, detailJsonCleared, lbDailyPruned, lbWeeklyPruned };
}

/** 'YYYY-MM-DD' 문자열을 순수 캘린더 산술로 +N/-N일 이동(자정 UTC 앵커라 KST 오프셋과 무관 —
 *  kst.ts의 kstYesterday와 동일한 앵커링 규약, 임의 delta를 다루도록 일반화). */
function shiftKstDate(dateKst: string, deltaDays: number): string {
  const ms = Date.parse(`${dateKst}T00:00:00Z`) + deltaDays * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

// ───────────────────────── 1) game_abandon(근사, 파일 상단 주석) ─────────────────────────

async function computeGameAbandon(env: Env, dateKst: string): Promise<number> {
  if (!env.KV) return 0;
  const [startsRaw, submitsRaw] = await Promise.all([
    env.KV.get(KV_KEYS.telStarts(dateKst)),
    env.KV.get(KV_KEYS.telSubmits(dateKst)),
  ]);
  const starts = Number(startsRaw ?? 0);
  const submits = Number(submitsRaw ?? 0);
  return Math.max(starts - submits, 0);
}

// ───────────────────────── 2) kpi_daily ─────────────────────────

interface AeSnapshot {
  dau: number;
  shareClicks: number;
  shareDrivenVisits: number;
  matchmakingQueued: number;
  matchmakingWaitMsSum: number;
}

/** D1에서 직접 계산 가능한 열(§5.4 지표 중 AE 없이도 구할 수 있는 부분). */
async function computeD1Kpi(
  db: D1Database,
  dayStartMs: number,
  dayEndMs: number,
): Promise<{
  completedRuns: number;
  dailyPlayUsers: number;
  flaggedRuns: number;
  rejectedRuns: number;
  totalRuns: number;
  matchmakingStarted: number;
}> {
  const runsRow = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed_runs,
         SUM(CASE WHEN mode_key LIKE 'daily:%' AND verdict = 'valid' THEN 1 ELSE 0 END) AS daily_play_users,
         SUM(CASE WHEN verdict = 'flagged' THEN 1 ELSE 0 END) AS flagged_runs,
         SUM(CASE WHEN verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected_runs,
         COUNT(*) AS total_runs
       FROM runs WHERE created_at >= ?1 AND created_at < ?2`,
    )
    .bind(dayStartMs, dayEndMs)
    .first<{
      completed_runs: number | null;
      daily_play_users: number | null;
      flagged_runs: number | null;
      rejected_runs: number | null;
      total_runs: number | null;
    }>();

  const matchesRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM matches WHERE started_at >= ?1 AND started_at < ?2`)
    .bind(dayStartMs, dayEndMs)
    .first<{ n: number | null }>();

  return {
    completedRuns: Number(runsRow?.completed_runs ?? 0),
    dailyPlayUsers: Number(runsRow?.daily_play_users ?? 0),
    flaggedRuns: Number(runsRow?.flagged_runs ?? 0),
    rejectedRuns: Number(runsRow?.rejected_runs ?? 0),
    totalRuns: Number(runsRow?.total_runs ?? 0),
    matchmakingStarted: Number(matchesRow?.n ?? 0),
  };
}

/**
 * AE SQL API 스냅샷(DAU/share_clicks/share_driven_visits/matchmaking_queued/wait_ms_sum) —
 * 계정 토큰 필요(구현 세부 지시 2). 미설정/실패는 null(스킵 로그) — 호출부가 0으로 채운다.
 */
async function queryAeSnapshot(env: Env, dateKst: string): Promise<AeSnapshot | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_AE_API_TOKEN) {
    // eslint-disable-next-line no-console -- 스킵 관측(wrangler tail).
    console.warn("[retention] AE SQL snapshot skipped: CF_ACCOUNT_ID/CF_AE_API_TOKEN not configured");
    return null;
  }
  try {
    // wt_telemetry의 index1=이벤트명, blob1=userIdHash(§5.2). DAU는 visit distinct blob1,
    // share_clicks는 share_click 이벤트 수, share_driven_visits는 utm_source='share'인
    // visit 수(§9.1 랜딩 CTA utm_source=share, docs/06 §9.1), matchmaking_*는 mp_queue/
    // mp_match_start 카운트·대기(splittime)로 근사한다(정밀 대기시간 컬럼은 blobs에 없어
        // v1은 큐→시작 이벤트 수 비율로 대체 — 리드 확인 전 잠정, escalations 참조).
    const sql = `
      SELECT
        (SELECT COUNT(DISTINCT blob1) FROM wt_telemetry WHERE index1='visit' AND timestamp >= toDateTime('${dateKst}') AND timestamp < toDateTime('${dateKst}') + INTERVAL '1' DAY) AS dau,
        (SELECT COUNT(*) FROM wt_telemetry WHERE index1='share_click' AND timestamp >= toDateTime('${dateKst}') AND timestamp < toDateTime('${dateKst}') + INTERVAL '1' DAY) AS share_clicks,
        (SELECT COUNT(*) FROM wt_telemetry WHERE index1='visit' AND blob8='share' AND timestamp >= toDateTime('${dateKst}') AND timestamp < toDateTime('${dateKst}') + INTERVAL '1' DAY) AS share_driven_visits,
        (SELECT COUNT(*) FROM wt_telemetry WHERE index1='mp_queue' AND timestamp >= toDateTime('${dateKst}') AND timestamp < toDateTime('${dateKst}') + INTERVAL '1' DAY) AS matchmaking_queued
    `.trim();
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: "POST", headers: { Authorization: `Bearer ${env.CF_AE_API_TOKEN}` }, body: sql },
    );
    if (!res.ok) throw new Error(`AE SQL API HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const row = json.data?.[0];
    if (!row) return null;
    return {
      dau: Number(row.dau ?? 0),
      shareClicks: Number(row.share_clicks ?? 0),
      shareDrivenVisits: Number(row.share_driven_visits ?? 0),
      matchmakingQueued: Number(row.matchmaking_queued ?? 0),
      matchmakingWaitMsSum: 0, // §5.2 blobs에 대기시간 원시값이 없어 v1은 미집계(0) — escalations 참조.
    };
  } catch (err) {
    // eslint-disable-next-line no-console -- 스킵 관측(wrangler tail), 실패를 위장하지 않는다.
    console.warn("[retention] AE SQL snapshot failed (skip):", err);
    return null;
  }
}

async function upsertKpiDaily(env: Env, dateKst: string): Promise<boolean> {
  if (!env.DB) return false;
  const dayStartMs = Date.parse(`${dateKst}T00:00:00Z`) - 9 * 60 * 60 * 1000; // KST 00:00 → UTC epoch
  const dayEndMs = dayStartMs + DAY_MS;

  const d1 = await computeD1Kpi(env.DB, dayStartMs, dayEndMs);
  const ae = await queryAeSnapshot(env, dateKst);

  const row: Omit<KpiDailyRow, "created_at"> = {
    date_kst: dateKst,
    dau: ae?.dau ?? 0,
    completed_runs: d1.completedRuns,
    daily_play_users: d1.dailyPlayUsers,
    share_clicks: ae?.shareClicks ?? 0,
    share_driven_visits: ae?.shareDrivenVisits ?? 0,
    matchmaking_queued: ae?.matchmakingQueued ?? 0,
    matchmaking_started: d1.matchmakingStarted,
    matchmaking_wait_ms_sum: ae?.matchmakingWaitMsSum ?? 0,
    flagged_runs: d1.flaggedRuns,
    rejected_runs: d1.rejectedRuns,
    total_runs: d1.totalRuns,
  };

  await env.DB.prepare(
    `INSERT INTO kpi_daily (
       date_kst, dau, completed_runs, daily_play_users, share_clicks, share_driven_visits,
       matchmaking_queued, matchmaking_started, matchmaking_wait_ms_sum,
       flagged_runs, rejected_runs, total_runs, created_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
     ON CONFLICT (date_kst) DO UPDATE SET
       dau=excluded.dau, completed_runs=excluded.completed_runs, daily_play_users=excluded.daily_play_users,
       share_clicks=excluded.share_clicks, share_driven_visits=excluded.share_driven_visits,
       matchmaking_queued=excluded.matchmaking_queued, matchmaking_started=excluded.matchmaking_started,
       matchmaking_wait_ms_sum=excluded.matchmaking_wait_ms_sum,
       flagged_runs=excluded.flagged_runs, rejected_runs=excluded.rejected_runs, total_runs=excluded.total_runs`,
  )
    .bind(
      row.date_kst,
      row.dau,
      row.completed_runs,
      row.daily_play_users,
      row.share_clicks,
      row.share_driven_visits,
      row.matchmaking_queued,
      row.matchmaking_started,
      row.matchmaking_wait_ms_sum,
      row.flagged_runs,
      row.rejected_runs,
      row.total_runs,
      Date.now(),
    )
    .run();
  return true;
}

// ───────────────────────── 3) 보존 정리 ─────────────────────────

/**
 * [구현 결정 — 최종 보고 escalations 참조] docs/06 §6.2는 "detail_json 90일 후 NULL 처리"라고
 * 쓰지만 migrations/0001의 실제 컬럼은 `detail_json TEXT NOT NULL`이다 — 문자 그대로 NULL을
 * 넣으면 제약 위반으로 UPDATE 자체가 실패한다(append-only라 이 태스크에서 컬럼 제약을 바꿀
 * 수 없다). 그래서 "빈 페이로드" 센티널 '{}'로 클리어한다 — 개인정보(perCountry 입력 리듬 등)는
 * 동일하게 제거되고 detail_json이 유효 JSON으로 남아 JSON.parse 호출부(share.ts clearedCodes
 * 등)가 깨지지 않는다. 리드가 문서 그대로 리터럴 NULL을 원하면 0005+ 마이그레이션으로 컬럼을
 * NULL 허용으로 재정의해야 한다.
 */
async function clearOldDetailJson(env: Env, now: number): Promise<number> {
  if (!env.DB) return 0;
  const cutoff = now - DETAIL_JSON_RETENTION_DAYS * DAY_MS;
  const res = await env.DB.prepare(
    `UPDATE runs SET detail_json = '{}' WHERE created_at < ?1 AND detail_json != '{}'`,
  )
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * board_key = `{modeKey}|{lang}|{platform}|{periodKey}`(lib/lb.ts). periodKey는 `d:YYYY-MM-DD`
 * (뒤 10자) 또는 `w:YYYY-Www`(뒤 8자) — 접두사로 필터한 뒤 마지막 N자를 날짜 문자열로 비교한다
 * (ISO 형식이라 사전식 비교 = 시간순 비교와 동치).
 */
async function pruneLbBoards(env: Env, prefix: "d:" | "w:", now: number, retentionDays: number): Promise<number> {
  if (!env.DB) return 0;
  const cutoffDateKst = kstDate(now - retentionDays * DAY_MS);
  const dateLen = prefix === "d:" ? 10 : 8;
  const cutoffLabel = prefix === "d:" ? cutoffDateKst : kstIsoWeek(now - retentionDays * DAY_MS);

  const res = await env.DB.prepare(
    `DELETE FROM lb_best WHERE board_key LIKE ?1 AND SUBSTR(board_key, -?2) < ?3`,
  )
    .bind(`%|${prefix}%`, dateLen, cutoffLabel)
    .run();
  return res.meta.changes ?? 0;
}
