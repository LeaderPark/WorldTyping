// spec: docs/06 §2.1(데일리 세트 결정 전문 — 시드 산식·티어 분포·un195·seededShuffle)·§2.3(1일 1회는
//       routes/runs.ts 소관), docs/00 §11-D13(mulberry32 공유)·§11-D21(랭킹 세트는 서버 salt 전용),
//       docs/07 WT-M3-05 [구현 세부 지시 1·2]
//
// KST 00:00 cron(wrangler.toml "0 15 * * *")이 오늘자 데일리 세트를 확정 발행한다. 시드는
// SHA-256("wt-daily:"+dateKst+":"+DAILY_SALT) — salt는 Worker secret이라 클라는 재현 불가능하다
// (§11-D21, set-builder.ts의 tier 시드와 동일 원칙).
//
// 멱등: daily_challenges.date_kst가 PRIMARY KEY라 이미 발행된 날짜는 INSERT ... ON CONFLICT DO
// NOTHING으로 no-op(구현 세부 지시 2). ensureDailySeed는 cron과 routes/daily.ts(GET /daily/today의
// "cron 미실행 상태 폴백으로 즉석 생성" 경로, 구현 세부 지시 2) 양쪽이 공유하는 단일 진입점이다 —
// 동시 호출 레이스는 D1 PK 충돌로 자연 흡수되고, 최종적으로 어느 쪽이 이겼든 동일한 세트를 읽는다
// (시드가 dateKst+salt로만 결정되는 순수 함수라 레이스에서도 값이 갈리지 않는다).
import { seededShuffle, rngFromSeedHex, type CountryId, type DifficultyTier } from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import type { Env } from "../env";
import type { DailyChallengeRow } from "../db/types";
import { KV_KEYS } from "../lib/kv-keys";
import { sha256Hex } from "../lib/hash";
import { kstDate } from "../lib/kst";

/** 랭킹 대상 밖(extended) 국가 — set-builder.ts의 UN195 필터와 동일 집합(§11-D1). */
const EXTENDED_IDS = new Set<CountryId>(["TW", "XK", "EH"]);
const UN195 = COUNTRIES.filter((c) => !EXTENDED_IDS.has(c.id));

/** 티어별 출제 개수(GDD §9.1, docs/06 §2.1: T1×3+T2×3+T3×2+T4×1+T5×1). streamId=티어 번호. */
const TIER_COMPOSITION: readonly [DifficultyTier, number][] = [
  [1, 3],
  [2, 3],
  [3, 2],
  [4, 1],
  [5, 1],
];
/** 최종 10개 재셔플 스트림(구현 세부 지시 1 — "최종 10개 재셔플(streamId=9)"). */
const FINAL_SHUFFLE_STREAM = 9;

export interface DailySeedResult {
  dateKst: string;
  dailyNo: number;
  seed: string;
  countryIds: CountryId[];
  /** 이번 호출이 새로 발행했는지(true) / 이미 있던 행을 그대로 읽었는지(false, 멱등 no-op). */
  created: boolean;
}

/** 데일리 시드 hex(docs/06 §2.1 전문). salt는 서버 전용이라 이 파생은 서버에서만 가능하다(§11-D21). */
function dailySeedHex(env: Env, dateKst: string): Promise<string> {
  return sha256Hex(`wt-daily:${dateKst}:${env.DAILY_SALT}`);
}

/** 티어별 픽(streamId=티어 번호) + 최종 순서 셔플(streamId=9). start/rebuild 양쪽에서 재현 가능. */
function buildDailyCountryIds(seedHex: string): CountryId[] {
  const picked: CountryId[] = [];
  for (const [tier, n] of TIER_COMPOSITION) {
    const pool = UN195.filter((c) => c.difficultyTier === tier).map((c) => c.id);
    const shuffled = seededShuffle(pool, rngFromSeedHex(seedHex, tier));
    picked.push(...shuffled.slice(0, n));
  }
  return seededShuffle(picked, rngFromSeedHex(seedHex, FINAL_SHUFFLE_STREAM));
}

async function writeKvCache(
  env: Env,
  dateKst: string,
  dailyNo: number,
  seed: string,
  countryIds: CountryId[],
): Promise<void> {
  if (!env.KV) return;
  // set-builder.ts의 loadDailySet은 {seed, countryIds}만 방어적으로 취하고 나머지 키는 무시하므로
  // dailyNo를 함께 저장해도 그쪽 파싱과 어긋나지 않는다(그 파일 주석 — "KV 저장 shape는
  // WT-M3-05 소관"). 과거 날짜 값은 절대 바뀌지 않으므로 TTL 없이 영구 캐시한다.
  await env.KV.put(KV_KEYS.daily(dateKst), JSON.stringify({ seed, countryIds, dailyNo }));
}

