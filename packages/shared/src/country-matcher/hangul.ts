// spec: docs/02 §3 — 이 파일 수정 시 서버 검증도 함께 변한다. 임의 수정 금지.
// docs/00 §11-D19(경로 packages/shared/country-matcher/).
//
// 두벌식 IME 조합 중 음절은 목표 음절과 다르다("가나"의 keystroke 열: ㄱ→가→간→가나).
// 음절 단위 startsWith 비교는 "간" 시점에 오답이 나는 치명 버그를 만든다. 따라서 입력·목표를
// 모두 자모(jamo) keystroke 시퀀스로 분해해 자모 수준에서 접두 비교한다.

const CHO = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
const JUNG = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
const JONG = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
/** 두벌식 keystroke 단위로의 재분해 테이블 (쌍자음·ㅐㅔㅒㅖ는 미분해) */
const COMPOUND: Record<string, string> = {
  'ㅘ': 'ㅗㅏ', 'ㅙ': 'ㅗㅐ', 'ㅚ': 'ㅗㅣ', 'ㅝ': 'ㅜㅓ', 'ㅞ': 'ㅜㅔ', 'ㅟ': 'ㅜㅣ', 'ㅢ': 'ㅡㅣ',
  'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ', 'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ',
  'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ', 'ㅄ': 'ㅂㅅ',
};

function expand(jamo: string): string {
  return COMPOUND[jamo] ?? jamo;
}

/** 임의 문자열 → keystroke 수준 자모 시퀀스. 비한글 문자는 그대로 통과 */
export function toJamoSeq(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const cho = CHO[Math.floor(idx / 588)]!;
      const jung = JUNG[Math.floor((idx % 588) / 28)]!;
      const jong = JONG[idx % 28]!;
      out += expand(cho) + expand(jung) + (jong ? expand(jong) : '');
    } else if (code >= 0x3131 && code <= 0x3163) {
      out += expand(ch); // 낱자모 (조합 첫 타)
    } else {
      out += ch; // 숫자·라틴 등
    }
  }
  return out;
}
