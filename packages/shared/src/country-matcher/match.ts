// spec: docs/02 §3 — 이 파일 수정 시 서버 검증도 함께 변한다. 임의 수정 금지.
// docs/00 §11-D19(경로 packages/shared/country-matcher/).
//
// matchInput(docs/02 §3.3)은 3-상태만 반환한다. matchInputDetail(docs/03 §2.6)은
// UI 채색·타수 계상을 위한 확장판이며 클라·서버가 같은 코드를 공유한다.
// MatchState는 공용 타입이라 types/game.ts에 정의되어 있고 여기서는 import만 한다.

import type { Country } from '../types/country';
import type { MatchState } from '../types/game';
import { toJamoSeq } from './hangul';
import { normalizeEn, normalizeKo } from './normalize';

export interface CompiledTarget {
  /** acceptedInput 원문(정규화 완료) — UI 힌트 표시용 */
  display: string;
  /** ko: 자모 시퀀스 / en: normalizeEn 결과 */
  key: string;
}

export function compileTargets(c: Country, lang: 'ko' | 'en'): CompiledTarget[] {
  const inputs = lang === 'ko' ? c.acceptedInputsKo : c.acceptedInputsEn;
  return inputs.map((display) => ({
    display,
    key: lang === 'ko' ? toJamoSeq(display) : display,
  }));
}

export function matchInput(
  rawInput: string,
  targets: CompiledTarget[],
  lang: 'ko' | 'en',
): MatchState {
  const norm = lang === 'ko' ? normalizeKo(rawInput) : normalizeEn(rawInput);
  if (norm.length === 0) return 'PREFIX'; // 빈 입력은 항상 유효
  const key = lang === 'ko' ? toJamoSeq(norm) : norm;
  let anyPrefix = false;
  for (const t of targets) {
    if (t.key === key) return 'EXACT';
    if (t.key.startsWith(key)) anyPrefix = true;
  }
  return anyPrefix ? 'PREFIX' : 'MISS';
}

/** 두 문자열의 공통 접두 길이. 자모열 채색·계상(§2.4 accountant)의 기준. */
export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export interface MatchDetail {
  state: MatchState;
  /** 입력 자모열과 공통 prefix가 가장 긴 타깃 (UI 채색·계상 기준) */
  bestTarget: CompiledTarget;
  /** bestTarget.key 기준 일치한 자모 길이 */
  matchedLen: number;
  /** 입력 자모열 전체 길이 */
  inputLen: number;
}

export function matchInputDetail(
  rawInput: string,
  targets: CompiledTarget[],
  lang: 'ko' | 'en',
): MatchDetail {
  // 계약 위반 조기 발견: 빈 targets는 국가 데이터/컴파일 버그다(WT-M1-01 지시 2).
  if (targets.length === 0) {
    throw new Error('matchInputDetail: targets must not be empty (docs/03 §2.6)');
  }
  const norm = lang === 'ko' ? normalizeKo(rawInput) : normalizeEn(rawInput);
  const key = lang === 'ko' ? toJamoSeq(norm) : norm;
  let best: CompiledTarget = targets[0]!; // 위 가드로 항상 존재. 루프 첫 회에 재할당됨.
  let bestLen = -1;
  for (const t of targets) {
    if (t.key === key)
      return { state: 'EXACT', bestTarget: t, matchedLen: key.length, inputLen: key.length };
    const l = commonPrefixLen(t.key, key);
    if (l > bestLen) {
      bestLen = l;
      best = t;
    }
  }
  const state: MatchState =
    key.length === 0 || targets.some((t) => t.key.startsWith(key)) ? 'PREFIX' : 'MISS';
  return { state, bestTarget: best, matchedLen: bestLen, inputLen: key.length };
}
