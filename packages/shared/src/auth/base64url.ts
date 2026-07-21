// spec: docs/04 §5.2 (wt1 토큰 = base64url(payload).base64url(sig)), WT-M1-04
//
// 의존성 0 base64url(RFC 4648 §5, 패딩 없음) + UTF-8 코덱. Buffer 금지(세션 어댑테이션 §3):
// Node 24 테스트 환경과 Cloudflare Workers 양쪽에서 동일하게 도는 코드여야 하므로
// TextEncoder/TextDecoder(양쪽 전역 표준)만 쓴다.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// 역참조 테이블: 문자 코드 → 6-bit 값. 알파벳 밖 문자는 -1(디코드 시 throw로 이어진다).
const LOOKUP: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

const encoder = new TextEncoder();
// ignoreBOM: false는 두 런타임의 기본값과 동일 — workers/api가 이 패키지를 @cloudflare/
// workers-types와 함께 타입체크할 때 TextDecoderConstructorOptions가 두 필드 모두 요구해
// 명시했다(동작 변화 없음, WT-M3-02에서 발견).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** UTF-8 문자열 → 바이트. */
export function utf8ToBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/** 바이트 → UTF-8 문자열. 부정확한 UTF-8은 throw(fatal). */
export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** 바이트 → base64url(패딩 없음). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < n ? bytes[i + 1]! : 0;
    const b2 = i + 2 < n ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    if (i + 1 < n) out += ALPHABET[(triple >> 6) & 63];
    if (i + 2 < n) out += ALPHABET[triple & 63];
  }
  return out;
}

/** base64url(패딩 없음) → 바이트. 알파벳 밖 문자나 잘린 인코딩은 throw. */
export function base64urlToBytes(s: string): Uint8Array {
  // 길이 % 4 === 1 은 base64에서 산출 불가능한 형태다(1문자=6bit로 바이트 경계에 못 맞음).
  if (s.length % 4 === 1) throw new Error('invalid base64url length');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const val = code < 128 ? LOOKUP[code]! : -1;
    if (val < 0) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
