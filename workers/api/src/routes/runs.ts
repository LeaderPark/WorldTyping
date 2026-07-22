// spec: docs/04 §6.1(생명주기)·§6.2(검증 10단계)·§2.3-4/5(RunStart/RunSubmit 스키마), docs/06 §3.1(서명
//       세션·rejected는 HTTP 200)·§3.2(재계산)·§3.5(섀도우밴 누적 3회)·§2.3(데일리 1일 1회·스트릭),
//       docs/00 §11-D5·§11-D16(제출 경로 동기, Queue 금지)·§11-D21·§11-D38(user_id=pid) + WT-M3-03
//
// POST /runs/start — 세트 확정 + 서명 runToken 발급(KV sess:{rid}는 미설정, submit에서 사용 플래그).
// POST /runs/submit — 클라 점수를 절대 믿지 않는 서버 권위 검증. verdict='valid'만 리더보드에 도달
//   (UPSERT·rank 인라인은 WT-M3-04에서 결합; 이 태스크는 verdict 판별 + runs INSERT까지).
//
// rejected는 HTTP 200 + verdict:'rejected'로 응답한다(4xx로 어뷰저에게 탐지 신호를 주지 않음,
// docs/06 §3.1). verdict_reason은 DB에만 기록하고 응답에는 노출하지 않는다.
import { Hono } from "hono";
import { z } from "zod";
import {
  verifyToken,
  signRunToken,
  RunTokenPayloadSchema,
  RUN_TOKEN_TTL_MS,
  type RunTokenPayload,
} from "@wt/shared";
import type { Env } from "../env";
import type { RunVerdict } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { getGeoCountry } from "../lib/ip-hash";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";
import { uuidv7 } from "../lib/uuid";
import { kstDate, kstYesterday } from "../lib/kst";
import { loadAnticheatConfig } from "../lib/anticheat-config";
import { buildSetForStart, rebuildSet, computeSetHash, type SingleMode } from "../lib/set-builder";
import { verifyRun, type ServerValues } from "../lib/run-verify";
import {
  activeSeasonPeriod,
  allBoardKey,
  boardKeysForRun,
  inlineRankForRun,
  upsertBestStmts,
  DIRTY_TTL_SEC,
  type InlineRank,
} from "../lib/lb";
import { evaluateRunAchievements } from "../lib/achievements";
import { ensureDailySeed } from "../cron/daily-seed";
import { buildDailyShareText } from "../lib/share-text";
import { generateShareId } from "../lib/share-id";
import { logWarn } from "../lib/log";
import { trackDailyPlay, trackGameFinish, trackGameStart } from "../lib/telemetry";

/** run 세션 사용 플래그 TTL(docs/06 §3.1 — 2h). */
const SESS_FLAG_TTL_SEC = 2 * 60 * 60;

const ContinentSchema = z.enum([
  "asia",
  "europe",
  "africa",
  "north-america",
  "south-america",
  "oceania",
]);

const RunStartReqSchema = z
  .object({
    mode: z.enum(["continent", "tier", "worldtour", "daily"]),
    lang: z.enum(["ko", "en"]),
    platform: z.enum(["desktop", "mobile"]),
    continent: ContinentSchema.optional(),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  })
  .strict()
  .refine((v) => v.mode !== "continent" || v.continent !== undefined, {
    message: "mode=continent에는 continent가 필요합니다.",
  })
  .refine((v) => v.mode !== "tier" || v.tier !== undefined, {
    message: "mode=tier에는 tier가 필요합니다.",
  });

const PerCountrySchema = z
  .object({
    code: z.string().min(1).max(8),
    ms: z.number().nonnegative(),
    keystrokes: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    skipped: z.boolean(),
    inputUsed: z.string().max(256),
  })
  .strict();

