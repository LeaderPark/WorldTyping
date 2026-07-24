// spec: docs/01 §6.1(RunStats)·§6.2(FinalScore 공식)·§6.3(등급/완주 캡), docs/00 §11-D4
//
// BaseScore  = Σ_{i∈cleared} (60 + 8×L_i) × w_i,  w_i = 1 + 0.15×(tier_i−1)
// AccFactor  = ACC²
// ComboFactor= 1 + 0.01 × min(maxCombo, 40)
// TimeBonus  = max(0, T_par − elapsedSec) × 15,  T_par = Σ_{i∈all} L_i / 3.5, 완주 시에만 지급
// FinalScore = round(BaseScore × AccFactor × ComboFactor + TimeBonus)
//
// "완주" 판정: docs/01 §3.1/§3.2/§3.3의 완주 조건은 하나같이 "전 국가를 순서대로 입력"
// (스킵 포함 시 "완주(스킵 n)" 표기)으로 정의된다 — 즉 스킵 자체는 미완주 사유가 아니고,
// 라이프 소진으로 인한 조기 종료만 미완주다. 이 함수의 시그니처는 4-파라미터로 고정되어
// 있어(WT-M1-02 산출물 정의) RunStats에 별도 completed 필드를 추가하지 않는다. 대신
// perCountry.length(실제로 끝까지 진행해 기록이 남은 국가 수) === countries.length(런에
// 배정된 전체 국가 수)로 구조적으로 판정한다: 조기 게임오버는 perCountry가 끝까지 채워지지
// 않는 형태로 나타나므로 이 비교로 "완주" 여부가 정확히 갈린다.
//
// WT-CH-03(docs/09 §3.6·docs/00 §11-D92) 재사용 노트: BaseScore 항 (60+8×L_i)×w_i · CPM ·
// ACC · ComboFactor는 chase(골드 러너) 모드의 TypingScore/AccFactor/ComboFactor 항으로도
// 그대로 재사용된다. 아래 baseScoreTerm/computeCpm/computeAccuracy/computeComboFactor는 그
// 재사용을 위해 무동작 보존(no-op-preserving) 추출한 헬퍼다 — computeScore의 동작·골든
// 벡터 결과는 이 추출 전후로 완전히 동일하다(추출 자체가 "공식 수정"이 아님).

import type { DifficultyTier } from '../types/country';
import type { RunStats } from '../types/game';
import {
  computeGrade,
  computePI,
  DEFAULT_GRADE_CONFIG,
  type Grade,
  type GradeConfig,
} from './grade';
import { requiredKeystrokes, type KeystrokeSource } from './keystrokes';

export type ScoreCountry = KeystrokeSource & { difficultyTier: DifficultyTier };

export interface ScoreConfig {
  /** docs/01 §6.3 등급 컷. 미지정 필드는 DEFAULT_GRADE_CONFIG로 보완(KV config:client 폴백). */
  grade?: Partial<GradeConfig>;
}

export interface RunResult {
  cpm: number;
  acc: number;
  pi: number;
  grade: Grade;
  /** perCountry.length === countries.length — 라이프 소진 없이 배정된 전 국가를 진행했는지. */
  completed: boolean;
  baseScore: number;
  accFactor: number;
  comboFactor: number;
  timeBonus: number;
  finalScore: number;
}

const PAR_CHARS_PER_SEC = 3.5; // "초당 3.5타" 파 타임 기준(§6.2)
const TIME_BONUS_PER_SEC = 15;
const BASE_FLAT = 60;
const BASE_PER_CHAR = 8;
const TIER_WEIGHT_STEP = 0.15;
const COMBO_STEP = 0.01;
const COMBO_CAP = 40;

/**
 * BaseScore의 국가 1개 항: (60 + 8×L_i) × w_i, w_i = 1 + 0.15×(tier_i−1) (§6.2). computeScore의
 * perCountry 루프가 이 함수로 위임한다(단일 원천) — chase(WT-CH-03)의 TypingScore 항도 이
 * 함수를 그대로 재사용해 BaseScore 공식을 복제하지 않는다.
 */
