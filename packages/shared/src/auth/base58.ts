// spec: docs/04 §5.1 (playerId = base58(HMAC(...))[0:12]), docs/00 §11-D10 (device_hash = base58(HMAC(...))),
//       WT-M1-04
//
// 의존성 0 Base58(Bitcoin 알파벳). 0/O/I/l 을 뺀 알파벳이라 사람이 눈으로 읽는 pid에 적합하다.
// bignum 바이트 배열 나눗셈 방식 — 임의 길이 바이트를 정확히 왕복한다.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const LOOKUP: Record<string, number> = (() => {
  const t: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET[i]!] = i;
  return t;
})();

/** 바이트 → base58 문자열. 선행 0 바이트는 '1'로 보존된다. */
export function bytesToBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  // 전부 0 바이트였고 zeros>0이면 '1'.repeat(zeros)만 남는다. 빈 입력이면 빈 문자열.
  return out;
}

/** base58 문자열 → 바이트. 알파벳 밖 문자는 throw. */
export function base58ToBytes(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const val = LOOKUP[str[i]!];
    if (val === undefined) throw new Error('invalid base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  // out[0..zeros)는 이미 0. 나머지는 리틀엔디언으로 쌓였으니 뒤집어 담는다.
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}
