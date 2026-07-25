// spec: docs/09 §9(백엔드 — /chase/start·submit 검증·lb·config)·§4.4(서버 검증 대조 항목)·§9.4
//       (constantsVersion 재계산), docs/00 §11-D90·D91·D93·D94·D95, WT-CH-09 [완료 조건]
//       — /chase/start→submit 왕복(체포·자수 각 1), moveLog 위조·시각 조작(단조성·물리 하한)·
//       점수 불일치 → 각 반려/플래그, constantsVersion 불일치 → practice 강등, 게스트 강등(D68).
//
// 로컬 드라이버는 @wt/shared의 simulateChase/computeChaseScore를 그대로 호출해 "서버가 재현할
// 값"을 미리 계산한다(판정·점수 재구현이 아니라 같은 함수를 호출하는 것 — 서버도 동일 함수를
// import한다, Gotcha 3). 정직한 홉(오타 0)은 물리 하한(L×minMsPerKeystroke) 대비 넉넉한 여유
// 시간을 둬 anticheat 검증을 자연히 통과시킨다.
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  simulateChase,
  compileGraph,
  mergeChaseConstants,
  CHASE_CONSTANTS_VERSION,
  computeChaseScore,
  requiredKeystrokes,
  signRunToken,
  type ChaseConstants,
  type ChaseCountryLookup,
  type ChaseState,
  type ChaseTypingStats,
  type ChaseWorld,
  type CountryId,
  type DifficultyTier,
  type MoveLogEntry,
} from "@wt/shared";
import { COUNTRIES, CHASE_GRAPH } from "@wt/data";
import { KV_KEYS } from "../src/lib/kv-keys";
import { DEFAULT_ANTICHEAT_CONFIG } from "../src/lib/anticheat-config";
import type { RunRow } from "../src/db/types";

const BASE = "http://local/api/v1";
const LANG = "en" as const;

// ── 실 그래프 오라클(@wt/data) — packages/shared/src/chase/simulate.test.ts realWorld()와 동일 패턴 ──

function realWorld(): ChaseWorld {
  const tiers: Record<string, DifficultyTier> = {};
  for (const c of COUNTRIES) tiers[c.id] = c.difficultyTier;
  return { graph: CHASE_GRAPH as unknown as ChaseWorld["graph"], tiers: tiers as ChaseWorld["tiers"] };
}
const world = realWorld();
const g = compileGraph(world.graph);
const countryLookup: ChaseCountryLookup = (() => {
  const out: Record<string, { nameKo: string; nameEn: string; difficultyTier: DifficultyTier }> = {};
  for (const c of COUNTRIES) out[c.id] = { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  return out as ChaseCountryLookup;
})();

// 검증이 실제 진행 시간(real wall-clock)과 결합되지 않도록(§6.2-3 시간 봉투) 유예를 넉넉히 잡는다
// — 자연 체포 시나리오는 경찰이 따라잡을 때까지 "런 로컬 클록"을 수십 초 전진시켜야 하는데, 테스트
// 실행 자체는 그 시간만큼 실제로 기다리지 않는다(config:chase 수치는 그대로 두고 config:anticheat만
// 완화 — production 튜닝과 무관한 테스트 전용 조정).
beforeAll(async () => {
  const cfg = { ...DEFAULT_ANTICHEAT_CONFIG, timeEnvelopeGraceMs: 180_000 };
  await env.KV.put(KV_KEYS.configAnticheat, JSON.stringify(cfg));
});

// ───────────────────────── 세션 부트스트랩(runs.test.ts와 동일 패턴) ─────────────────────────

async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sub: "chase-acct-" + crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

async function bootstrapGuest(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

interface ChaseStartRes {
  runToken: string;
  seed: number;
  constantsVersion: number;
}

function startChase(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/chase/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lang: LANG, platform: "desktop" }),
  });
}

interface ChaseSubmitRes {
  verdict: "valid" | "flagged" | "practice" | "rejected";
  score: number;
  pi: number;
  cpm: number;
  grade: string;
  completed: boolean;
  rank: number | null;
}

