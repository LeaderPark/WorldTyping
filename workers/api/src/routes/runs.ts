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
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  verifyToken,
  signRunToken,
  RunTokenPayloadSchema,
  SessionPayloadSchema,
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
import { verifyChaseRun } from "../lib/chase-verify";
import { loadChaseConstants, resolveChaseConstantsCandidates } from "../lib/chase-config";
import {
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
    // D68-④ 게스트→계정 브리지 토큰(옵션). 계정 세션이 게스트 시절 시작한 판을 결과 화면에서
    //   등재하려 할 때, 게스트 신원 보유를 증명하는 게스트 세션 토큰(wt1)을 함께 보낸다. 서명이
    //   유효하고 pid가 runToken.pid와 일치할 때만 소유권을 인정한다(§11-D68-④).
    guestToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

// ── chase(골드 러너) 제출 바디(docs/09 §9.2, WT-CH-09) ──────────────────────────────────────
// 기존 5모드(RunSubmitReqSchema)와 완전히 다른 모양(moveLog/runLog/clientResult) — 둘 다
// .strict()라 필드 집합이 겹치지 않으므로 아래 /runs/submit 핸들러가 바디 모양만으로 안전하게
// 분기할 수 있다(토큰 내용을 먼저 열어볼 필요 없음).

const ChaseMoveLogEntrySchema = z
  .object({
    hopIndex: z.number().int().nonnegative(),
    countryId: z.string().min(2).max(8),
    tMs: z.number().nonnegative(),
  })
  .strict();

/** runLog 1홉 요약 — moveLog와 1:1(hopIndex로 대응). ms는 moveLog[i].tMs 차분에서 서버가 직접
 *  산출하므로 담지 않는다(클라 제출 여지를 최소화 — 서버가 유일하게 신뢰하는 시각축). */
const ChaseHopStatSchema = z
  .object({
    hopIndex: z.number().int().nonnegative(),
    keystrokes: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();

const ChaseClientResultSchema = z
  .object({
    score: z.number(),
    pi: z.number(),
    stats: z
      .object({
        totalKeystrokes: z.number().int().nonnegative(),
        correctKeystrokes: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
        maxCombo: z.number().int().nonnegative(),
      })
      .strict(),
    // D95: 체포 외에 자수(resigned)도 정상 종료 — 미체포 상태의 endedAtMs 시점 종료로 재계산 검증.
    outcome: z.enum(["arrested", "resigned"]),
    endedAtMs: z.number().nonnegative(),
    arrestedAtMs: z.number().nonnegative().optional(),
  })
  .strict();

// moveLog/runLog 상한(2000)은 심 CPU 예산(§9.2 — 10분 런 ≈ 수백 이벤트)의 수십 배 여유를 둔
// 방어적 상한(비정상 장시간·봇 제출로 인한 검증 비용 폭주를 차단하되 정상 장기 생존 런은 여유롭게 수용).
const ChaseSubmitReqSchema = z
  .object({
    runToken: z.string().min(1).max(4096),
    moveLog: z.array(ChaseMoveLogEntrySchema).max(2000),
    runLog: z.array(ChaseHopStatSchema).max(2000),
    clientResult: ChaseClientResultSchema,
    // D68-④ 게스트→계정 브리지 — 기존 5모드 제출과 동일 계약(아래 handleChaseSubmit 참조).
    guestToken: z.string().min(1).max(4096).optional(),
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
  const built = await buildSetForStart(c.env, { mode: mode as SingleMode, lang, continent, tier }, now);
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
  // 계정(Google 로그인) 세션인지 — 랭킹 게이팅(§11-D68-①)의 단일 신호. requireAuth가 항상 세팅한다.
  const isAcct = c.get("acct");
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");

  const raw = await c.req.json().catch(() => undefined);
  const now = Date.now();

  // mode:'chase' 제출 분기(WT-CH-09, docs/09 §9.2) — 바디 모양이 완전히 달라(moveLog/runLog/
  // clientResult) 기존 스키마 검증보다 먼저 시도한다. 실패하면 기존 5모드 경로로 그대로 흘러가
  // 아래 RunSubmitReqSchema가 처리한다(무회귀 — 두 스키마는 .strict()라 필드 집합이 겹치지 않음).
  const chaseParsed = ChaseSubmitReqSchema.safeParse(raw);
  if (chaseParsed.success) {
    return handleChaseSubmit(c, db, chaseParsed.data, pid, isAcct, now);
  }

  const parsed = RunSubmitReqSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "runs/submit 요청 형식이 올바르지 않습니다.");
  }
  const body = parsed.data;

  // 토큰 검증(서명/exp) — 실패 시 HTTP 200 rejected. 신뢰 가능한 run 식별자가 없어 INSERT하지 않는다.
  const verified = await verifyToken(body.runToken, c.env.RUN_HMAC_SECRET, RunTokenPayloadSchema, now);
  if (!verified.ok) return c.json(submitRes("rejected", ZERO));
  const token: RunTokenPayload = verified.payload;

  // D68-④ 게스트→계정 브리지. verifyRun ①(토큰 pid ↔ 세션 pid)의 소유권 비교 대상 pid를 정한다.
  //   기본은 세션 pid다. 계정 세션이 "게스트 시절 시작한 판"(runToken.pid ≠ 세션 pid)을 제출하는
  //   경우에 한해, guestToken(유효 wt1 + pid === runToken.pid)으로 두 신원 동시 보유를 증명하면
  //   소유권을 인정해 verifyPid = runToken.pid로 통과시킨다. 원장 user_id는 아래 insertRunStmt가
  //   세션 pid(=계정 pid)로 등재하므로 "남의 토큰은 귀속 불가"(04 §6.2-①) 성질이 유지된다.
  //   증명 실패(guestToken 부재/서명 무효/pid 불일치, 또는 게스트 세션 제출)면 verifyPid는 세션 pid
  //   그대로라 verifyRun ①이 invalid_token으로 거부한다(기존 규약 — 아래 조기 반환).
  let verifyPid = pid;
  if (token.pid !== pid && isAcct && body.guestToken) {
    const gv = await verifyToken(
      body.guestToken,
      [c.env.SESSION_HMAC_SECRET, c.env.SESSION_HMAC_SECRET_PREV],
      SessionPayloadSchema,
      now,
    );
    if (gv.ok && gv.payload.pid === token.pid) verifyPid = token.pid;
  }

  const config = await loadAnticheatConfig(c.env.KV);

  // 토큰만으로 세트 재현(서버 권위 기준 세트) + 무결성 해시.
  const fullSet = await rebuildSet(c.env, token);
  const rebuiltSetHash = await computeSetHash(fullSet);

  // ② 리플레이 플래그(KV sess:{rid}) 조회.
  const alreadyUsed = c.env.KV ? (await c.env.KV.get(KV_KEYS.session(token.rid))) !== null : false;

  // 과거 기록 요약(휴리스틱 + 데일리 1일 1회 판정) — 한 번의 집계 쿼리로 해소.
  const personal = await loadPersonalStats(db, pid, token.modeKey);

  const vr = verifyRun({
    sessionPid: verifyPid,
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

  let finalVerdict: RunVerdict = vr.verdict;
  let finalReason = vr.verdictReason;

  // D68-① 랭킹 게이팅: 게스트(비계정) 세션 제출은 경쟁 랭킹 미도달 → practice/'guest'로 강등한다.
  //   원장 INSERT·데일리 alreadyPlayed 판정·안티치트 누적(아래)은 그대로 유지되고 lb_best UPSERT만
  //   막힌다(doBoard = finalVerdict==='valid'). rejected(물리·정합 위반)만 보존한다 — 섀도우밴
  //   누적과 invalid_token/replay 조기 반환이 rejected에 걸려 있기 때문. 그 외(valid/flagged/practice)는
  //   전부 practice/'guest'로 통일한다(게스트는 어느 쪽이든 비경쟁이라 사유를 단일화한다).
  if (!isAcct && finalVerdict !== "rejected") {
    finalVerdict = "practice";
    finalReason = "guest";
  }

  // 데일리 1일 1회 등재(§2.3): 같은 (uid, daily:{date})에 이미 정식 기록이 있으면 practice 강등.
  //   boardValidCount는 modeKey 기준이므로 daily 보드에서 곧 "이 날짜의 과거 정식 제출 수"다.
  //   판정은 게스트 강등 이후의 finalVerdict 기준 — 게스트 데일리는 이미 practice라 valid 분기에
  //   진입하지 않아 스트릭이 오르지 않는다(비경쟁 practice로 원장에만 남는다).
  let dailyFirstValid = false;
  if (token.mode === "daily" && finalVerdict === "valid") {
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
    // v1 스코프는 seasons 테이블에 행이 없어 activeSeasonPeriod(db, now)를 호출해도 항상 null만
    // 반환한다(§11-D15). 매 valid 제출마다 도는 이 SELECT 자체가 낭비이므로 상수 null로 고정한다
    // (§11-D60·WT-OPT-01) — lib/lb.ts의 activeSeasonPeriod 함수 본체는 시즌 기능 부활 시 재사용
    // 하도록 그대로 남겨둔다.
    const seasonPeriod: string | null = null;
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
    // dirty 마킹(§1.5): cron(*/1)이 이 보드들만 top-100 재조회한다. sentinel(§11-D60·WT-OPT-01)을
    // 같은 batch에 함께 put해 cron이 매분 dirty:* 전체를 list하기 전에 sentinel 1개 get만으로
    // "이번 분에 처리할 게 있는지"를 판별할 수 있게 한다(kv-keys.ts dirtySentinel 주석 참조).
    if (c.env.KV) {
      const kv = c.env.KV;
      await Promise.all([
        ...boardKeys.map((bk) => kv.put(KV_KEYS.dirty(bk), "1", { expirationTtl: DIRTY_TTL_SEC })),
        kv.put(KV_KEYS.dirtySentinel, "1", { expirationTtl: DIRTY_TTL_SEC }),
      ]);
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

// ───────────────────────── chase(골드 러너) 제출 분기(WT-CH-09) ─────────────────────────
// docs/09 §9.2 전문. 기존 5모드 파이프라인(verifyRun/rebuildSet — countryIds 세트 전제)과는
// 완전히 독립된 경로다: chase는 "세트"가 없고 심(@wt/shared simulateChase)이 매 홉 선택지를
// 그때그때 생성하므로, 세트 재현 대신 moveLog 재생성 대조로 서버 권위를 확보한다(chase-verify.ts
// verifyChaseRun — Gotcha 3: 심·판정·점수는 shared import만, 이 라우트에서 재구현하지 않는다).
// 기존 5모드 경로(위 블록)는 이 함수를 호출하지 않으며 완전히 그대로다(무회귀).

/** runToken.setHash="chase:v{n}"(routes/chase.ts 발급 규약)에서 발급 시점 constantsVersion을
 *  역파싱한다. 형식이 어긋나면(발급 코드 버그가 아니면 서명 검증을 통과할 수 없는 경우다 —
 *  HMAC이 페이로드 전체를 커버) null — 호출부가 현행 버전으로 관대하게 폴백한다. */
function parseIssuedChaseVersion(setHash: string): number | null {
  const m = /^chase:v(\d+)$/.exec(setHash);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

async function handleChaseSubmit(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  db: D1Database,
  body: z.infer<typeof ChaseSubmitReqSchema>,
  pid: string,
  isAcct: boolean,
  now: number,
): Promise<Response> {
  const verified = await verifyToken(body.runToken, c.env.RUN_HMAC_SECRET, RunTokenPayloadSchema, now);
  // mode!=='chase' 방어: 바디 모양은 chase지만 다른 모드의(예: 도난) runToken을 붙인 시도 —
  // 서명은 유효해도 이 경로에서 신뢰하지 않는다(rejected, 원장 미기록 — 기존 invalid_token과 동일 톤).
  if (!verified.ok || verified.payload.mode !== "chase") {
    return c.json(submitRes("rejected", ZERO));
  }
  const token = verified.payload;

  // D68-④ 게스트→계정 브리지 — 기존 5모드(위 /runs/submit 본 핸들러)와 완전히 동일한 계약.
  let verifyPid = pid;
  if (token.pid !== pid && isAcct && body.guestToken) {
    const gv = await verifyToken(
      body.guestToken,
      [c.env.SESSION_HMAC_SECRET, c.env.SESSION_HMAC_SECRET_PREV],
      SessionPayloadSchema,
      now,
    );
    if (gv.ok && gv.payload.pid === token.pid) verifyPid = token.pid;
  }

  const config = await loadAnticheatConfig(c.env.KV);
  const alreadyUsed = c.env.KV ? (await c.env.KV.get(KV_KEYS.session(token.rid))) !== null : false;

  // §9.4: 발급 시점 버전 → 후보 상수 목록(정상 경로는 후보 1개 = 현행 KV config:chase).
  const issuedVersion = parseIssuedChaseVersion(token.setHash);
  const { candidates, versionMismatch } =
    issuedVersion !== null
      ? await resolveChaseConstantsCandidates(c.env.KV, issuedVersion)
      : { candidates: [await loadChaseConstants(c.env.KV)], versionMismatch: false };

  const vr = verifyChaseRun({
    sessionPid: verifyPid,
    token,
    alreadyUsed,
    submit: { moveLog: body.moveLog, runLog: body.runLog, clientResult: body.clientResult },
    now,
    runTokenTtlMs: RUN_TOKEN_TTL_MS,
    config,
    constantsCandidates: candidates,
    versionMismatch,
  });

  // ①(pid 불일치)·②(리플레이) — 기존 5모드와 동일하게 신뢰 가능한 신규 run이 아니므로 INSERT 없음.
  if (vr.verdict === "rejected" && (vr.verdictReason === "invalid_token" || vr.verdictReason === "replay")) {
    return c.json(submitRes(vr.verdict, vr.server));
  }

  // 토큰 소비(일회용) — reject 여부와 무관하게 재제출 차단 플래그를 남긴다.
  if (c.env.KV) {
    await c.env.KV.put(KV_KEYS.session(token.rid), "1", { expirationTtl: SESS_FLAG_TTL_SEC });
  }

  let finalVerdict: RunVerdict = vr.verdict;
  let finalReason = vr.verdictReason;

  // D68-① 랭킹 게이팅 — 게스트(비계정) 제출은 practice/'guest'로 강등(기존 5모드와 동일 규약).
  if (!isAcct && finalVerdict !== "rejected") {
    finalVerdict = "practice";
    finalReason = "guest";
  }

  // 섀도우밴(§3.5) — modeKey='chase' 한정이 아니라 계정 전체 rejected 누적(loadPersonalStats와 동일
  // 집계, mode_key 인자는 board_valid_count/board_best_pi 산출에만 쓰이고 여기선 미사용).
  const personal = await loadPersonalStats(db, pid, token.modeKey);
  const newRejectedCount = personal.rejectedCount + (finalVerdict === "rejected" ? 1 : 0);
  const shadowban = newRejectedCount >= config.rejectedShadowbanThreshold;

  const geo = getGeoCountry(c);
  const stmts: D1PreparedStatement[] = [
    insertRunStmt(db, {
      runId: token.rid,
      userId: pid,
      token,
      server: vr.server,
      verdict: finalVerdict,
      verdictReason: finalReason,
      geo,
      // chase 고유 통계(moveLog/runLog/delivered 등)는 기존 스키마에 컬럼을 신설하지 않고
      // detail_json에 담는다(킷 에스컬레이션 항목 해소 — lb_best·runs는 기존 5모드와 완전히
      // 동일한 형태로 재사용하고, chase만의 부가 정보는 이 JSON이 유일한 저장소다).
      detailJson: JSON.stringify({
        moveLog: body.moveLog,
        runLog: body.runLog,
        clientResult: body.clientResult,
        delivered: vr.delivered,
      }),
      now,
    }),
  ];
  if (shadowban) {
    stmts.push(shadowbanStmt(db, pid, now));
  }

  const shareId = finalVerdict !== "rejected" ? generateShareId() : null;
  if (shareId) {
    stmts.push(shareInsertStmt(db, shareId, token.rid, now));
  }

  const doBoard = finalVerdict === "valid" && !shadowban;
  let boardKeys: string[] = [];
  if (doBoard) {
    boardKeys = boardKeysForRun({
      modeKey: token.modeKey,
      lang: token.lang,
      platform: token.platform,
      now,
      activeSeasonPeriod: null, // §11-D15·D60 — v1 시즌 없음(기존 5모드와 동일 상수 고정).
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
        isDaily: false,
      }),
    );
  }

  await db.batch(stmts);

  let inline: InlineRank | undefined;
  if (doBoard) {
    if (c.env.KV) {
      const kv = c.env.KV;
      await Promise.all([
        ...boardKeys.map((bk) => kv.put(KV_KEYS.dirty(bk), "1", { expirationTtl: DIRTY_TTL_SEC })),
        kv.put(KV_KEYS.dirtySentinel, "1", { expirationTtl: DIRTY_TTL_SEC }),
      ]);
    }
    inline = await inlineRankForRun(db, allBoardKey(token.modeKey, token.lang, token.platform), pid, token.rid);
  }

  // [구현 결정 — 최종 보고 escalations 참조] evaluateRunAchievements는 perCountry(기존 5모드
  // shape) 전제라 chase(moveLog 기반)를 아직 지원하지 않는다 — 이 태스크(WT-CH-09, 백엔드
  // 파이프라인) 스코프 밖으로 두고 newUnlocks=[] 고정. 업적 확장은 후속 태스크 소관.
  const newUnlocks: string[] = [];

  // game_finish + 일별 제출 카운터 — 응답을 막지 않는다(기존 5모드와 동일 패턴).
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
        if (c.env.KV) {
          await bumpDailyCounter(c.env.KV, KV_KEYS.telSubmits(kstDate(now)));
        }
      } catch (err) {
        logWarn("chase_submit_telemetry_failed", { message: err instanceof Error ? err.message : String(err) });
      }
    })(),
  );

  // shareText는 daily 전용 필드(§2.3, WT-M5-04) — chase는 항상 null(클라가 UI를 숨긴다).
  return c.json(submitRes(finalVerdict, vr.server, inline, newUnlocks, null, shareId));
}

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
 *  일관성으로 충분하다(§7 gotcha 8과 동일 원칙). routes/chase.ts(WT-CH-09)도 재사용한다 —
 *  export해 chase/start 텔레메트리가 동일 카운터 문법을 그대로 쓰게 한다. */
export async function bumpDailyCounter(kv: KVNamespace, key: string): Promise<void> {
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