const RunSubmitReqSchema = z
  .object({
    runToken: z.string().min(1).max(4096),
    result: z
      .object({
        elapsedMs: z.number().nonnegative(),
        totalKeystrokes: z.number().int().nonnegative(),
        correctKeystrokes: z.number().int().nonnegative(),
        maxCombo: z.number().int().nonnegative(),
        countriesCleared: z.number().int().nonnegative(),
        countriesSkipped: z.number().int().nonnegative(),
        livesLost: z.number().int().nonnegative(),
        finished: z.boolean(),
        perCountry: z.array(PerCountrySchema).min(1).max(200),
      })
      .strict(),
    clientScore: z.number(),
    inputDigest: z
      .object({
        n: z.number().int().nonnegative(),
        mean: z.number().nonnegative(),
        stdev: z.number().nonnegative(),
        p10: z.number().nonnegative(),
        p50: z.number().nonnegative(),
        p90: z.number().nonnegative(),
        burstMax: z.number().nonnegative(),
      })
      .strict(),
    nickname: z.string().min(1).max(64).optional(),
  })
  .strict();

interface RunStartRes {
  runToken: string;
  runId: string;
  serverStartTs: number;
  countryIds: string[];
  seed: string;
}

interface RunSubmitRes {
  verdict: RunVerdict;
  score: number;
  pi: number;
  cpm: number;
  accMilli: number;
  grade: string;
  completed: boolean;
  // 리더보드 순위 인라인(§1.4-③, WT-M3-04). 등재 대상(valid·비shadowban)이 아니면 전부 null.
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean | null;
  /** 이번 제출로 새로 획득한 unlock_id 목록(§9.2~9.4 — 결과 화면 토스트용). rejected/practice/
   *  shadowban은 항상 빈 배열(구현 세부 지시, achievements.ts 호출 게이트 참조). */
  newUnlocks: string[];
  /** 데일리 전용 Wordle식 공유 텍스트(§2.3, WT-M5-04). daily 모드가 아니거나 토큰 자체가
   *  무효(invalid_token/replay 조기 반환)면 null — 클라는 null이면 공유 텍스트 UI를 숨긴다. */
  shareText: string | null;
  /** OG 공유 랜딩 단축 id(§9.1, WT-M6-02). 수리된 기록(rejected 아님)에만 발급 —
   *  `/r/{shareId}` 랜딩 + `/og/{shareId}.png` 카드. rejected/조기반환은 null. */
  shareId: string | null;
}

export const runs = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ───────────────────────── POST /runs/start ─────────────────────────

runs.post("/runs/start", requireAuth, rateLimit("runs/start"), async (c) => {
  const pid = c.get("pid");
  const parsed = RunStartReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "runs/start 요청 형식이 올바르지 않습니다.");
  }
  const { mode, lang, platform, continent, tier } = parsed.data;

  const now = Date.now();
  const built = await buildSetForStart(c.env, { mode: mode as SingleMode, continent, tier }, now);
  const setHash = await computeSetHash(built.countryIds);
  const rid = uuidv7(now);

  const runToken = await signRunToken(
    c.env.RUN_HMAC_SECRET,
    { rid, pid, mode, modeKey: built.modeKey, lang, platform, setHash, seed: built.seed },
    now,
  );

  const body: RunStartRes = {
    runToken,
    runId: rid,
    serverStartTs: now,
    countryIds: built.countryIds,
    seed: built.seed,
  };

  // game_start(docs/06 §5.2) + 일별 시작 카운터(cron/retention.ts game_abandon 근사, WT-M6-03) —
  // 응답을 막지 않는다.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await trackGameStart(c.env, pid, { modeKey: built.modeKey, lang, platform });
        if (c.env.KV) {
          await bumpDailyCounter(c.env.KV, KV_KEYS.telStarts(kstDate(now)));
        }
      } catch (err) {
        logWarn("runs_start_telemetry_failed", { message: err instanceof Error ? err.message : String(err) });
      }
    })(),
  );

  return c.json(body);
});

// ───────────────────────── POST /runs/submit ─────────────────────────