function submitChase(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/runs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// ───────────────────────── 로컬 드라이버(결정적 정직한 여정 구성) ─────────────────────────

interface HopStat {
  hopIndex: number;
  keystrokes: number;
  errors: number;
}

/** 홈에 가장 가까운 후보를 고른다 — 결정적이고 재현 가능한 순수 로컬 픽 전략
 *  (packages/shared/src/chase/simulate.test.ts의 pickDeliver/pickFlee와 같은 결). */
function pickNearHome(cands: readonly CountryId[], home: CountryId): CountryId {
  return [...cands].sort((a, b) => g.dist(home, a) - g.dist(home, b))[0]!;
}

/** 정직한(오타 0) 홉 1개 — 물리 하한(L×minMsPerKeystroke=35ms) 대비 넉넉한 여유(L×100ms, CPM ~600). */
function honestHop(
  hopIndex: number,
  prevT: number,
  countryId: CountryId,
): { entry: MoveLogEntry; stat: HopStat; tMs: number } {
  const country = countryLookup[countryId]!;
  const L = requiredKeystrokes(country, LANG);
  const hopMs = Math.max(200, L * 100);
  const tMs = prevT + hopMs;
  return { entry: { hopIndex, countryId, tMs }, stat: { hopIndex, keystrokes: L, errors: 0 }, tMs };
}

interface Journey {
  moveLog: MoveLogEntry[];
  runLog: HopStat[];
  lastT: number;
}

/** hops회, 매번 "홈에 가장 가까운 후보"를 골라 정직하게 전진하는 결정적 여정을 만든다. */
function buildJourney(seed: number, constants: ChaseConstants, hops: number): Journey {
  const moveLog: MoveLogEntry[] = [];
  const runLog: HopStat[] = [];
  let t = 0;
  for (let i = 0; i < hops; i++) {
    const probe = simulateChase({ seed, moveLog, endMs: t, constants }, world);
    if (probe.arrestedAtMs !== null) break;
    if (probe.candidates.length === 0) break;
    const choice = pickNearHome(probe.candidates, probe.home);
    const built = honestHop(moveLog.length, t, choice);
    moveLog.push(built.entry);
    runLog.push(built.stat);
    t = built.tMs;
  }
  return { moveLog, runLog, lastT: t };
}

function totalsOf(runLog: readonly HopStat[]): { totalKeystrokes: number; correctKeystrokes: number; maxCombo: number } {
  const totalKeystrokes = runLog.reduce((a, r) => a + r.keystrokes, 0);
  const totalErrors = runLog.reduce((a, r) => a + r.errors, 0);
  return { totalKeystrokes, correctKeystrokes: totalKeystrokes - totalErrors, maxCombo: runLog.length };
}

function expectedScore(
  seed: number,
  constants: ChaseConstants,
  moveLog: MoveLogEntry[],
  endMs: number,
  stats: ChaseTypingStats,
): { state: ChaseState; score: ReturnType<typeof computeChaseScore> } {
  const state = simulateChase({ seed, moveLog, endMs, constants }, world);
  const score = computeChaseScore(state, countryLookup, stats, LANG, constants);
  return { state, score };
}

// ───────────────────────── POST /chase/start ─────────────────────────

describe("POST /chase/start", () => {
  it("401 without a session bearer token", async () => {
    const res = await startChase("garbage");
    expect(res.status).toBe(401);
  });

  it("서명된 runToken + 서버 32bit seed + constantsVersion을 발급한다(게스트 세션도 허용)", async () => {
    const guest = await bootstrapGuest();
    const res = await startChase(guest.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChaseStartRes;
    expect(body.runToken).toMatch(/^wt1\./);
    expect(Number.isInteger(body.seed)).toBe(true);
    expect(body.seed).toBeGreaterThanOrEqual(0);
    // 발급 응답의 버전은 shared의 CHASE_CONSTANTS_VERSION 그대로다(§9.4) — v2 = §11-D114-B 경찰 감속.
    expect(body.constantsVersion).toBe(CHASE_CONSTANTS_VERSION);
    expect(body.constantsVersion).toBe(2);
  });
});

// ───────────────────────── POST /runs/submit — chase 정상 경로 ─────────────────────────

describe("POST /runs/submit — chase 정상 제출(§9.2)", () => {
  it("자수(resigned) 제출이 valid로 기록되고 서버 재계산 score/grade가 저장된다", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const journey = buildJourney(started.seed, constants, 2);
    expect(journey.moveLog.length).toBe(2); // 기본 상수(firstWantedHops=3)라 아직 수배 없음
    const endedAtMs = journey.lastT + 50;
    const totals = totalsOf(journey.runLog);
    const stats: ChaseTypingStats = { ...totals, elapsedMs: endedAtMs };
    const { state, score } = expectedScore(started.seed, constants, journey.moveLog, endedAtMs, stats);
    expect(state.arrestedAtMs).toBeNull();

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog: journey.moveLog,
      runLog: journey.runLog,
      clientResult: { score: score.finalScore, pi: score.pi, stats, outcome: "resigned", endedAtMs },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChaseSubmitRes;
    expect(body.verdict).toBe("valid");
    expect(body.score).toBe(score.finalScore);
    expect(body.completed).toBe(true); // D95: 자수=정상 종료 → completed=true 매핑

    // rid는 응답에 노출되지 않으므로 user_id+mode_key+score로 유일 식별해 조회한다.
    const rows = await env.DB.prepare(
      "SELECT * FROM runs WHERE user_id = ?1 AND mode_key = 'chase' AND score = ?2",
    )
      .bind(pid, score.finalScore)
      .all<RunRow>();
    expect(rows.results?.length).toBe(1);
    const saved = rows.results![0]!;
    expect(saved.verdict).toBe("valid");
    expect(saved.grade).toBe(score.grade);
    expect(saved.completed).toBe(1);
    expect(saved.countries_cleared).toBe(2);
    expect(saved.countries_skipped).toBe(0);
    expect(saved.detail_json).toContain("moveLog");
  });

  it("체포(arrested) 제출이 valid로 기록된다 — 경찰이 자연 추격으로 따라잡을 때까지 런 로컬 클록만 전진", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    // 3홉 완료 → 기본 상수 firstWantedHops=3으로 수배 ★1 발령 + 추격조 스폰. 이후 새 홉 없이
    // "런 로컬 클록"만 크게 전진시켜(경찰 자체 그리디 이동) 자연 체포를 유도한다(선택지 밖 홉으로
    // 직접 걸어 들어가는 편법은 실제 서버가 verifyMoveLog로 거부하므로 쓰지 않는다).
    const journey = buildJourney(started.seed, constants, 3);
    expect(journey.moveLog.length).toBe(3);
    const probeState = simulateChase(
      { seed: started.seed, moveLog: journey.moveLog, endMs: journey.lastT + 120_000, constants },
      world,
    );
    expect(probeState.arrestedAtMs).not.toBeNull(); // 테스트 전제 확인 — 실패 시 시나리오 자체 재설계 필요
    const endedAtMs = probeState.arrestedAtMs!;

    const totals = totalsOf(journey.runLog);
    const stats: ChaseTypingStats = { ...totals, elapsedMs: endedAtMs };
    const score = computeChaseScore(probeState, countryLookup, stats, LANG, constants);

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog: journey.moveLog,
      runLog: journey.runLog,
      clientResult: {
        score: score.finalScore,
        pi: score.pi,
        stats,
        outcome: "arrested",
        endedAtMs,
        arrestedAtMs: endedAtMs,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChaseSubmitRes;
    expect(body.verdict).toBe("valid");
    expect(body.score).toBe(score.finalScore);
    expect(body.completed).toBe(false); // D95: arrested는 강제 종료 → completed=false 매핑

    const rows = await env.DB.prepare(
      "SELECT * FROM runs WHERE user_id = ?1 AND mode_key = 'chase' AND score = ?2",
    )
      .bind(pid, score.finalScore)
      .all<RunRow>();
    expect(rows.results?.length).toBe(1);
    expect(rows.results![0]!.verdict).toBe("valid");

    // lb_best 등재(§9.3 — 기존 스키마 재사용, 마이그레이션 없음).
    const lb = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE user_id=?1 AND board_key LIKE 'chase|%'")
      .bind(pid)
      .first<{ n: number }>();
    expect(lb!.n).toBeGreaterThan(0);
  });
});

// ───────────────────────── moveLog 위조 ─────────────────────────

describe("POST /runs/submit — chase moveLog 위조(선택지 밖 홉)", () => {
  it("그 시점 선택지 3개 밖의 국가로 홉하면 rejected/'movelog_invalid'", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const journey = buildJourney(started.seed, constants, 1);
    expect(journey.moveLog.length).toBe(1);

    // hop1 후보를 조회하고, 그 후보 3개·홈·현재국 밖의 un195 국가를 하나 골라 위조한다.
    const probe = simulateChase({ seed: started.seed, moveLog: journey.moveLog, endMs: journey.lastT, constants }, world);
    const excluded = new Set([...probe.candidates, probe.player, probe.home]);
    const forged = COUNTRIES.find((c) => !excluded.has(c.id))!.id;
    const built = honestHop(1, journey.lastT, forged);

    const forgedMoveLog = [...journey.moveLog, built.entry];
    const forgedRunLog = [...journey.runLog, built.stat];
    const endedAtMs = built.tMs + 50;
    const totals = totalsOf(forgedRunLog);

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog: forgedMoveLog,
      runLog: forgedRunLog,
      clientResult: {
        score: 999_999, // 값은 무관 — movelog 단계에서 이미 반려된다.
        pi: 0,
        stats: { ...totals, elapsedMs: endedAtMs },
        outcome: "resigned",
        endedAtMs,
      },
    });
    const body = (await res.json()) as ChaseSubmitRes;
    expect(res.status).toBe(200); // 4xx 신호 금지(docs/06 §3.1)
    expect(body.verdict).toBe("rejected");

    const rows = await env.DB.prepare("SELECT verdict, verdict_reason FROM runs WHERE user_id=?1 AND mode_key='chase'")
      .bind(pid)
      .all<Pick<RunRow, "verdict" | "verdict_reason">>();
    // rejected·invalid_token/replay 조기반환이 아니므로 이 케이스는 원장에 남는다(run-verify.ts와 동일 톤 —
    // movelog_invalid는 ①②(invalid_token/replay)가 아니라 본 검증 단계 반려라 INSERT는 수행된다).
    expect(rows.results!.some((r) => r.verdict === "rejected" && r.verdict_reason === "movelog_invalid")).toBe(true);
  });
});

