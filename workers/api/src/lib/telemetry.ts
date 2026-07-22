// spec: docs/06 §5.2(AE 이벤트 스키마 — blobs/doubles 고정 레이아웃 전문)·§5.1(도구 선정 — AE가
//       제품 이벤트의 권위)·§5.3(퍼널)·§5.4(KPI), docs/03 §8.6(클라 에러 리포터 인터페이스),
//       docs/00 §11-D25(바인딩 AE·Queue wt-events) + WT-M6-03
//
// Analytics Engine 적재의 단일 원천. 모든 이벤트가 blobs 1~9·doubles 1~8 위치를 문서 그대로
// 지킨다(AE SQL 조회가 위치 기반이라 이벤트별로 슬롯 의미가 흔들리면 대시보드가 조용히
// 깨진다) — 이벤트에 해당하지 않는 슬롯은 ""(blob) / 0(double)으로 채운다.
//
// [구현 결정 — 최종 보고 escalations 참조] retention_ping(D1/D7/D30 플래그)·game_abandon(일별
// 집계 카운트)처럼 문서의 9-blob 고정 레이아웃 밖의 데이터가 필요한 이벤트는 blobs[10](10번째,
// 문서 표에 없는 확장 슬롯)에 "key:value,key:value" 문자열로 담는다. AE는 blob 개수가 가변이라
// (≤20) 앞 9개의 위치 의미를 건드리지 않는 안전한 확장이다 — 리드 승인 전까지 잠정 규약.
import type { Env } from "../env";
import { sha256Hex } from "./hash";
import { logWarn } from "./log";

export type TelemetryEvent =
  | "visit"
  | "game_start"
  | "game_finish"
  | "game_abandon"
  | "daily_play"
  | "mp_queue"
  | "mp_match_start"
  | "mp_match_finish"
  | "share_click"
  | "retention_ping"
  | "client_error";

/** blobs[1]~[9] — docs/06 §5.2 표 그대로. 이벤트와 무관한 필드는 생략(내부에서 ""로 채움). */
export interface TelemetryFields {
  /** blobs[1]. 원 id 비저장 — 항상 sha256Hex16(pid)로 파생한 값만 넘긴다. 신원 없는
   *  이벤트(예: 비인증 share_click)는 "" 그대로 둔다. */
  userIdHash: string;
  modeKey?: string;
  lang?: string;
  platform?: string;
  geo?: string;
  verdict?: string;
  referrerHost?: string;
  utmSource?: string;
  appVersion?: string;
}

/** doubles[1]~[8] — docs/06 §5.2 표 그대로. */
export interface TelemetryMetrics {
  score?: number;
  pi?: number;
  cpm?: number;
  accMilli?: number;
  elapsedMs?: number;
  countriesCleared?: number;
  skipped?: number;
  completed?: boolean;
}

/** SHA-256(pid) 앞 16자 — AE에 원 id를 절대 쓰지 않는다(구현 세부 지시 1). */
export async function sha256Hex16(input: string): Promise<string> {
  return (await sha256Hex(input)).slice(0, 16);
}

function toBlobs(f: TelemetryFields, extraBlob?: string): string[] {
  const base = [
    f.userIdHash,
    f.modeKey ?? "",
    f.lang ?? "",
    f.platform ?? "",
    f.geo ?? "",
    f.verdict ?? "",
    f.referrerHost ?? "",
    f.utmSource ?? "",
    f.appVersion ?? "",
  ];
  return extraBlob !== undefined ? [...base, extraBlob] : base;
}

function toDoubles(m: TelemetryMetrics | undefined): number[] {
  return [
    m?.score ?? 0,
    m?.pi ?? 0,
    m?.cpm ?? 0,
    m?.accMilli ?? 0,
    m?.elapsedMs ?? 0,
    m?.countriesCleared ?? 0,
    m?.skipped ?? 0,
    m?.completed ? 1 : 0,
  ];
}

/**
 * writeDataPoint 최하위 호출. AE 미바인딩(로컬 등)·쓰기 실패는 전부 삼킨다 — 텔레메트리는
 * 부가 관측 채널이라 실패가 요청 자체를 실패시키면 안 된다(다른 라우트의 KV/DB 부재 관용 톤과
 * 동일, wrangler tail 로그가 유일한 관측 경로).
 */
export function writeTelemetryEvent(
  env: Pick<Env, "AE">,
  name: TelemetryEvent,
  fields: TelemetryFields,
  metrics?: TelemetryMetrics,
  extraBlob?: string,
): void {
  if (!env.AE) return;
  try {
    env.AE.writeDataPoint({
      indexes: [name],
      blobs: toBlobs(fields, extraBlob),
      doubles: toDoubles(metrics),
    });
  } catch (err) {
    logWarn("telemetry_write_failed", { name, message: err instanceof Error ? err.message : String(err) });
  }
}

// ───────────────────────── 이벤트별 헬퍼(docs/06 §5.2 표) ─────────────────────────

