// spec: docs/04 §5.2 (HMAC-SHA256 서명/검증), 세션 어댑테이션 §3(WebCrypto only, no Buffer /
//       타이밍 세이프 비교는 crypto.subtle.verify), WT-M1-04
//
// WebCrypto HMAC-SHA256 프리미티브. token.ts(서명·검증)와 derive.ts(pid/device_hash 파생)가
// 공유하는 유일한 crypto 접점 — 키 import를 한 곳에 모아 용도(sign/verify)별로 분리한다.

import { utf8ToBytes } from './base64url';

// WebCrypto의 BufferSource는 ArrayBuffer 백킹 뷰만 받는다(TS 5.7+ Uint8Array<ArrayBufferLike>).
// TextEncoder/디코더 산출물은 ArrayBufferLike(SharedArrayBuffer 가능성 포함)라 타입이 안 맞으므로,
// crypto에 넘기기 직전 ArrayBuffer 백킹 뷰로 한 번 좁힌다(런타임 복사 1회, 시크릿·메시지 길이라 무시 가능).
function toBuf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

// 키 import는 subtle 왕복이라 상대적으로 비싸다. 세션 검증은 요청마다 도는 핫패스이므로
// (secret, 용도)별 CryptoKey를 캐시한다. 시크릿 문자열은 이미 env에 상주하고, 캐시하는 것은
// 추출 불가(non-extractable) CryptoKey라 원문 노출 표면을 늘리지 않는다.
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const cacheKey = usage + '\0' + secret;
  let cached = keyCache.get(cacheKey);
  if (cached === undefined) {
    cached = crypto.subtle.importKey(
      'raw',
      toBuf(utf8ToBytes(secret)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      [usage],
    );
    keyCache.set(cacheKey, cached);
  }
  return cached;
}

/** HMAC-SHA256(secret, message) → 32바이트 서명. */
export async function hmacSign(secret: string, message: string): Promise<Uint8Array> {
  const key = await importKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, toBuf(utf8ToBytes(message)));
  return new Uint8Array(sig);
}

/**
 * 서명 검증. crypto.subtle.verify가 상수 시간 비교를 보장한다(수동 문자열 비교 금지 — 세션 어댑테이션 §3).
 */
export async function hmacVerify(
  secret: string,
  message: string,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await importKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, toBuf(signature), toBuf(utf8ToBytes(message)));
}