runs.post("/runs/submit", requireAuth, rateLimit("runs/submit"), async (c) => {
  const pid = c.get("pid");
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");

  const parsed = RunSubmitReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "runs/submit 요청 형식이 올바르지 않습니다.");
  }
  const body = parsed.data;
  const now = Date.now();

  // 토큰 검증(서명/exp) — 실패 시 HTTP 200 rejected. 신뢰 가능한 run 식별자가 없어 INSERT하지 않는다.
  const verified = await verifyToken(body.runToken, c.env.RUN_HMAC_SECRET, RunTokenPayloadSchema, now);
  if (!verified.ok) return c.json(submitRes("rejected", ZERO));
  const token: RunTokenPayload = verified.payload;

  const config = await loadAnticheatConfig(c.env.KV);

  // 토큰만으로 세트 재현(서버 권위 기준 세트) + 무결성 해시.
  const fullSet = await rebuildSet(c.env, token);
  const rebuiltSetHash = await computeSetHash(fullSet);

  // ② 리플레이 플래그(KV sess:{rid}) 조회.
  const alreadyUsed = c.env.KV ? (await c.env.KV.get(KV_KEYS.session(token.rid))) !== null : false;

  // 과거 기록 요약(휴리스틱 + 데일리 1일 1회 판정) — 한 번의 집계 쿼리로 해소.
  const personal = await loadPersonalStats(db, pid, token.modeKey);

  const vr = verifyRun({
    sessionPid: pid,
    token,
    rebuiltSetHash,
    fullSet,
    alreadyUsed,
    submit: { result: body.result, clientScore: body.clientScore, inputDigest: body.inputDigest },
    now,
    runTokenTtlMs: RUN_TOKEN_TTL_MS,
    config,
    personal: {
      sampleSize: personal.boardValidCount,
      bestPi: personal.boardBestPi,
      isFirstSubmission: personal.accountValidCount === 0,
    },
  });

  // ①(pid 불일치)·②(리플레이)는 신뢰 가능한 신규 run이 아니다 → INSERT/KV 마킹 없이 응답만.
  //   - invalid_token: 남의 토큰 → 이 세션 유저에 귀속 불가.
  //   - replay: 동일 rid 행이 이미 존재(run_id PK) → 재삽입 불가.
  if (vr.verdict === "rejected" && (vr.verdictReason === "invalid_token" || vr.verdictReason === "replay")) {
    return c.json(submitRes(vr.verdict, vr.server));
  }

  // 토큰 소비(일회용) — reject 여부와 무관하게 사용 플래그를 남겨 재제출을 차단한다.
  if (c.env.KV) {
    await c.env.KV.put(KV_KEYS.session(token.rid), "1", { expirationTtl: SESS_FLAG_TTL_SEC });
  }

  // 데일리 1일 1회 등재(§2.3): 같은 (uid, daily:{date})에 이미 정식 기록이 있으면 practice 강등.
  //   boardValidCount는 modeKey 기준이므로 daily 보드에서 곧 "이 날짜의 과거 정식 제출 수"다.
  let finalVerdict: RunVerdict = vr.verdict;
  let finalReason = vr.verdictReason;
  let dailyFirstValid = false;
  if (token.mode === "daily" && vr.verdict === "valid") {
    if (personal.boardValidCount > 0) {
      finalVerdict = "practice";
      finalReason = "daily_practice";
    } else {
      dailyFirstValid = true; // 첫 정식 제출 → 스트릭 갱신
    }
  }

  // 섀도우밴(§3.5): rejected 누적(이번 판 포함)이 임계 도달 시 자동 shadowbanned.
  const newRejectedCount = personal.rejectedCount + (finalVerdict === "rejected" ? 1 : 0);
  const shadowban = newRejectedCount >= config.rejectedShadowbanThreshold;

  const geo = getGeoCountry(c);
  const stmts = [
    insertRunStmt(db, {
      runId: token.rid,
      userId: pid,
      token,
      server: vr.server,
      verdict: finalVerdict,
      verdictReason: finalReason,
      geo,
      detailJson: JSON.stringify({
        result: body.result,
        clientScore: body.clientScore,
        inputDigest: body.inputDigest,
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
      }),
      now,
    }),
  ];
  if (dailyFirstValid) {
    const today = kstDate(now);
    stmts.push(streakStmt(db, pid, today, kstYesterday(today), now));
  }
  if (shadowban) {
    stmts.push(shadowbanStmt(db, pid, now));
  }

  // 공유 랜딩 share_id 발급(§9.1, WT-M6-02): 수리된 기록(rejected 아님)에만. runs INSERT와 같은
  // batch에 넣어 원자적으로 확정한다(share가 run보다 먼저 커밋되는 경합 없음). 섀도우밴 여부와
  // 무관(카드는 개인 기록 — 랭킹 노출과 별개, achievements 게이트와 동일 논리).
  const shareId = finalVerdict !== "rejected" ? generateShareId() : null;
  if (shareId) {
    stmts.push(shareInsertStmt(db, shareId, token.rid, now));
  }

  // 리더보드 등재(§1.3): verdict='valid' + 비-shadowban일 때만 lb_best UPSERT(§3.5 — shadowban은
  // runs만 기록). daily 보드는 첫 정식 기록만이므로(practice 강등된 재도전은 여기 도달 안 함)
  // DO NOTHING 분기로 안전하게 처리한다. UPSERT는 runs INSERT와 같은 batch에 넣어 원자 반영.
  const doBoard = finalVerdict === "valid" && !shadowban;
  let boardKeys: string[] = [];
  if (doBoard) {
    const seasonPeriod = await activeSeasonPeriod(db, now); // v1은 항상 null(§11-D15)
    boardKeys = boardKeysForRun({
      modeKey: token.modeKey,
      lang: token.lang,
      platform: token.platform,
      now,
      activeSeasonPeriod: seasonPeriod,
    });
    stmts.push(
      ...upsertBestStmts(db, {
        boardKeys,
        userId: pid,
        runId: token.rid,
        score: vr.server.score,
        elapsedMs: vr.server.elapsedMs,
        accMilli: vr.server.accMilli,
        achievedAt: now,
        geo,
        isDaily: token.mode === "daily",
      }),
    );
  }

  await db.batch(stmts);

  let inline: InlineRank | undefined;
  if (doBoard) {
    // dirty 마킹(§1.5): cron(*/1)이 이 보드들만 top-100 재조회한다.
    if (c.env.KV) {
      const kv = c.env.KV;
      await Promise.all(boardKeys.map((bk) => kv.put(KV_KEYS.dirty(bk), "1", { expirationTtl: DIRTY_TTL_SEC })));
    }
    // rank/total/isPersonalBest 인라인(§1.4-③) — all 보드 기준, 추가 왕복 없음.
    inline = await inlineRankForRun(db, allBoardKey(token.modeKey, token.lang, token.platform), pid, token.rid);
  }

  // 업적/커버/스탬프(§9.2~9.4, docs/06 §4.3) — runs INSERT가 이미 커밋된 뒤에만 호출한다(집계
  // 쿼리가 이번 판을 포함해야 함, achievements.ts 상단 주석의 호출 계약). shadowban 여부와
  // 무관하게 valid 판이면 판정한다(랭킹 노출과 개인 업적 달성은 별개 — 최종 보고 escalations).
  let newUnlocks: string[] = [];
  if (finalVerdict === "valid") {
    newUnlocks = await evaluateRunAchievements(db, {
      userId: pid,
      modeKey: token.modeKey,
      lang: token.lang,
      server: { completed: vr.server.completed, grade: vr.server.grade, cpm: vr.server.cpm, maxCombo: vr.server.maxCombo },
      totalKeystrokes: body.result.totalKeystrokes,
      correctKeystrokes: body.result.correctKeystrokes,
      livesLost: body.result.livesLost,
      perCountry: body.result.perCountry,
      isDailyFirstValid: dailyFirstValid,
      now,
    });
  }

  // 데일리 공유 텍스트(§2.3, WT-M5-04) — perCountry는 클라 제출값 그대로 쓴다("포맷 단일화
  // 목적, 클라 조작 여지 제거 목적이 아니다"), 점수/등급만 서버 재계산값(vr.server). dailyNo는
  // ensureDailySeed가 오늘 행을 그대로 읽어 돌려준다(cron/즉석발행 시점에 이미 존재 — 여기서는
  // 순수 조회라 추가 INSERT가 없다).
  let shareText: string | null = null;
  if (token.mode === "daily") {
    const dailySeed = await ensureDailySeed(c.env, now);
    shareText = buildDailyShareText({
      dailyNo: dailySeed.dailyNo,
      lang: token.lang,
      totalCountries: fullSet.length,
      perCountry: body.result.perCountry,
      cpm: vr.server.cpm,
      accMilli: vr.server.accMilli,
      pi: vr.server.pi,
      grade: vr.server.grade,
      publicOrigin: c.env.PUBLIC_ORIGIN,
    });
  }

  // game_finish(+ 데일리 첫 정식 제출이면 daily_play) + 일별 제출 카운터(docs/06 §5.2, WT-M6-03)
  // — 응답을 막지 않는다. runs INSERT가 이미 성공했으므로(위 db.batch) 이 시점부터는 순수 부가
  // 관측이다.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await trackGameFinish(
          c.env,
          pid,
          { modeKey: token.modeKey, lang: token.lang, platform: token.platform, geo: geo ?? undefined, verdict: finalVerdict },
          {
            score: vr.server.score,
            pi: vr.server.pi,
            cpm: vr.server.cpm,
            accMilli: vr.server.accMilli,
            elapsedMs: vr.server.elapsedMs,
            countriesCleared: vr.server.countriesCleared,
            skipped: vr.server.countriesSkipped,
            completed: vr.server.completed,
          },
        );
        if (dailyFirstValid) {
          await trackDailyPlay(c.env, pid, { modeKey: token.modeKey, lang: token.lang, platform: token.platform, geo: geo ?? undefined });
        }
        if (c.env.KV) {
          await bumpDailyCounter(c.env.KV, KV_KEYS.telSubmits(kstDate(now)));
        }
      } catch (err) {
        logWarn("runs_submit_telemetry_failed", { message: err instanceof Error ? err.message : String(err) });
      }
    })(),
  );

  return c.json(submitRes(finalVerdict, vr.server, inline, newUnlocks, shareText, shareId));
});

