// spec: docs/04 §6.1(setHash = SHA-256(countryIds.join(',')))·§6.2-4(세트 일치),
//       docs/00 §11-D5(티어 시드 = SHA-256(DAILY_SALT+"tier:"+tierId+":"+dateKST)) + WT-M3-03
//
// WebCrypto SHA-256만 사용(Node Buffer 금지 — Workers 런타임 호환, ip-hash.ts와 동일 규약).
// setHash·티어 시드 hex 생성의 단일 원천 — 문자열 → 소문자 hex 64자.

/** SHA-256(input) → 소문자 hex 64자. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
