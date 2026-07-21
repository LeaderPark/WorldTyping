// spec: docs/02 §8 (국기 이모지 산술), WT-M1-05
//
// alpha-2 → 리저널 인디케이터 심볼 2코드포인트. 예: "KR" → "🇰🇷".
// flagEmoji는 OG 이미지/공유 텍스트용(런타임 UI는 flag-icons SVG를 쓴다).

/** 두 글자 대문자 국가 코드를 리저널 인디케이터 이모지로 변환. */
export function flagEmoji(id: string): string {
  if (!/^[A-Z]{2}$/.test(id)) {
    throw new Error(`flagEmoji: id must be 2 uppercase letters, got "${id}" (docs/02 §8)`);
  }
  return String.fromCodePoint(...[...id].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
