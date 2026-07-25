// spec: docs/01 §7.2(서바이벌 국가당 제한시간 수식)
//
// timeLimit_i(sec) = clamp(3.0, 1.5 + L_i × 0.40 × tierRelax, 15.0)
// tierRelax = 1.30 − 0.075 × (tier_i − 1)                 // T1=1.30 … T5=1.00
// 예외: 런의 첫 번째 국가(indexInRun===0)는 위 결과를 ×2(손 올리는 시간 보정).
// 문서가 이 배수를 clamp식과 별도 문장으로 병기하므로("예외: …") ×2 이후 재-clamp하지
// 않는다 — 첫 국가에 한해 상한 15초를 넘는 관대함이 의도다.
//
// WT-TIER-DIFFICULTY(§11-D107): 위 §7.2 공식은 그대로 두고, **티어 서바이벌 모드에만** 곱해지는
// 티어별 계수(TIER_TIME_FACTOR)와 그 적용 함수(tierTimeLimitMs)를 아래에 추가한다.

import type { DifficultyTier } from '../types/country';
import { requiredKeystrokes, type KeystrokeSource } from './keystrokes';

export type TimeLimitSource = KeystrokeSource & { difficultyTier: DifficultyTier };

export interface TimeLimitConfig {
  minSec: number;
  maxSec: number;
  baseSec: number;
  perCharSec: number;
  tierRelaxBase: number;
  tierRelaxStep: number;
  /** 런의 첫 국가에 적용되는 배수(docs/01 §7.2 "예외"). */
  firstCountryMultiplier: number;
}

/** docs/01 §7.2 수식의 계수 기본값. KV config:client 페치 실패 시 폴백. */
export const DEFAULT_TIME_LIMIT_CONFIG: Readonly<TimeLimitConfig> = {
  minSec: 3.0,
  maxSec: 15.0,
  baseSec: 1.5,
  perCharSec: 0.4,
  tierRelaxBase: 1.3,
  tierRelaxStep: 0.075,
  firstCountryMultiplier: 2,
};

/**
 * 티어 서바이벌 전용 제한시간 계수(docs/00 §11-D107).
 *
 * 티어는 "인지도" 축이라 상위 티어가 곧 어려운 판이 되지 못했다(낯설어도 이름이 짧으면 쉽다).
 * 난이도 축을 하나 더 얹어, 같은 국가라도 티어 서바이벌에서는 티어가 올라갈수록 제한시간이
 * 짧아지게 한다. §7.2의 tierRelax(국가 티어별 관대함)와는 다른 축이다 — tierRelax는 전 모드
 * 공통 수식의 일부고, 이 계수는 **티어 서바이벌 모드에만** 곱해진다(대륙/세계일주/데일리/
 * 멀티 레이스/chase는 무영향 — 소비처는 engine rules/tier 하나뿐).
 */
export const TIER_TIME_FACTOR: Readonly<Record<DifficultyTier, number>> = {
  1: 1.2,
  2: 1.1,
  3: 1.0,
  4: 0.85,
  5: 0.7,
};

function clamp(min: number, v: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * 서바이벌 국가 indexInRun(0-based)의 제한시간(ms).
 * @param country nameKo/nameEn(L_i 산출용)과 difficultyTier를 가진 국가.
 * @param indexInRun 런 내 순번. 0이면 첫 국가 배수가 적용된다.
 */
export function timeLimitMs(
  country: TimeLimitSource,
  indexInRun: number,
  lang: 'ko' | 'en',
  cfg: Partial<TimeLimitConfig> = {},
): number {
  const c: TimeLimitConfig = { ...DEFAULT_TIME_LIMIT_CONFIG, ...cfg };
  const L = requiredKeystrokes(country, lang);
  const tierRelax = c.tierRelaxBase - c.tierRelaxStep * (country.difficultyTier - 1);
  const raw = c.baseSec + L * c.perCharSec * tierRelax;
  let sec = clamp(c.minSec, raw, c.maxSec);
  if (indexInRun === 0) sec *= c.firstCountryMultiplier;
  return Math.round(sec * 1000);
}

/**
 * 티어 서바이벌(T1~T5) 국가 indexInRun의 제한시간(ms) — §11-D107.
 *
 * = round(timeLimitMs(...) × TIER_TIME_FACTOR[tier]).
 *
 * 반올림 규칙(결정적): §7.2 공식의 ms 정수값을 먼저 확정한 뒤(timeLimitMs가 이미 round)
 * 계수를 곱하고 다시 `Math.round`(half-up, +∞ 방향)한다. 정수 ms × 유한 이진 계수의 곱과
 * Math.round는 IEEE754에서 엔진 독립적으로 동일한 값을 낸다 — 클라(engine rules/tier)와
 * 서버가 같은 함수를 import하는 한 값이 갈릴 수 없다(Gotcha 3).
 * 첫 국가 ×2는 timeLimitMs 안에서 이미 적용되므로 여기서는 계수만 곱한다(곱셈 순서는
 * 가환이나 반올림 지점을 이 한 곳으로 고정한다).
 *
 * 계수 키는 `country.difficultyTier`다. 티어 세트는 정의상 단일 티어 풀에서만 뽑히므로
 * (buildTierSet — `difficultyTier === tier` 필터) 모드 티어와 국가 티어가 항상 같다.
 */
export function tierTimeLimitMs(
  country: TimeLimitSource,
  indexInRun: number,
  lang: 'ko' | 'en',
  cfg: Partial<TimeLimitConfig> = {},
): number {
  const base = timeLimitMs(country, indexInRun, lang, cfg);
  return Math.round(base * TIER_TIME_FACTOR[country.difficultyTier]);
}