async function readExistingRow(db: D1Database, dateKst: string): Promise<DailyChallengeRow | null> {
  const row = await db
    .prepare(`SELECT date_kst, daily_no, seed, country_ids, created_at FROM daily_challenges WHERE date_kst = ?1`)
    .bind(dateKst)
    .first<DailyChallengeRow>();
  return row ?? null;
}

/**
 * 오늘(또는 지정 시각 기준) 데일리 세트를 확정한다. 이미 해당 날짜 행이 있으면 그 값을 그대로
 * 반환한다(created:false). cron과 /daily/today 폴백이 이 함수 하나를 공유한다.
 */
export async function ensureDailySeed(env: Env, nowMs: number = Date.now()): Promise<DailySeedResult> {
  const db = env.DB;
  if (!db) throw new Error("ensureDailySeed: DB binding not configured");
  const dateKst = kstDate(nowMs);

  const existing = await readExistingRow(db, dateKst);
  if (existing) {
    // KV 캐시는 "신규 생성" 분기에서만 기록한다(§11-D60·WT-OPT-01) — 이 분기는 이미 발행된
    // 날짜를 그대로 읽는 순수 조회 경로다(routes/runs.ts의 daily 제출마다 호출되는 경로 포함).
    // cron/즉석발행이 최초 생성 시 이미 KV를 채워 뒀으므로 여기서 매번 재기록하는 건 낭비다
    // (routes/daily.ts의 GET /daily/today는 이 함수 호출 전에 자체 KV 히트를 먼저 확인하므로
    // 이 분기가 KV를 쓰지 않아도 그 라우트의 캐시 계약은 그대로 유지된다).
    const countryIds = JSON.parse(existing.country_ids) as CountryId[];
    return { dateKst, dailyNo: existing.daily_no, seed: existing.seed, countryIds, created: false };
  }

  const seed = await dailySeedHex(env, dateKst);
  const countryIds = buildDailyCountryIds(seed);

  // daily_no는 순차 증가(선례 없음 — docs/04 §4에 산식 미수록이라 이 구현이 채택). D1의 SQLite는
  // 집계(MAX) 서브쿼리를 낀 INSERT ... SELECT ... ON CONFLICT 조합을 파싱하지 못해(near "DO"
  // syntax error, 실측) 조회와 삽입을 분리했다 — VALUES 기반 INSERT는 ON CONFLICT를 문제없이
  // 받는다. 동시 INSERT 레이스는 date_kst PK 충돌로 흡수된다(ON CONFLICT DO NOTHING, 구현 세부
  // 지시 2). daily_no UNIQUE 충돌(서로 다른 날짜를 같은 순간에 처음 발행하는 경우)까지 흡수하진
  // 않지만, 이 잡은 "오늘" 날짜에만 실행되므로(cron·폴백 모두 dateKst=오늘) 실질적으로 발생하지
  // 않는다.
  const maxNoRow = await db.prepare(`SELECT MAX(daily_no) AS max_no FROM daily_challenges`).first<{
    max_no: number | null;
  }>();
  const nextNo = (maxNoRow?.max_no ?? 0) + 1;

  const insertResult = await db
    .prepare(
      `INSERT INTO daily_challenges (date_kst, daily_no, seed, country_ids, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(date_kst) DO NOTHING`,
    )
    .bind(dateKst, nextNo, seed, JSON.stringify(countryIds), nowMs)
    .run();
  const created = insertResult.meta.changes > 0;

  const row = await readExistingRow(db, dateKst);
  if (!row) throw new Error(`ensureDailySeed: insert-then-read failed for ${dateKst}`);
  const finalIds = JSON.parse(row.country_ids) as CountryId[];
  // KV 캐시는 이 호출이 실제로 새 행을 만들었을 때만 기록한다(§11-D60) — INSERT가 ON CONFLICT
  // DO NOTHING으로 흡수된 레이스 패자는 승자가 이미 캐시를 기록했다고 보고 재기록을 생략한다.
  if (created) {
    await writeKvCache(env, dateKst, row.daily_no, row.seed, finalIds);
  }
  return { dateKst, dailyNo: row.daily_no, seed: row.seed, countryIds: finalIds, created };
}
