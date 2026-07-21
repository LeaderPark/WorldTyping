// spec: docs/04 §6.2(제출 검증 파이프라인 — 10단계, 순서 고정)·§6.4(verdict), docs/06 §3.2(재계산)·
//       §3.3(휴리스틱 표)·§3.4(inputDigest), docs/00 §11-D5·§11-D12(임계 통합)·§11-D38(pid 동일값) + WT-M3-03
//
// 클라가 보낸 점수를 절대 믿지 않는 서버 권위 검증. **순수 함수 체인**(IO 없음) — KV/D1/crypto는
// 라우트(runs.ts)가 미리 해소해 인자로 주입한다. 단계 순서는 docs/04 §6.2 표가 계약이라
// 재배열·생략 금지. 임계값은 전부 AnticheatConfig 경유(하드코딩 금지, §11-D12).
//
// verdict(§6.4 + docs/06 §1 canonical 4-상태, §11-D9): 'valid'(=검증 통과, 리더보드 도달) /
// 'flagged'(휴리스틱 의심, shadow 비노출) / 'practice'(정책상 비경쟁) / 'rejected'(물리·정합 위반).
// docs/04 §6.4는 'verified' 어휘를 쓰나 canonical 스키마(migrations 0001 CHECK, @wt/shared RunVerdict)가
// 'valid'로 확정돼 있어 전 구간 'valid'를 사용한다(최종 보고 escalations 참조).
import {
  compileTargets,
  matchInput,
  computeScore,
  requiredKeystrokes,
  type RunTokenPayload,
  type RunStats,
  type ScoreCountry,
  type CountryId,
  type Country,
} from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import type { RunVerdict, RunGrade } from "../db/types";
import type { AnticheatConfig } from "./anticheat-config";

/** 국가 상수 인덱스(§6.2-5 "COUNTRIES 상수"). 매칭 재검증·L_i 산출의 서버측 단일 원천. */
const COUNTRY_BY_ID: ReadonlyMap<CountryId, Country> = new Map(COUNTRIES.map((c) => [c.id, c]));

// ───────────────────────── 제출 페이로드 타입(docs/04 §2.3-5 + docs/06 §3.2/§3.4) ─────────────────────────

export interface PerCountrySubmit {
  code: CountryId;
  ms: number;
  keystrokes: number; // 정타+오타 (ko는 자모 단위)
  errors: number;
  skipped: boolean;
  inputUsed: string; // 확정에 사용된 입력 원문 — 서버가 matchInput으로 재검증
}

export interface RunResultSubmit {
  elapsedMs: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  maxCombo: number;
  countriesCleared: number;
  countriesSkipped: number;
  livesLost: number;
  finished: boolean;
  perCountry: PerCountrySubmit[];
}

/** 입력 리듬 요약 통계(docs/06 §3.4). 원시 타임스탬프 대신 요약만 전송. */
export interface InputDigest {
  n: number;
  mean: number;
  stdev: number;
  p10: number;
  p50: number;
  p90: number;
  burstMax: number;
}

export interface RunSubmitData {
  result: RunResultSubmit;
  clientScore: number;
  inputDigest: InputDigest;
}

/** 동일 보드·계정의 과거 정식 기록 요약(휴리스틱 (e)/(f)용 — 라우트가 D1에서 조회해 주입). */
export interface PersonalStats {
  /** 동일 보드(mode_key)의 과거 verdict='valid' 판 수. */
  sampleSize: number;
  /** 동일 보드의 과거 최고 PI. 없으면 null. */
  bestPi: number | null;
  /** 계정 전체에 과거 verdict='valid' 기록이 하나도 없으면 true(첫 정식 제출 계정). */
  isFirstSubmission: boolean;
}

export interface RunVerifyParams {
  /** 세션 pid(§11-D38: user_id = pid 동일값). */
  sessionPid: string;
  token: RunTokenPayload;
  /** 라우트가 재현한 세트의 setHash = SHA-256(fullSet.join(',')). */
  rebuiltSetHash: string;
  /** 토큰으로 재현한 이 판의 전체 세트(순서 포함). */
  fullSet: readonly CountryId[];
  /** KV sess:{rid} 사용 플래그 조회 결과(②). */
  alreadyUsed: boolean;
  submit: RunSubmitData;
  now: number;
  /** 토큰 exp 폭(=serverElapsed 상한, 기본 30분 = RUN_TOKEN_TTL_MS). */
  runTokenTtlMs: number;
  config: AnticheatConfig;
  personal: PersonalStats;
}

/** 서버 재계산 확정값(DB runs 컬럼과 1:1). 클라 제출 요약값은 절대 저장하지 않는다. */
export interface ServerValues {
  score: number;
  pi: number;
  cpm: number;
  accMilli: number;
  grade: RunGrade;
  completed: boolean;
  maxCombo: number;
  countriesCleared: number;
  countriesSkipped: number;
  elapsedMs: number;
}

