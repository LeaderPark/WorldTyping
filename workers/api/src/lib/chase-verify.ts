// spec: docs/09 §4.4(서버 검증 대조 항목)·§9.2(제출 검증 순서·CPU 예산)·§9.4(constantsVersion
//       재계산), docs/00 §11-D90·D91(결정성)·D92(등급 배송조건)·D94(미배송 50%)·D95(자수) + WT-CH-09
//
// chase(골드 러너) 제출 검증 — run-verify.ts와 동일 원칙의 **순수 함수 체인**(IO 없음, KV/D1은
// 라우트가 미리 해소해 인자로 주입한다). 서버가 클라 이동·점수를 절대 믿지 않고
// simulateChase/verifyMoveLog/computeChaseScore(@wt/shared)를 재실행해 허용 오차 0으로 대조한다.
// 심·판정·점수는 이 파일에서 재구현하지 않는다(재실행만 — Gotcha 3).
//
// 검증 순서(§9.2 + docs/04 §6.2 표의 정신을 chase에 맞춰 재구성):
//   ① 토큰 pid ↔ 세션 pid  ② 리플레이(KV sess:{rid}, 라우트가 조회해 주입)
//   ③ 시간 봉투(endedAtMs ≤ 실제 흐른 시간 + 유예, TTL 상한) + outcome='arrested'면 arrestedAtMs=endedAtMs
//   ④ moveLog·runLog 구조 정합(hopIndex 순차·tMs 단조 증가) — 상수 무관, moveLog 시각만으로 산출
//   ⑤ 홉별 물리 한계(keystrokes ≥ L_i, 홉 소요시간 ≥ L_i×minMsPerKeystroke) — 기존 anticheat 설정 재사용
//   ⑥ 합산 정합(Σkeystrokes/Σerrors === 제출 stats) + CPM 하드캡
//   ⑦ moveLog 재생성 대조 + 심 재실행 + 점수 재계산 — §9.4 상수 후보를 순서대로 시도해 대조
import {
  computeCpm,
  requiredKeystrokes,
  simulateChase,
  verifyMoveLog,
  computeChaseScore,
  type ChaseConstants,
  type ChaseCountryLookup,
  type ChaseScoreResult,
  type ChaseState,
  type ChaseTypingStats,
  type ChaseWorld,
  type CountryId,
  type DifficultyTier,
  type MoveLogEntry,
  type RunTokenPayload,
} from "@wt/shared";
import { COUNTRIES, CHASE_GRAPH } from "@wt/data";
import type { RunGrade, RunVerdict } from "../db/types";
import type { AnticheatConfig } from "./anticheat-config";

// ───────────────────────── 참조 데이터(모듈 스코프 1회 구성) ─────────────────────────
// CHASE_GRAPH/COUNTRIES는 빌드 산출 정적 상수라 요청마다 재구성할 필요가 없다(run-verify.ts의
// COUNTRY_BY_ID와 동일 원칙). 캐스팅은 packages/shared/src/chase/simulate.test.ts의 realWorld()와
// 동일 패턴 — @wt/data의 ChaseGraphDataset은 @wt/shared의 ChaseGraph와 구조적으로 호환된다.

const CHASE_WORLD: ChaseWorld = (() => {
  const tiers: Record<string, DifficultyTier> = {};
  for (const c of COUNTRIES) tiers[c.id] = c.difficultyTier;
  return { graph: CHASE_GRAPH as unknown as ChaseWorld["graph"], tiers: tiers as ChaseWorld["tiers"] };
})();