/** visit — 세션 bootstrap 성공 시 세션당 1회(routes/session.ts). */
export async function trackVisit(env: Pick<Env, "AE">, pid: string, opts: { geo?: string } = {}): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  writeTelemetryEvent(env, "visit", { userIdHash, geo: opts.geo });
}

/** retention_ping — bootstrap 시 마지막 방문일과 비교한 D1/D7/D30 코호트 플래그(구현 결정 —
 *  파일 상단 주석의 blobs[10] 확장 규약 참조). */
export async function trackRetentionPing(
  env: Pick<Env, "AE">,
  pid: string,
  flags: { d1: boolean; d7: boolean; d30: boolean },
  opts: { geo?: string } = {},
): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  const extra = `d1:${flags.d1 ? 1 : 0},d7:${flags.d7 ? 1 : 0},d30:${flags.d30 ? 1 : 0}`;
  writeTelemetryEvent(env, "retention_ping", { userIdHash, geo: opts.geo }, undefined, extra);
}

/** game_start — POST /runs/start. */
export async function trackGameStart(
  env: Pick<Env, "AE">,
  pid: string,
  opts: { modeKey: string; lang: string; platform: string },
): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  writeTelemetryEvent(env, "game_start", { userIdHash, ...opts });
}

/** game_finish — POST /runs/submit 처리 완료 시(verdict 무관 — verdict 자체가 slots[6]에 실림). */
export async function trackGameFinish(
  env: Pick<Env, "AE">,
  pid: string,
  fields: { modeKey: string; lang: string; platform: string; geo?: string; verdict: string },
  metrics: TelemetryMetrics,
): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  writeTelemetryEvent(env, "game_finish", { userIdHash, ...fields }, metrics);
}

/** daily_play — 데일리 첫 정식 제출(runs.ts dailyFirstValid). */
export async function trackDailyPlay(
  env: Pick<Env, "AE">,
  pid: string,
  opts: { modeKey: string; lang: string; platform: string; geo?: string },
): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  writeTelemetryEvent(env, "daily_play", { userIdHash, ...opts });
}

/** mp_queue — 퀵매치 좌석 배정 성공 시(routes/multi.ts POST /match/quick). */
export async function trackMpQueue(env: Pick<Env, "AE">, pid: string, opts: { lang: string }): Promise<void> {
  const userIdHash = await sha256Hex16(pid);
  writeTelemetryEvent(env, "mp_queue", { userIdHash, lang: opts.lang, modeKey: "race-mixed" });
}

/** mp_match_start — DO 방이 COUNTDOWN→RACING 전환 시(1행/플레이어, 봇 제외). */
export async function trackMpMatchStart(
  env: Pick<Env, "AE">,
  playerIds: string[],
  opts: { lang: string },
): Promise<void> {
  await Promise.all(
    playerIds.map(async (pid) => {
      const userIdHash = await sha256Hex16(pid);
      writeTelemetryEvent(env, "mp_match_start", { userIdHash, lang: opts.lang, modeKey: "race-mixed" });
    }),
  );
}

/** mp_match_finish — DO 방이 FINISHED 확정 시(1행/플레이어, 봇 제외). */
export async function trackMpMatchFinish(
  env: Pick<Env, "AE">,
  rows: Array<{ playerId: string; finished: boolean; cpm: number; pi: number; accMilli: number; elapsedMs: number }>,
  opts: { lang: string },
): Promise<void> {
  await Promise.all(
    rows.map(async (r) => {
      const userIdHash = await sha256Hex16(r.playerId);
      writeTelemetryEvent(
        env,
        "mp_match_finish",
        { userIdHash, lang: opts.lang, modeKey: "race-mixed" },
        { cpm: r.cpm, pi: r.pi, accMilli: r.accMilli, elapsedMs: r.elapsedMs, completed: r.finished },
      );
    }),
  );
}

/** share_click — GET /r/:shareId 히트(서버 측, 비인증이라 userIdHash는 빈 문자열). */
export function trackShareClick(
  env: Pick<Env, "AE">,
  opts: { referrerHost?: string; utmSource?: string } = {},
): void {
  writeTelemetryEvent(env, "share_click", { userIdHash: "", ...opts });
}

/** game_abandon — cron/retention.ts 일괄 집계(개인 단위가 아니라 날짜당 1행 카운트). */
export function trackGameAbandon(env: Pick<Env, "AE">, opts: { dateKst: string; count: number }): void {
  writeTelemetryEvent(env, "game_abandon", { userIdHash: "" }, undefined, `date:${opts.dateKst},count:${opts.count}`);
}

/** client_error — POST /api/v1/t 배치(routes/t.ts). 스택 상위 3프레임만 blobs[10]에 싣는다. */
export async function trackClientError(
  env: Pick<Env, "AE">,
  pid: string | null,
  opts: { message: string; top3Frames: string },
): Promise<void> {
  const userIdHash = pid ? await sha256Hex16(pid) : "";
  writeTelemetryEvent(
    env,
    "client_error",
    { userIdHash },
    undefined,
    `msg:${opts.message.slice(0, 120)}|frames:${opts.top3Frames.slice(0, 300)}`,
  );
}
