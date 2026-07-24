// spec: docs/09 §3.6(점수 모델 전문)·§3.7(종료), docs/00 §11-D92(등급 예외)·D94(미배송 50%),
//       docs/01 §6.2(BaseScore/AccFactor/ComboFactor 항 정의 원천)
//
// chase(골드 러너)의 무한 생존형 점수 조립. 기존 §6.2 공식의 항(BaseScore 항·CPM·ACC·ComboFactor·
// PI)을 packages/shared/scoring에서 그대로 import해 재사용한다 — 어떤 항도 이 파일에서 재구현하지
// 않는다(Gotcha 3 판정·점수 패리티 원칙).
//
//   TypingScore   = Σ_{hop} baseScoreTerm(hop의 도착국, lang)            // §6.2 BaseScore 항 재사용
//   GoldScore     = Σ 배송 정산액(state.events의 'delivered'.payout —
//                     §3.5 배수식은 simulate.ts가 이미 적용해 이벤트에 실어 보냄, 여기선 합산만)
//                   + Σ 미배송(carried) 가치 × constants.score.unbankedOnArrestFactor   // D94
//   SurvivalScore = Σ_{s=1..5} (별 s 단계 생존 초) × (constants.score.survivalStarMultiplier × s)
//   AccFactor     = ACC²                                                  // §6.2와 동일 정의
//   ComboFactor   = computeComboFactor(maxCombo)                          // §6.2 항 재사용(국가 단위 콤보)
//   FinalScore    = round(TypingScore × AccFactor × ComboFactor + GoldScore + SurvivalScore)
//   TimeBonus 없음 — 완주 개념이 없는 무한 생존 모드라 GoldScore·SurvivalScore가 그 자리를 대체한다.
//
// 등급(D92): PI = CPM×ACC²(기존 computePI/gradeFromPI 재사용) — "미완주 시 최대 B"(computeGrade)
// 캡은 chase에 적용하지 않는다(체포/자수가 유일한 종료라 완주 개념이 없어 캡을 걸면 전원 B 이하가
// 되어 등급 체계가 무의미해짐). 대신 S 등급에만 "배송 1회 이상" 조건을 추가한다: 배송이 한 번도
// 없었던 순수 도주 런은 raw grade가 S여도 A로 강등한다(A 자체는 배송 여부와 무관하게 그대로 —
// 리드 확정 문구: "배송 0 순수 도주 런은 A 이하로 캡").

import type { CountryId } from '../types/country';
import {
  baseScoreTerm,
  computeAccuracy,
  computeComboFactor,
  computeCpm,
  type ScoreConfig,
  type ScoreCountry,
} from '../scoring/score';
import {
  computePI,
  DEFAULT_GRADE_CONFIG,
  gradeFromPI,
  type Grade,
  type GradeConfig,
} from '../scoring/grade';
import type { ChaseConstants } from './constants';
import type { ChaseState } from './simulate';

/** 이 런에서 등장한 모든 국가(state.visited 전체 — 홈 포함)를 커버해야 하는 ScoreCountry 조회 테이블. */
export type ChaseCountryLookup = Readonly<Record<CountryId, ScoreCountry>>;

/**
 * chase 런의 타이핑 측정 원시값(docs/01 §6.1 RunStats에 대응). chase는 perCountry/스킵 개념이
 * 없으므로(D95 — 스킵 부재) RunStats 그대로가 아니라 CPM/ACC/ComboFactor 계산에 필요한 4개
 * 필드만 뽑은 전용 타입을 쓴다.
 */
export interface ChaseTypingStats {
  totalKeystrokes: number;
  correctKeystrokes: number;
  /** 카운트다운 종료 ~ 체포/자수 확정 시각(런 로컬 ms, state.timeMs와 동일 기준). */
  elapsedMs: number;
  /** 연속 "노오타" 국가(홉) 수 최대치 — 정의는 기존과 동일(§3.6, 금 획득/배송 무관). */
  maxCombo: number;
}

export interface ChaseScoreResult {
  cpm: number;
  acc: number;
  pi: number;
  /** D92: 배송 0회면 raw S는 A로 강등(그 외 등급은 그대로). */
  grade: Grade;
  /** 배송(홈 귀환 정산) 이벤트 횟수 — 등급 조건(D92)의 근거값. */
  delivered: number;
  typingScore: number;
  goldScore: number;
  survivalScore: number;
  accFactor: number;
  comboFactor: number;
  finalScore: number;
}

/**
 * chase 등급(D92): PI 컷은 기존 gradeFromPI를 그대로 재사용하되, delivered<1이면 raw S를 A로
 * 강등한다(A/B/C/D는 배송 여부와 무관하게 그대로) — "배송 0 순수 도주 런은 A 이하로 캡". 미완주
 * B캡(computeGrade)은 이 모드에 적용하지 않는다(§3.6 — 체포/자수가 유일한 종료).
 */
export function gradeChase(
  pi: number,
  delivered: number,
  cfg: GradeConfig = DEFAULT_GRADE_CONFIG,
): Grade {
  const raw = gradeFromPI(pi, cfg);
  return delivered < 1 && raw === 'S' ? 'A' : raw;
}

/**
 * TypingScore(§3.6) = Σ_{hop} baseScoreTerm(도착국, lang). state.visited = [home, …, 도착국들]이므로
 * slice(1)이 정확히 "홉 순서의 도착국 목록"이다(귀환 배송을 위해 홈을 다시 typing한 홉도 포함 —
 * 타이핑 노력은 반복 방문에도 매번 발생한다).
 */
