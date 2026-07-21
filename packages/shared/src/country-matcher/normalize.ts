// spec: docs/02 §3 — 이 파일 수정 시 서버 검증도 함께 변한다. 임의 수정 금지.
// docs/00 §11-D19(경로 packages/shared/country-matcher/), §11-D4(영어 공백/구두점 제거 확정).
// acceptedInputsKo/En은 빌드 시 이미 이 함수를 통과한 값 → 런타임엔 사용자 입력만 정규화한다.

/** 영어: NFD → 결합 다이어크리틱 제거 → lowercase → 공백/구두점 제거 */
export function normalizeEn(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // é→e, ô→o (Côte d'Ivoire 대응)
    .toLowerCase()
    .replace(/[\s.\-'’`,()]/g, ''); // 공백·마침표·하이픈·아포스트로피·쉼표·괄호 제거
}
// normalizeEn("Côte d'Ivoire") === "cotedivoire"
// normalizeEn("United States") === "unitedstates"

/** 한국어: NFC → 공백/구두점/가운뎃점 제거. 대소문자 개념 없음 */
export function normalizeKo(s: string): string {
  return s.normalize('NFC').replace(/[\s.\-·,()]/g, '');
}
// normalizeKo("파푸아 뉴기니") === "파푸아뉴기니"
