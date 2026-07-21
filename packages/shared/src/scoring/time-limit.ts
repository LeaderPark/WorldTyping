// spec: docs/01 §7.2(서바이벌 국가당 제한시간 수식)
//
// timeLimit_i(sec) = clamp(3.0, 1.5 + L_i × 0.40 × tierRelax, 15.0)
// tierRelax = 1.30 − 0.075 × (tier_i − 1)                 // T1=1.30 … T5=1.00
// 예외: 런의 첫 번째 국가(indexInRun===0)는 위 결과를 ×2(손 올리는 시간 보정).
// 문서가 이 배수를 clamp식과 별도 문장으로 병기하므로("예외: …") ×2 이후 재-clamp하지
// 않는다 — 첫 국가에 한해 상한 15초를 넘는 관대함이 의도다.

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