function computeTypingScore(
  state: ChaseState,
  countryLookup: ChaseCountryLookup,
  lang: 'ko' | 'en',
): number {
  let sum = 0;
  for (let i = 1; i < state.visited.length; i++) {
    const id = state.visited[i]!;
    const country = countryLookup[id];
    if (!country) {
      throw new Error(
        `computeChaseScore: countryLookup에 방문국 "${id}"의 ScoreCountry 항목이 없다(계약 위반)`,
      );
    }
    sum += baseScoreTerm(country, lang);
  }
  return sum;
}

/**
 * GoldScore(§3.6·D94). 배송 정산액은 simulate.ts의 'delivered' 이벤트 payout을 그대로 합산한다
 * (§3.5 몰아 배송 배수식은 이미 그 payout에 적용되어 있다 — 여기서 재계산하지 않는다, 단일 원천).
 * 미배송(carried) 금은 가치의 unbankedOnArrestFactor(기본 0.5)만 가산.
 */
function computeGoldScore(
  state: ChaseState,
  constants: ChaseConstants,
): { goldScore: number; delivered: number } {
  let deliveredPayout = 0;
  let delivered = 0;
  for (const e of state.events) {
    if (e.type === 'delivered') {
      deliveredPayout += e.payout;
      delivered++;
    }
  }
  let unbankedValue = 0;
  for (const c of state.carried) unbankedValue += c.value;
  const goldScore = deliveredPayout + unbankedValue * constants.score.unbankedOnArrestFactor;
  return { goldScore, delivered };
}

/**
 * SurvivalScore(§3.6) = Σ_{s=1..5}(별 s 단계 생존 초 × survivalStarMultiplier×s). state.events의
 * 'starChanged' 항목은 simulate.ts가 tMs 오름차순으로만 append하므로(§4.3 동시각 우선순위 규칙)
 * 원본 순서 그대로 순회해 구간 길이를 구한다 — 별도 정렬 불요(단일 원천 invariant 재사용).
 * ★0 구간은 공식이 s=1..5만 합산하므로 기여 0. 마지막 구간은 state.timeMs(체포/자수/평가 종료
 * 시각 — 두 경우 모두 finalize 후 이 필드에 고정된다)까지.
 */
function computeSurvivalScore(state: ChaseState, constants: ChaseConstants): number {
  let survivalScore = 0;
  let prevT = 0;
  let stars = 0;
  for (const e of state.events) {
    if (e.type !== 'starChanged') continue;
    if (stars >= 1) {
      survivalScore += ((e.tMs - prevT) / 1000) * constants.score.survivalStarMultiplier * stars;
    }
    stars = e.to;
    prevT = e.tMs;
  }
  if (stars >= 1) {
    survivalScore += ((state.timeMs - prevT) / 1000) * constants.score.survivalStarMultiplier * stars;
  }
  return survivalScore;
}

/**
 * §3.6 FinalScore 전문. computeScore와 마찬가지로 클라(표시)·서버(재계산 검증)가 동일 코드를
 * import한다 — 이 함수 밖 재구현 금지.
 *
 * @param state simulateChase/advanceChase의 endMs 시점 스냅샷(체포·자수 종료 모두 지원, D95 —
 *   score.ts는 arrestedAtMs를 직접 참조하지 않고 state.timeMs만 종료 기준으로 쓴다).
 * @param countryLookup state.visited에 등장하는 모든 국가(홈 포함)를 커버하는 ScoreCountry 조회
 *   테이블. 누락 시 throw(계약 위반 조기 검출).
 * @param stats 이 런의 타이핑 측정 원시값(ChaseTypingStats).
 * @param lang 판정 언어(§11-D4 — L_i 산출 기준).
 * @param constants 이 런에 적용된 ChaseConstants(시드 발급 시점 constantsVersion과 함께 고정 —
 *   §9.4. GoldScore/SurvivalScore 계수의 유일한 원천).
 * @param cfg 등급 컷 오버라이드(KV config:client 값 주입용, computeScore의 ScoreConfig와 동일 계약).
 */
export function computeChaseScore(
  state: ChaseState,
  countryLookup: ChaseCountryLookup,
  stats: ChaseTypingStats,
  lang: 'ko' | 'en',
  constants: ChaseConstants,
  cfg: ScoreConfig = {},
): ChaseScoreResult {
  const cpm = computeCpm(stats.correctKeystrokes, stats.elapsedMs);
  const acc = computeAccuracy(stats.correctKeystrokes, stats.totalKeystrokes);
  const pi = computePI(cpm, acc);
  const gradeCfg: GradeConfig = { ...DEFAULT_GRADE_CONFIG, ...cfg.grade };

  const typingScore = computeTypingScore(state, countryLookup, lang);
  const { goldScore, delivered } = computeGoldScore(state, constants);
  const survivalScore = computeSurvivalScore(state, constants);

  const accFactor = acc * acc;
  const comboFactor = computeComboFactor(stats.maxCombo);

  const finalScore = Math.round(typingScore * accFactor * comboFactor + goldScore + survivalScore);
  const grade = gradeChase(pi, delivered, gradeCfg);

  return {
    cpm,
    acc,
    pi,
    grade,
    delivered,
    typingScore,
    goldScore,
    survivalScore,
    accFactor,
    comboFactor,
    finalScore,
  };
}