export interface RunVerifyResult {
  verdict: RunVerdict;
  /** DB verdict_reason에 기록(응답에는 노출하지 않음 — 어뷰저에게 탐지 신호 금지, docs/06 §3.1). */
  verdictReason: string | null;
  /** 수집된 휴리스틱 플래그 전체(운영 리뷰용). */
  flags: string[];
  server: ServerValues;
}

const ZERO_SERVER: ServerValues = {
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

function reject(reason: string, server: ServerValues): RunVerifyResult {
  return { verdict: "rejected", verdictReason: reason, flags: [], server };
}

/**
 * docs/04 §6.2 표의 10단계 순서 그대로. ①토큰pid ②리플레이 ③시간봉투 ④세트 ⑤매칭 ⑥합산 ⑦물리
 * ⑧CPM하드캡 ⑨점수재계산(flag) ⑩휴리스틱(flag/practice).
 */
export function verifyRun(p: RunVerifyParams): RunVerifyResult {
  const { token, submit, config, fullSet, now, personal } = p;
  const lang = token.lang;
  const result = submit.result;
  const perCountry = result.perCountry;

  // ① 토큰 pid ↔ 세션 pid(§6.2-1). §11-D38로 user_id=pid라 직접 비교가 성립.
  if (token.pid !== p.sessionPid) return reject("invalid_token", ZERO_SERVER);

  // ② 리플레이(§6.2-2): KV sess:{rid} 사용 플래그가 이미 있으면 즉시 rejected.
  if (p.alreadyUsed) return reject("replay", ZERO_SERVER);

  // ③ 시간 봉투(§6.2-3): 실제 흐른 시간(serverElapsed)보다 길게 플레이했다고 주장 불가 + 30분 상한.
  const serverElapsed = now - token.startTs;
  if (serverElapsed < 0 || serverElapsed > p.runTokenTtlMs) return reject("time_envelope", ZERO_SERVER);
  if (result.elapsedMs < 0) return reject("time_envelope", ZERO_SERVER);
  if (result.elapsedMs > serverElapsed + config.timeEnvelopeGraceMs) return reject("time_envelope", ZERO_SERVER);

  // ④ 세트 일치(§6.2-4): 재현본 무결성(setHash) + 제출 코드가 재현 세트의 prefix(중도 탈락 허용) +
  //    skipped/cleared 합계 일치.
  if (p.rebuiltSetHash !== token.setHash) return reject("set_mismatch", ZERO_SERVER);
  if (perCountry.length === 0 || perCountry.length > fullSet.length) return reject("set_mismatch", ZERO_SERVER);
  for (let i = 0; i < perCountry.length; i++) {
    if (perCountry[i]!.code !== fullSet[i]) return reject("set_mismatch", ZERO_SERVER);
  }
  const skippedCount = perCountry.reduce((n, per) => n + (per.skipped ? 1 : 0), 0);
  const clearedCount = perCountry.length - skippedCount;
  if (result.countriesSkipped !== skippedCount || result.countriesCleared !== clearedCount) {
    return reject("set_mismatch", ZERO_SERVER);
  }

  // 세트가 확정됐으므로 서버 재계산 수행(이후 단계와 저장이 모두 서버 값을 쓴다).
  const maxCombo = serverMaxCombo(perCountry);
  const server = computeServerResult(fullSet, perCountry, result, lang, maxCombo);
  const serverValues = toServerValues(server, result.elapsedMs, clearedCount, skippedCount, maxCombo);

  // ⑤ 매칭 재검증(§6.2-5): cleared(비스킵) 국가마다 matchInput===EXACT + 타수 하한 L_i(§3.2-2).
  for (const per of perCountry) {
    if (per.skipped) continue;
    const country = COUNTRY_BY_ID.get(per.code);
    if (!country) return reject("input_invalid", serverValues);
    if (matchInput(per.inputUsed, compileTargets(country, lang), lang) !== "EXACT") {
      return reject("input_invalid", serverValues);
    }
    if (per.keystrokes < requiredKeystrokes(country, lang)) {
      return reject("input_invalid", serverValues); // 붙여넣기/자동입력 흔적(타수가 최소 미만)
    }
  }

  // ⑥ 합산 정합(§6.2-6): Σms 봉투 + 타수 재계산 일치.
  const sumMs = perCountry.reduce((a, per) => a + per.ms, 0);
  const lo = result.elapsedMs * config.sumMsToleranceLowFactor - config.sumMsToleranceFlatMs;
  const hi = result.elapsedMs * config.sumMsToleranceHighFactor + config.sumMsToleranceFlatMs;
  if (sumMs < lo || sumMs > hi) return reject("stats_mismatch", serverValues);
  const sumKeystrokes = perCountry.reduce((a, per) => a + per.keystrokes, 0);
  const sumErrors = perCountry.reduce((a, per) => a + per.errors, 0);
  if (sumKeystrokes !== result.totalKeystrokes) return reject("stats_mismatch", serverValues);
  if (result.correctKeystrokes !== result.totalKeystrokes - sumErrors) return reject("stats_mismatch", serverValues);

  // ⑦ 물리 한계(§6.2-7, §11-D12): 각 cleared 국가 ms_i ≥ L_i × minMsPerKeystroke.
  for (const per of perCountry) {
    if (per.skipped) continue;
    const country = COUNTRY_BY_ID.get(per.code)!; // ⑤에서 존재 확인됨
    if (per.ms < requiredKeystrokes(country, lang) * config.minMsPerKeystroke) {
      return reject("impossible_speed", serverValues);
    }
  }

  // ⑧ CPM 하드캡(§6.2-8): 서버 재계산 CPM > 하드캡 → rejected.
  const hardCap = lang === "ko" ? config.cpmHardCapKo : config.cpmHardCapEn;
  if (server.cpm > hardCap) return reject("impossible_cpm", serverValues);

  // ── 여기까지 통과 → 최소 valid. 이하 단계는 reject가 아니라 flag/practice 수집. ──
  const flags: string[] = [];

  // ⑨ 점수 재계산(§6.2-9): 서버 값으로 항상 덮어쓰고, 클라 차이 > tolerance면 flag(클라 버그 겸용).
  if (Math.abs(submit.clientScore - server.finalScore) > config.scoreMismatchTolerance) {
    flags.push("score_mismatch");
  }

  // ⑩ 휴리스틱(§3.3, §3.4)
  const softCap = lang === "ko" ? config.cpmSoftCapKo : config.cpmSoftCapEn;
  if (server.cpm > softCap) flags.push("cpm_soft_cap");
  if (
    personal.sampleSize >= config.growthMinSample &&
    personal.bestPi !== null &&
    server.pi > personal.bestPi * (1 + config.growthJumpFactor)
  ) {
    flags.push("growth_jump");
  }
  if (server.acc >= 1 && server.cpm > config.accComboCpmThreshold && personal.isFirstSubmission) {
    flags.push("acc_combo");
  }
  const d = submit.inputDigest;
  const cvLow = d.mean > 0 && d.stdev / d.mean < config.rhythmCvThreshold;
  const spreadLow = d.p90 - d.p10 < config.rhythmSpreadMsThreshold;
  if (cvLow || spreadLow) flags.push("rhythm_uniform");

  // 벌크 입력(붙여넣기/스와이프)은 flag가 아니라 practice 강등(§6.2-10d, §3.4).
  if (d.burstMax > config.burstMaxThreshold) {
    flags.push("bulk_input");
    return { verdict: "practice", verdictReason: "bulk_input", flags, server: serverValues };
  }

  if (flags.length > 0) {
    return { verdict: "flagged", verdictReason: flags.join(","), flags, server: serverValues };
  }
  return { verdict: "valid", verdictReason: null, flags, server: serverValues };
}

// ───────────────────────── 서버 재계산 헬퍼 ─────────────────────────

/**
 * 제출 원시값에서 서버 점수를 재계산한다(@wt/shared computeScore — 클라와 동일 코드).
 * maxCombo는 클라 값을 믿지 않고 perCountry(errors/skipped)에서 재산출한 서버 권위 값을 주입한다.
 * countries는 fullSet 전체(완주 판정 = perCountry.length === fullSet.length에 필요).
 */
function computeServerResult(
  fullSet: readonly CountryId[],
  perCountry: readonly PerCountrySubmit[],
  result: RunResultSubmit,
  lang: "ko" | "en",
  maxCombo: number,
) {
  const countries: ScoreCountry[] = fullSet.map((id) => {
    const c = COUNTRY_BY_ID.get(id);
    if (!c) throw new Error(`run-verify: fullSet에 알 수 없는 국가 id ${id}(세트 빌더/데이터 버그)`);
    return { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  });
  const stats: RunStats = {
    totalKeystrokes: result.totalKeystrokes,
    correctKeystrokes: result.correctKeystrokes,
    elapsedMs: result.elapsedMs,
    maxCombo,
    countriesCleared: result.countriesCleared,
    countriesSkipped: result.countriesSkipped,
    perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
  };
  return computeScore(stats, countries, lang);
}

/** 연속 "노오타·노스킵" 국가 수의 최대치(docs/01 §6.1). 클라 조작을 배제한 서버 권위 값. */
function serverMaxCombo(perCountry: readonly PerCountrySubmit[]): number {
  let combo = 0;
  let max = 0;
  for (const per of perCountry) {
    if (!per.skipped && per.errors === 0) {
      combo += 1;
      if (combo > max) max = combo;
    } else {
      combo = 0;
    }
  }
  return max;
}

function toServerValues(
  r: ReturnType<typeof computeScore>,
  elapsedMs: number,
  clearedCount: number,
  skippedCount: number,
  maxCombo: number,
): ServerValues {
  return {
    score: r.finalScore,
    pi: r.pi,
    cpm: r.cpm,
    accMilli: Math.round(r.acc * 1000),
    grade: r.grade as RunGrade,
    completed: r.completed,
    maxCombo,
    countriesCleared: clearedCount,
    countriesSkipped: skippedCount,
    elapsedMs: Math.max(0, Math.floor(elapsedMs)),
  };
}
