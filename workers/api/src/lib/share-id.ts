// spec: docs/06 §9.1(share_id = 8자 base58), docs/00 §11 + WT-M6-02
//
// 공유 랜딩 단축 id. base58 알파벳(0/O/I/l 제외 — @wt/shared base58과 동일 집합)에서 균등 표집한
// 8자. 58⁸ ≈ 1.3×10¹⁴ 공간이라 충돌은 사실상 0(shares.share_id PK가 최종 방어). 방 코드와 동일한
// 거부 표집(rejection sampling)으로 256 % 58 편향을 제거한다.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const SHARE_ID_LENGTH = 8;
const ALPHABET_SET = new Set(ALPHABET.split(""));

/**
 * 8자 base58 share_id 1개를 생성한다.
 * @param randomBytes 테스트 주입용 seam(기본 crypto.getRandomValues).
 */
export function generateShareId(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const out: string[] = [];
  while (out.length < SHARE_ID_LENGTH) {
    const chunk = randomBytes(SHARE_ID_LENGTH);
    for (const b of chunk) {
      if (out.length >= SHARE_ID_LENGTH) break;
      if (b >= 232) continue; // 232 = 58*4 — 이 이상은 버려 균등성 확보
      out.push(ALPHABET[b % 58]!);
    }
  }
  return out.join("");
}

/** 유효한 share_id 형태인지(8자·알파벳 집합) 검사 — 라우트 파라미터 1차 방어. */
export function isValidShareId(raw: string): boolean {
  if (raw.length !== SHARE_ID_LENGTH) return false;
  for (const ch of raw) if (!ALPHABET_SET.has(ch)) return false;
  return true;
}

function defaultRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}
