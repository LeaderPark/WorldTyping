// spec: docs/02 §4.1 (친숙도 F 산식), §4.2 (경계값), WT-M1-05
//
// F = 0.50·R + 0.35·P + 0.15·(100−L)
//   P = clamp((log10(pop) − 5) / 4.2 × 100, 0, 100)
//   L = 한국어 표기 음절 수(공백 제외) 페널티: ≤3→0, 4→25, 5→45, 6-7→70, ≥8→100
// 경계값으로 T1..T5 배정. 최종 티어는 overrides/tiers.json 이 이긴다(§4.2).

import type { DifficultyTier } from '@wt/shared';

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 인구 점수 P (0-100). */
export function populationScore(population: number): number {
  if (population <= 0) return 0;
  return clamp(((Math.log10(population) - 5) / 4.2) * 100, 0, 100);
}

/** 한국어 표기 음절 수(공백·구두점 제외)로 이름 길이 페널티 L. */
export function nameLengthPenalty(nameKo: string): number {
  // 한글 음절(U+AC00–U+D7A3)만 계상. 공백·구두점·라틴은 제외한다.
  let syllables = 0;
  for (const ch of nameKo) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) syllables++;
  }
  if (syllables <= 3) return 0;
  if (syllables === 4) return 25;
  if (syllables === 5) return 45;
  if (syllables <= 7) return 70;
  return 100;
}

/** 친숙도 점수 F (0-100). */
export function familiarity(r: number, population: number, nameKo: string): number {
  const p = populationScore(population);
  const l = nameLengthPenalty(nameKo);
  return 0.5 * r + 0.35 * p + 0.15 * (100 - l);
}

/** F → 티어 경계 배정(§4.2). */
export function tierFromF(f: number): DifficultyTier {
  if (f >= 72) return 1;
  if (f >= 55) return 2;
  if (f >= 38) return 3;
  if (f >= 22) return 4;
  return 5;
}

/** R·인구·이름으로 산식 티어를 계산한다(override 적용 전 baseline). */
export function computeTier(r: number, population: number, nameKo: string): DifficultyTier {
  return tierFromF(familiarity(r, population, nameKo));
}
