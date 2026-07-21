// spec: docs/01 §6.2(BaseScore의 L_i)·§7.2(제한시간의 L_i), docs/00 §11-D4
// (영어 공백 타수 제거 확정 — 판정·타수 모두 공백 무시, 한 소스 두 정책 금지)
//
// L_i(국가별 정답 필요 타수)의 단일 원천. score.ts·time-limit.ts가 이 함수만 소비한다.
// WT-M1-01이 만든 normalizeKo/normalizeEn/toJamoSeq를 그대로 재사용한다(자체 재구현 금지
// — WT-M1-02 작업 블록 제약). country-matcher의 판정용 acceptedInputs가 아니라 canonical
// nameKo/nameEn 기준으로 계산한다(별칭은 길이가 제각각이라 점수·제한시간의 공정 기준이 될 수 없다).

import type { Country } from '../types/country';
import { toJamoSeq } from '../country-matcher/hangul';
import { normalizeEn, normalizeKo } from '../country-matcher/normalize';

/** requiredKeystrokes 호출에 필요한 최소 필드. 전체 Country 픽스처 없이도(스코어링 단위 테스트) 사용 가능. */
export type KeystrokeSource = Pick<Country, 'nameKo' | 'nameEn'>;

/**
 * 국가의 정답 필요 타수 L_i.
 * - ko: toJamoSeq(normalizeKo(nameKo)).length — 두벌식 keystroke 수(자모 단위).
 * - en: normalizeEn(nameEn).length — 공백/구두점 제거 후 문자 수(§11-D4).
 */
export function requiredKeystrokes(country: KeystrokeSource, lang: 'ko' | 'en'): number {
  return lang === 'ko'
    ? toJamoSeq(normalizeKo(country.nameKo)).length
    : normalizeEn(country.nameEn).length;
}