const CHASE_COUNTRY_LOOKUP: ChaseCountryLookup = (() => {
  const out: Record<string, { nameKo: string; nameEn: string; difficultyTier: DifficultyTier }> = {};
  for (const c of COUNTRIES) out[c.id] = { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  return out as ChaseCountryLookup;
})();

// ───────────────────────── 제출 페이로드 타입(§9.2) ─────────────────────────

/** runLog 1홉 요약(moveLog와 1:1, hopIndex로 대응). ms는 moveLog[i].tMs 차분에서 산출하므로 담지 않는다. */
export interface ChaseHopStat {
  hopIndex: number;
  keystrokes: number;
  errors: number;
}

export interface ChaseClientResult {
  score: number;
  pi: number;
  stats: {
    totalKeystrokes: number;
    correctKeystrokes: number;
    elapsedMs: number;
    maxCombo: number;
  };
  outcome: "arrested" | "resigned";
  endedAtMs: number;
  arrestedAtMs?: number;
}

export interface ChaseSubmitData {
  moveLog: readonly MoveLogEntry[];
  runLog: readonly ChaseHopStat[];
  clientResult: ChaseClientResult;
}

export interface ChaseVerifyParams {
  /** 세션 pid(§11-D38 — user_id=pid 동일값 원칙 승계). */
  sessionPid: string;
  token: RunTokenPayload; // mode==='chase'
  /** KV sess:{rid} 사용 플래그 조회 결과(라우트가 미리 조회) — 리플레이 판정. */
  alreadyUsed: boolean;
  submit: ChaseSubmitData;
  now: number;
  /** 토큰 exp 폭(기본 30분 = RUN_TOKEN_TTL_MS). */
  runTokenTtlMs: number;
  config: AnticheatConfig;
  /** §9.4: 순서대로 시도할 상수 후보. 정상 경로(발급 버전=현행)는 길이 1. */
  constantsCandidates: readonly ChaseConstants[];
  /** true면 발급 시점 버전 ≠ 현행 — 전부 불일치 시 reject 대신 practice/'constants_version' 강등. */
  versionMismatch: boolean;
}

/** 서버 재계산 확정값. runs 테이블 기존 컬럼(ServerValues와 동일 shape)에 그대로 매핑한다 —
 *  chase 전용 컬럼을 신설하지 않고 기존 스키마를 재사용한다(킷 에스컬레이션 항목 해소 — 아래 참조).
 *  chase 고유 통계(배송 수·moveLog·runLog 등)는 라우트가 detail_json에 담는다. */
export interface ChaseServerValues {
  score: number;
  pi: number;
  cpm: number;
  accMilli: number;
  grade: RunGrade;
  /** "완주" 개념이 없는 무한 생존 모드라(D92) resigned(자발 종료)를 completed=true로 매핑한다.
   *  arrested(강제 종료)는 completed=false — 기존 모드의 "라이프 소진 조기종료"와 같은 결을 유지. */
  completed: boolean;
  maxCombo: number;
  /** 총 홉 수(= moveLog.length, 국가 타이핑 성공 횟수 — 기존 필드 의미 그대로 재사용). */
  countriesCleared: number;
  /** chase는 스킵이 없다(D95) — 항상 0. */
  countriesSkipped: number;
  elapsedMs: number;
}

export interface ChaseVerifyResult {
  verdict: RunVerdict;
  /** DB verdict_reason에만 기록(응답 비노출 — docs/06 §3.1과 동일 원칙). */
  verdictReason: string | null;
  server: ChaseServerValues;
  /** 배송(홈 귀환 정산) 횟수 — 등급 조건(D92) 근거값. detail_json 기록용. */
  delivered: number;
}

const ZERO_SERVER: ChaseServerValues = {
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

function reject(reason: string): ChaseVerifyResult {
  return { verdict: "rejected", verdictReason: reason, server: ZERO_SERVER, delivered: 0 };
}

/** 연속 "노오타" 홉 수의 최대치(§3.6 — 국가 단위, 금 획득/배송 무관). run-verify.ts의 serverMaxCombo와 동일 정신. */
function serverMaxCombo(runLog: readonly ChaseHopStat[]): number {
  let combo = 0;
  let max = 0;
  for (const hop of runLog) {
    if (hop.errors === 0) {
      combo += 1;
      if (combo > max) max = combo;
    } else {
      combo = 0;
    }
  }
  return max;
}

function toServerValues(
  outcome: "arrested" | "resigned",
  scoreResult: ChaseScoreResult,
  maxCombo: number,
  hopsProcessed: number,
  elapsedMs: number,
): ChaseServerValues {
  return {
    score: scoreResult.finalScore,
    pi: scoreResult.pi,
    cpm: scoreResult.cpm,
    accMilli: Math.round(scoreResult.acc * 1000),
    grade: scoreResult.grade,
    completed: outcome === "resigned",
    maxCombo,
    countriesCleared: hopsProcessed,
    countriesSkipped: 0,
    elapsedMs: Math.max(0, Math.floor(elapsedMs)),
  };
}

/**
 * chase 제출 검증 본체(§9.2). 순서는 파일 상단 주석 그대로 — 재배열 금지.
 * CPU 예산(§9.2): 심 재실행은 O(이벤트 수) — 후보 상수가 여러 개(버전 불일치 폴백)여도 최대
 * 3회 재실행이며 각 1ms 미만(Workers 한도 무관).
 */
export function verifyChaseRun(p: ChaseVerifyParams): ChaseVerifyResult {
  const { token, submit, config, now } = p;
  const lang = token.lang;
  const moveLog = submit.moveLog;
  const runLog = submit.runLog;
  const cr = submit.clientResult;

  // ① 토큰 pid ↔ 세션 pid.
  if (token.pid !== p.sessionPid) return reject("invalid_token");
  // ② 리플레이.
  if (p.alreadyUsed) return reject("replay");

  // ③ 시간 봉투 + outcome 자기정합.
  const serverElapsed = now - token.startTs;
  if (serverElapsed < 0 || serverElapsed > p.runTokenTtlMs) return reject("time_envelope");
  if (cr.endedAtMs < 0 || cr.endedAtMs > serverElapsed + config.timeEnvelopeGraceMs) {
    return reject("time_envelope");
  }
  if (cr.outcome === "arrested" && cr.arrestedAtMs !== cr.endedAtMs) return reject("outcome_mismatch");

  // seed 파싱(chase/start가 setHash="chase:v{version}"·seed=String(uint32)로 발급, §9.1).
  const seedNum = Number(token.seed);
  if (!Number.isInteger(seedNum) || seedNum < 0 || seedNum > 0xffffffff) return reject("invalid_token");

  // ④ moveLog·runLog 구조 정합(상수 무관 — moveLog 자체 시각만으로 산출 가능).
  if (runLog.length !== moveLog.length) return reject("stats_mismatch");
  let prevT = 0;
  for (let i = 0; i < moveLog.length; i++) {
    const m = moveLog[i]!;
    if (m.hopIndex !== i || runLog[i]!.hopIndex !== i) return reject("movelog_invalid");
    if (m.tMs <= prevT || m.tMs > cr.endedAtMs) return reject("time_envelope"); // 단조성 위반 포함
    prevT = m.tMs;
  }

  // ⑤⑥ 홉별 물리 한계 + 합산 정합.
  let totalKeystrokes = 0;
  let totalErrors = 0;
  for (let i = 0; i < moveLog.length; i++) {
    const country = CHASE_COUNTRY_LOOKUP[moveLog[i]!.countryId as CountryId];
    if (!country) return reject("movelog_invalid"); // un195 밖 id(위조/데이터 불일치)
    const L = requiredKeystrokes(country, lang);
    const hop = runLog[i]!;
    if (hop.keystrokes < L) return reject("input_invalid"); // 붙여넣기/자동입력 흔적
    const hopElapsed = i === 0 ? moveLog[i]!.tMs : moveLog[i]!.tMs - moveLog[i - 1]!.tMs;
    if (hopElapsed < L * config.minMsPerKeystroke) return reject("impossible_speed");
    totalKeystrokes += hop.keystrokes;
    totalErrors += hop.errors;
  }
  const correctKeystrokes = totalKeystrokes - totalErrors;
  if (totalKeystrokes !== cr.stats.totalKeystrokes || correctKeystrokes !== cr.stats.correctKeystrokes) {
    return reject("stats_mismatch");
  }
  const maxCombo = serverMaxCombo(runLog);

  // CPM 하드캡 — moveLog/runLog만으로 산출(심 재실행 불요, elapsedMs=endedAtMs 확정값).
  const cpmHardCap = lang === "ko" ? config.cpmHardCapKo : config.cpmHardCapEn;
  if (computeCpm(correctKeystrokes, cr.endedAtMs) > cpmHardCap) return reject("impossible_cpm");

  const typingStats: ChaseTypingStats = {
    totalKeystrokes,
    correctKeystrokes,
    elapsedMs: cr.endedAtMs,
    maxCombo,
  };

  // ⑦ moveLog 재생성 대조 + 심 재실행 + 점수 재계산 — 상수 후보를 순서대로 시도(§9.4).
  let bestPartial: { state: ChaseState; scoreResult: ChaseScoreResult } | null = null;
  let firstFailureReason: string | null = null;
  for (const constants of p.constantsCandidates) {
    const input = { seed: seedNum, moveLog, endMs: cr.endedAtMs, constants };
    const mv = verifyMoveLog(input, CHASE_WORLD);
    if (!mv.valid) {
      firstFailureReason ??= "movelog_invalid";
      continue;
    }
    const state = simulateChase(input, CHASE_WORLD);
    const outcomeOk =
      cr.outcome === "arrested" ? state.arrestedAtMs === cr.endedAtMs : state.arrestedAtMs === null;
    if (!outcomeOk) {
      firstFailureReason ??= "outcome_mismatch";
      continue;
    }
    const scoreResult = computeChaseScore(state, CHASE_COUNTRY_LOOKUP, typingStats, lang, constants);
    bestPartial ??= { state, scoreResult };
    if (Math.abs(scoreResult.finalScore - cr.score) <= config.scoreMismatchTolerance) {
      return {
        verdict: "valid",
        verdictReason: null,
        delivered: scoreResult.delivered,
        server: toServerValues(cr.outcome, scoreResult, maxCombo, moveLog.length, cr.endedAtMs),
      };
    }
    firstFailureReason ??= "score_mismatch";
  }

  // 전부 불일치.
  if (!p.versionMismatch) {
    // 정상 경로(발급=현행, 후보 1개): score만 어긋났다면 flag(서버 재계산 값으로 기록, 클라 버그
    // 겸용 — 기존 run-verify.ts ⑨와 동일 관용), moveLog·outcome 자체가 안 맞으면 reject.
    if (bestPartial) {
      return {
        verdict: "flagged",
        verdictReason: firstFailureReason ?? "score_mismatch",
        delivered: bestPartial.scoreResult.delivered,
        server: toServerValues(cr.outcome, bestPartial.scoreResult, maxCombo, moveLog.length, cr.endedAtMs),
      };
    }
    return reject(firstFailureReason ?? "movelog_invalid");
  }

  // §9.4 버전 폴백(스냅샷→기본값→현행) 전부 실패 — 치터 오인 방지를 위해 practice 강등(reject 아님).
  // 원장에 남길 값은 필요하므로: 그래도 유효했던 시도(bestPartial)가 있으면 그 값, 없으면(모든 후보가
  // moveLog/outcome 단계에서부터 불일치— 극단 상황) 마지막(가장 최신=현행) 후보로 강행 재계산한다.
  // verdict가 이미 practice라 랭킹에는 영향이 없다(정밀도보다 "무언가 기록"이 우선).
  const fallback =
    bestPartial ??
    (() => {
      const last = p.constantsCandidates[p.constantsCandidates.length - 1]!;
      const input = { seed: seedNum, moveLog, endMs: cr.endedAtMs, constants: last };
      const state = simulateChase(input, CHASE_WORLD);
      const scoreResult = computeChaseScore(state, CHASE_COUNTRY_LOOKUP, typingStats, lang, last);
      return { state, scoreResult };
    })();
  return {
    verdict: "practice",
    verdictReason: "constants_version",
    delivered: fallback.scoreResult.delivered,
    server: toServerValues(cr.outcome, fallback.scoreResult, maxCombo, moveLog.length, cr.endedAtMs),
  };
}