// ───────────────────────── 시각 조작 ─────────────────────────

describe("POST /runs/submit — chase 시각 조작", () => {
  it("홉 tMs가 단조 증가하지 않으면 rejected/'time_envelope'", async () => {
    const { token } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const journey = buildJourney(started.seed, constants, 2);
    expect(journey.moveLog.length).toBe(2);
    // 홉1의 tMs를 홉0과 같게(비단조) 조작.
    const tampered = journey.moveLog.map((m, i) => (i === 1 ? { ...m, tMs: journey.moveLog[0]!.tMs } : m));
    const endedAtMs = journey.lastT + 50;
    const totals = totalsOf(journey.runLog);

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog: tampered,
      runLog: journey.runLog,
      clientResult: { score: 0, pi: 0, stats: { ...totals, elapsedMs: endedAtMs }, outcome: "resigned", endedAtMs },
    });
    expect(((await res.json()) as ChaseSubmitRes).verdict).toBe("rejected");
  });

  it("홉 소요시간이 물리 하한(L×35ms) 미달이면 rejected/'impossible_speed'", async () => {
    const { token } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const probe = simulateChase({ seed: started.seed, moveLog: [], endMs: 0, constants }, world);
    const choice = probe.candidates[0]!;
    const country = countryLookup[choice]!;
    const L = requiredKeystrokes(country, LANG);
    // 물리 하한(L×35ms)보다 훨씬 빠르게(1ms) 홉 — 봇/자동입력 흔적.
    const moveLog: MoveLogEntry[] = [{ hopIndex: 0, countryId: choice, tMs: 1 }];
    const runLog: HopStat[] = [{ hopIndex: 0, keystrokes: L, errors: 0 }];

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog,
      runLog,
      clientResult: { score: 0, pi: 0, stats: { totalKeystrokes: L, correctKeystrokes: L, elapsedMs: 51, maxCombo: 1 }, outcome: "resigned", endedAtMs: 51 },
    });
    expect(((await res.json()) as ChaseSubmitRes).verdict).toBe("rejected");
  });
});