// ───────────────────────── 응답/SQL 헬퍼 ─────────────────────────

const ZERO: ServerValues = {
  score: 0,
  pi: 0,
  cpm: 0,
  accMilli: 0,
  grade: "D",
  completed: false,
  maxCombo: 0,
  countriesCleared: 0,
  countriesSkipped: 0,
  elapsedMs: 0,
};

function submitRes(
  verdict: RunVerdict,
  s: ServerValues,
  inline?: InlineRank,
  newUnlocks: string[] = [],
  shareText: string | null = null,
  shareId: string | null = null,
): RunSubmitRes {
  return {
    verdict,
    score: s.score,
    pi: s.pi,
    cpm: s.cpm,
    accMilli: s.accMilli,
    grade: s.grade,
    completed: s.completed,
    rank: inline?.rank ?? null,
    total: inline?.total ?? null,
    isPersonalBest: inline ? inline.isPersonalBest : null,
    newUnlocks,
    shareText,
    shareId,
  };
}

/** 일별 KV 카운터 증분(game_abandon 근사 집계, cron/retention.ts 소비). TTL은 다음날 01:30
 *  크론이 읽고 지나가기에 충분한 여유(3일)만 준다 — 정밀 한도 판정 목적이 아니라 KV 최종
 *  일관성으로 충분하다(§7 gotcha 8과 동일 원칙). */