export function baseScoreTerm(country: ScoreCountry, lang: 'ko' | 'en'): number {
  const L = requiredKeystrokes(country, lang);
  const w = 1 + TIER_WEIGHT_STEP * (country.difficultyTier - 1);
  return (BASE_FLAT + BASE_PER_CHAR * L) * w;
}

/** CPM = floor(correctKeystrokes × 60000 / elapsedMs), elapsedMs<=0이면 0(0-division 가드, §6.2). */
export function computeCpm(correctKeystrokes: number, elapsedMs: number): number {
  return elapsedMs > 0 ? Math.floor((correctKeystrokes * 60000) / elapsedMs) : 0;
}

/** ACC = correctKeystrokes/totalKeystrokes, totalKeystrokes<=0이면 0(0-division 가드, §6.2). */
export function computeAccuracy(correctKeystrokes: number, totalKeystrokes: number): number {
  return totalKeystrokes > 0 ? correctKeystrokes / totalKeystrokes : 0;
}

/** ComboFactor = 1 + 0.01 × min(maxCombo, 40) (§6.2). */
export function computeComboFactor(maxCombo: number): number {
  return 1 + COMBO_STEP * Math.min(maxCombo, COMBO_CAP);
}

/**
 * FinalScore/PI/등급을 한 판(RunStats) 기준으로 계산한다. 클라(표시)·서버(재계산 검증)가
 * 동일 코드를 import한다 — 매칭 로직과 마찬가지로 이 파일 밖 재구현 금지.
 *
 * @param stats 한 판의 측정 원시값(docs/01 §6.1).
 * @param countries 이 런에 배정된 전체 국가 목록(순서 = perCountry 순서). perCountry가
 *   이 배열의 접두(prefix)만큼만 채워져 있으면 미완주로 판정한다.
 * @param lang 판정 언어. L_i 산출 기준이 ko/en에 따라 달라진다(§11-D4).
 * @param cfg 등급 컷 오버라이드(KV config:client 값 주입용).
 */
export function computeScore(
  stats: RunStats,
  countries: readonly ScoreCountry[],
  lang: 'ko' | 'en',
  cfg: ScoreConfig = {},
): RunResult {
  if (stats.perCountry.length > countries.length) {
    throw new Error(
      'computeScore: perCountry.length must not exceed countries.length (런 배정 국가 수를 초과한 기록 — 계약 위반)',
    );
  }
  const completed = stats.perCountry.length === countries.length;

  // 정수 타수 기반으로 먼저 합산, 나눗셈은 마지막에 한 번만(부동소수 누적 오차 방지).
  const cpm = computeCpm(stats.correctKeystrokes, stats.elapsedMs);
  const acc = computeAccuracy(stats.correctKeystrokes, stats.totalKeystrokes);
  const pi = computePI(cpm, acc);
  const gradeCfg: GradeConfig = { ...DEFAULT_GRADE_CONFIG, ...cfg.grade };
  const grade = computeGrade(pi, completed, gradeCfg);

  let baseScore = 0;
  for (let i = 0; i < stats.perCountry.length; i++) {
    const per = stats.perCountry[i]!;
    if (per.skipped) continue; // 스킵 국가는 BaseScore 미포함(정타 없이 통과했으므로)
    baseScore += baseScoreTerm(countries[i]!, lang);
  }

  const accFactor = acc * acc;
  const comboFactor = computeComboFactor(stats.maxCombo);

  let timeBonus = 0;
  if (completed) {
    let totalL = 0;
    for (const country of countries) totalL += requiredKeystrokes(country, lang);
    const parSec = totalL / PAR_CHARS_PER_SEC;
    const elapsedSec = stats.elapsedMs / 1000;
    timeBonus = Math.max(0, parSec - elapsedSec) * TIME_BONUS_PER_SEC;
  }

  const finalScore = Math.round(baseScore * accFactor * comboFactor + timeBonus);

  return { cpm, acc, pi, grade, completed, baseScore, accFactor, comboFactor, timeBonus, finalScore };
}