// ───────────────────────── 점수 불일치 ─────────────────────────

describe("POST /runs/submit — chase 점수 불일치", () => {
  it("클라 점수 위조 제출은 flagged로 기록되고 저장 점수는 서버 재계산 값", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (await startChase(token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const journey = buildJourney(started.seed, constants, 2);
    const endedAtMs = journey.lastT + 50;
    const totals = totalsOf(journey.runLog);
    const stats: ChaseTypingStats = { ...totals, elapsedMs: endedAtMs };
    const { score } = expectedScore(started.seed, constants, journey.moveLog, endedAtMs, stats);

    const res = await submitChase(token, {
      runToken: started.runToken,
      moveLog: journey.moveLog,
      runLog: journey.runLog,
      clientResult: { score: score.finalScore + 999_999, pi: score.pi, stats, outcome: "resigned", endedAtMs },
    });
    const body = (await res.json()) as ChaseSubmitRes;
    expect(body.verdict).toBe("flagged");
    expect(body.score).toBe(score.finalScore); // 서버 값(클라 위조값 아님)

    const rows = await env.DB.prepare(
      "SELECT score, verdict, verdict_reason FROM runs WHERE user_id=?1 AND mode_key='chase' AND score=?2",
    )
      .bind(pid, score.finalScore)
      .all<Pick<RunRow, "score" | "verdict" | "verdict_reason">>();
    expect(rows.results!.some((r) => r.verdict === "flagged" && r.verdict_reason === "score_mismatch")).toBe(true);
  });
});

// ───────────────────────── constantsVersion 불일치(§9.4) ─────────────────────────

describe("POST /runs/submit — chase constantsVersion 불일치(§9.4)", () => {
  it("발급 버전이 현행과 달라 폴백 상수로도 점수가 맞지 않으면 practice/'constants_version'로 강등(reject 아님)", async () => {
    const { token, pid } = await bootstrap();
    const constants = mergeChaseConstants(); // KV config:chase 미설정 — 기본값(=현행과 동일 값)
    const seed = 0x424242;

    const journey = buildJourney(seed, constants, 2);
    const endedAtMs = journey.lastT + 50;
    const totals = totalsOf(journey.runLog);
    const stats: ChaseTypingStats = { ...totals, elapsedMs: endedAtMs };
    const { score } = expectedScore(seed, constants, journey.moveLog, endedAtMs, stats);

    // /chase/start를 거치지 않고 발급 시점 버전을 v0(현행 CHASE_CONSTANTS_VERSION과 다름)으로 위조한 runToken을 직접
    // 서명한다(§9.1과 동일 문법 — setHash="chase:v{n}" 마커). v0 스냅샷(config:chase:v0)이 KV에
    // 없으므로 폴백 후보는 [기본값, 현행](둘 다 동일 값)이고, 점수를 고의로 어긋나게 제출하면
    // 두 후보 모두 불일치 → practice 강등 경로를 탄다(치터 오인 방지 — reject 아님).
    const rid = crypto.randomUUID();
    const fakeToken = await signRunToken(env.RUN_HMAC_SECRET, {
      rid,
      pid,
      mode: "chase",
      modeKey: "chase",
      lang: LANG,
      platform: "desktop",
      setHash: "chase:v0",
      seed: String(seed),
    });

    const res = await submitChase(token, {
      runToken: fakeToken,
      moveLog: journey.moveLog,
      runLog: journey.runLog,
      clientResult: { score: score.finalScore + 999_999, pi: score.pi, stats, outcome: "resigned", endedAtMs },
    });
    const body = (await res.json()) as ChaseSubmitRes;
    expect(body.verdict).toBe("practice");
    expect(body.rank).toBeNull(); // 랭킹 미도달(비경쟁)

    const rows = await env.DB.prepare(
      "SELECT verdict, verdict_reason FROM runs WHERE run_id=?1",
    )
      .bind(rid)
      .all<Pick<RunRow, "verdict" | "verdict_reason">>();
    expect(rows.results?.length).toBe(1);
    expect(rows.results![0]!.verdict).toBe("practice");
    expect(rows.results![0]!.verdict_reason).toBe("constants_version");
  });
});

// ───────────────────────── 게스트 강등(D68) ─────────────────────────

describe("POST /runs/submit — chase 게스트(비계정) 강등(§11-D68-①)", () => {
  it("게스트 clean 제출은 practice/'guest'로 강등, lb_best 미도달", async () => {
    const guest = await bootstrapGuest();
    const started = (await (await startChase(guest.token)).json()) as ChaseStartRes;
    const constants = mergeChaseConstants();

    const journey = buildJourney(started.seed, constants, 2);
    const endedAtMs = journey.lastT + 50;
    const totals = totalsOf(journey.runLog);
    const stats: ChaseTypingStats = { ...totals, elapsedMs: endedAtMs };
    const { score } = expectedScore(started.seed, constants, journey.moveLog, endedAtMs, stats);

    const res = await submitChase(guest.token, {
      runToken: started.runToken,
      moveLog: journey.moveLog,
      runLog: journey.runLog,
      clientResult: { score: score.finalScore, pi: score.pi, stats, outcome: "resigned", endedAtMs },
    });
    const body = (await res.json()) as ChaseSubmitRes;
    expect(body.verdict).toBe("practice");
    expect(body.rank).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT user_id, verdict, verdict_reason FROM runs WHERE user_id=?1 AND mode_key='chase'",
    )
      .bind(guest.pid)
      .all<Pick<RunRow, "user_id" | "verdict" | "verdict_reason">>();
    expect(rows.results?.length).toBe(1);
    expect(rows.results![0]!.verdict).toBe("practice");
    expect(rows.results![0]!.verdict_reason).toBe("guest");

    const lb = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE user_id=?1").bind(guest.pid).first<{ n: number }>();
    expect(lb!.n).toBe(0);
  });
});