async function bumpDailyCounter(kv: KVNamespace, key: string): Promise<void> {
  const raw = await kv.get(key);
  const count = raw ? Number(raw) : 0;
  await kv.put(key, String(count + 1), { expirationTtl: 3 * 24 * 60 * 60 });
}

/** shares INSERT(§9.1) — runs INSERT와 같은 batch에 넣어 원자 반영. */
function shareInsertStmt(db: D1Database, shareId: string, runId: string, now: number): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO shares (share_id, run_id, created_at) VALUES (?1, ?2, ?3)`)
    .bind(shareId, runId, now);
}

interface PersonalStatsRow {
  board_valid_count: number | null;
  board_best_pi: number | null;
  account_valid_count: number | null;
  rejected_count: number | null;
}

interface PersonalStats {
  boardValidCount: number;
  boardBestPi: number | null;
  accountValidCount: number;
  rejectedCount: number;
}

/**
 * 이 유저의 과거 기록 요약을 단일 집계 쿼리로 조회한다(CASE WHEN — FILTER 미지원 SQLite 대비 이식성).
 * board_* 는 mode_key 한정, account_valid_count는 계정 전체, rejected_count는 섀도우밴 누적 판정용.
 */
async function loadPersonalStats(db: D1Database, userId: string, modeKey: string): Promise<PersonalStats> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN verdict='valid' AND mode_key = ?2 THEN 1 ELSE 0 END)  AS board_valid_count,
         MAX(CASE WHEN verdict='valid' AND mode_key = ?2 THEN pi END)        AS board_best_pi,
         SUM(CASE WHEN verdict='valid' THEN 1 ELSE 0 END)                    AS account_valid_count,
         SUM(CASE WHEN verdict='rejected' THEN 1 ELSE 0 END)                 AS rejected_count
       FROM runs WHERE user_id = ?1`,
    )
    .bind(userId, modeKey)
    .first<PersonalStatsRow>();
  return {
    boardValidCount: Number(row?.board_valid_count ?? 0),
    boardBestPi: row?.board_best_pi ?? null,
    accountValidCount: Number(row?.account_valid_count ?? 0),
    rejectedCount: Number(row?.rejected_count ?? 0),
  };
}

