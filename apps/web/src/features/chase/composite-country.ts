// spec: docs/00 §11-D97(3-타깃 판정 — "chase는 3후보 acceptedInputs 합친 합성 Country를
//       TypingInputController.setCountry로 주입, 컨트롤러 무수정"), docs/09 §3.2·§6.2, WT-CH-06.
//
// TypingInputController.setCountry(c)는 c.acceptedInputsKo/En만 읽어 compileTargets를 컴파일한다
// (packages/engine/src/input-controller.ts, packages/shared/src/country-matcher/match.ts — 둘 다
// 무수정). 그 외 Country 필드는 컨트롤러 내부에서 전혀 참조되지 않으므로, 이 합성 Country는 3후보의
// acceptedInputsKo/En 합집합(중복 제거, 원본 순서 유지)만 실 값이고 나머지 필드는 첫 후보를 복제한
// 자리표시자다 — 컨트롤러의 EXACT 판정이 "3후보 중 하나에 완전 일치"의 권위 신호가 되게 한다(D97).
// 이 합성 Country의 id는 어떤 실 국가도 가리키지 않는다(센티널) — 판정/표시 어디서도 이 id로
// 국가를 조회하지 않는다(조회는 항상 원 후보 Country 배열에서 한다).
import type { Country } from '@wt/shared';

export const CHASE_COMPOSITE_ID = '__CHASE_COMPOSITE__';

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * 3(또는 그 이하) 후보의 acceptedInputsKo/En 합집합을 실은 합성 Country를 만든다. candidates가
 * 비어 있으면 throw(계약 위반 — 호출부는 항상 현재 노출 후보 배열을 넘겨야 한다).
 */
export function buildCompositeCountry(candidates: readonly Country[]): Country {
  const first = candidates[0];
  if (!first) {
    throw new Error('buildCompositeCountry: candidates must not be empty(D97 계약 위반)');
  }
  return {
    ...first,
    id: CHASE_COMPOSITE_ID,
    acceptedInputsKo: dedupe(candidates.flatMap((c) => c.acceptedInputsKo)),
    acceptedInputsEn: dedupe(candidates.flatMap((c) => c.acceptedInputsEn)),
  };
}