interface InsertRunArgs {
  runId: string;
  userId: string;
  token: RunTokenPayload;
  server: ServerValues;
  verdict: RunVerdict;
  verdictReason: string | null;
  geo: string | null;
  detailJson: string;
  now: number;
}

function insertRunStmt(db: D1Database, a: InsertRunArgs): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO runs (
         run_id, user_id, mode_key, lang, platform,
         score, pi, cpm, acc_milli, elapsed_ms,
         countries_cleared, countries_skipped, max_combo, completed, grade,
         seed, session_id, verdict, verdict_reason, geo, detail_json, created_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9, ?10,
         ?11, ?12, ?13, ?14, ?15,
         ?16, ?17, ?18, ?19, ?20, ?21, ?22
       )`,
    )
    .bind(
      a.runId,
      a.userId,
      a.token.modeKey,
      a.token.lang,
      a.token.platform,
      a.server.score,
      a.server.pi,
      a.server.cpm,
      a.server.accMilli,
      a.server.elapsedMs,
      a.server.countriesCleared,
      a.server.countriesSkipped,
      a.server.maxCombo,
      a.server.completed ? 1 : 0,
      a.server.grade,
      a.token.seed,
      a.runId, // session_id = rid (KV sess:{rid}와 동일 식별자)
      a.verdict,
      a.verdictReason,
      a.geo,
      a.detailJson,
      a.now,
    );
}

/** 스트릭 갱신(§2.3): streak_updated가 어제면 +1, 아니면 1로 리셋. */
function streakStmt(
  db: D1Database,
  userId: string,
  today: string,
  yesterday: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET
         streak_daily = CASE WHEN streak_updated = ?2 THEN streak_daily + 1 ELSE 1 END,
         streak_updated = ?3,
         updated_at = ?4
       WHERE user_id = ?1`,
    )
    .bind(userId, yesterday, today, now);
}

/** 섀도우밴(§3.5): active 유저만 shadowbanned로. banned/deleted는 건드리지 않는다. */
function shadowbanStmt(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE users SET status = 'shadowbanned', updated_at = ?2 WHERE user_id = ?1 AND status = 'active'`)
    .bind(userId, now);
}
