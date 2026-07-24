// spec: docs/00 §11-D68(② 인증 방식 — GIS ID-token, 서버 JWKS RS256 검증)·docs/04 §5.5(계정 계층)
//       + WT-AUTH-01
//
// Google Identity Services(GIS) ID-token(JWT, RS256 서명) 서버 검증. **외부 JWT/JWKS 라이브러리
// 금지 — WebCrypto 수제.** (CLAUDE.md "신규 npm 의존성 금지" + WT-AUTH-01 금지사항.)
//
// 검증 순서(보안상 서명 확인이 클레임 신뢰보다 앞선다):
//   ① JWT 3분절 파싱 → 헤더 디코드(alg === 'RS256', kid 존재)
//   ② kid로 Google JWKS 공개키 조회(KV auth:google:jwks 6h 캐시, kid 미스 시 1회 재조회)
//   ③ WebCrypto RSASSA-PKCS1-v1_5/SHA-256으로 서명 검증(signingInput = headerB64 + '.' + payloadB64)
//   ④ 페이로드 디코드 → 클레임 검증: iss ∈ {accounts.google.com, https://accounts.google.com},
//      aud === GOOGLE_CLIENT_ID, exp > now − 300s(시계 오차 허용), sub 비어있지 않음.
//      email은 email_verified인 경우에만 신뢰(§5.5).
//
// fetch는 주입 가능(fetchImpl) — 테스트가 로컬 RSA 키로 만든 목 JWKS를 주입한다. KV는 옵션(로컬
// 개발/테스트에서 미바인딩이면 매 요청 fetch — 정상 로그인 빈도라 무해).
//
// base64url/utf8 코덱은 @wt/shared의 것을 재사용한다(wt1 토큰과 동일 RFC 4648 §5, 무패딩). JWT
// 세그먼트도 무패딩 base64url이라 동일 디코더로 안전하게 처리된다.
import { base64urlToBytes, bytesToUtf8 } from "@wt/shared";
import { KV_KEYS } from "./kv-keys";

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const JWKS_CACHE_TTL_SEC = 6 * 60 * 60; // 6시간(docs/04 §5.5)
const EXP_SKEW_MS = 300 * 1000; // exp > now − 300s 허용(시계 오차)

/** Google JWKS 항목(oauth2/v3/certs). RSA 공개키만 다룬다. */
interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}
interface Jwks {
  keys: Jwk[];
}

/** 검증에 성공한 Google 계정 클레임(라우트 upsert가 소비). */
export interface GoogleIdentity {
  /** sub — 계정 고유·불변 식별자(이메일 아님). user_id 파생의 유일 입력. */
  sub: string;
  /** email_verified인 경우에만 채워진다(그 외 undefined). */
  email?: string;
  emailVerified: boolean;
  /** 표시 이름(닉네임 초기값 후보). */
  name?: string;
  picture?: string;
}

export type GoogleVerifyResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: GoogleVerifyFailReason };

export type GoogleVerifyFailReason =
  | "malformed" // JWT 구조/헤더/페이로드 파싱 실패
  | "unsupported_alg" // alg !== RS256
  | "no_kid" // 헤더에 kid 없음
  | "jwks_unavailable" // JWKS fetch 실패
  | "unknown_kid" // 재조회 후에도 kid에 맞는 공개키 없음
  | "bad_signature" // RSA 서명 불일치
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "no_subject";

export interface GoogleVerifyOptions {
  /** 서버 aud 검증값(공개값 GOOGLE_CLIENT_ID). */
  clientId: string;
  /** JWKS 6h 캐시. 미바인딩(로컬/테스트)이면 매 검증 fetch. */
  kv?: KVNamespace;
  /** 테스트 목 주입점. 기본값은 전역 fetch. */
  fetchImpl?: typeof fetch;
  /** exp 판정 기준 시각(ms). 기본 Date.now(). */
  now?: number;
}

/**
 * Google ID-token(credential) 검증. 성공 시 신뢰 가능한 클레임(GoogleIdentity)을 돌려준다.
 * 어떤 단계에서 실패했는지는 reason으로만 구분(라우트는 전부 401로 접는다 — 공격자 힌트 최소화).
 */
export async function verifyGoogleIdToken(
  credential: string,
  opts: GoogleVerifyOptions,
): Promise<GoogleVerifyResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ① 3분절 파싱 + 헤더 디코드.
  const parts = credential.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodeSegment(headerB64);
  if (!header) return fail("malformed");
  if (header.alg !== "RS256") return fail("unsupported_alg");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (!kid) return fail("no_kid");

  // ② kid → 공개키. 캐시에 없으면 1회 재조회.
  let jwks: Jwks | null;
  let fromCache: boolean;
  try {
    ({ jwks, fromCache } = await loadJwks(opts.kv, fetchImpl));
  } catch {
    return fail("jwks_unavailable");
  }
  let jwk = jwks?.keys.find((k) => k.kid === kid);
  if (!jwk && fromCache) {
    // 캐시가 회전(rotate)돼 새 kid를 아직 못 받은 경우 — Google에서 즉시 갱신 후 1회 재탐색.
    try {
      const fresh = await fetchJwks(fetchImpl);
      if (opts.kv) {
        await opts.kv.put(KV_KEYS.authGoogleJwks, JSON.stringify(fresh), {
          expirationTtl: JWKS_CACHE_TTL_SEC,
        });
      }
      jwks = fresh;
      jwk = fresh.keys.find((k) => k.kid === kid);
    } catch {
      return fail("jwks_unavailable");
    }
  }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return fail("unknown_kid");

  // ③ 서명 검증(RSASSA-PKCS1-v1_5 / SHA-256). signingInput = headerB64 + '.' + payloadB64(ASCII).
  let signatureOk: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      // WebCrypto가 요구하는 최소 필드만 전달 — Google JWK의 use/key_ops 등과의 불일치 여지를 없앤다.
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = base64urlToBytes(sigB64);
    const data = asciiBytes(headerB64 + "." + payloadB64);
    signatureOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, toBuf(sig), toBuf(data));
  } catch {
    // importKey/디코드 실패(변조된 서명 세그먼트 등)는 서명 불일치로 취급.
    return fail("bad_signature");
  }
  if (!signatureOk) return fail("bad_signature");

  // ④ 클레임 검증(서명이 확인된 뒤에만 신뢰).
  const payload = decodeSegment(payloadB64);
  if (!payload) return fail("malformed");

  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!GOOGLE_ISS.has(iss)) return fail("bad_issuer");

  const aud = payload.aud;
  const audOk =
    typeof aud === "string"
      ? aud === opts.clientId
      : Array.isArray(aud) && aud.includes(opts.clientId);
  if (!audOk) return fail("bad_audience");

  const exp = payload.exp;
  if (typeof exp !== "number" || exp * 1000 <= now - EXP_SKEW_MS) return fail("expired");

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (sub.length === 0) return fail("no_subject");

  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  const email =
    emailVerified && typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  const picture = typeof payload.picture === "string" ? payload.picture : undefined;

  return { ok: true, identity: { sub, email, emailVerified, name, picture } };
}

// ───────────────────────── 내부 헬퍼 ─────────────────────────

function fail(reason: GoogleVerifyFailReason): GoogleVerifyResult {
  return { ok: false, reason };
}

/** base64url 세그먼트 → JSON 객체(실패 시 null). */
function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const json = JSON.parse(bytesToUtf8(base64urlToBytes(seg))) as unknown;
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** JWKS 로드: KV 캐시 우선, 없으면 Google에서 fetch(그리고 캐시). */
async function loadJwks(
  kv: KVNamespace | undefined,
  fetchImpl: typeof fetch,
): Promise<{ jwks: Jwks; fromCache: boolean }> {
  if (kv) {
    const cached = await kv.get(KV_KEYS.authGoogleJwks);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as Jwks;
        if (parsed && Array.isArray(parsed.keys)) return { jwks: parsed, fromCache: true };
      } catch {
        // 캐시 손상 — 아래 fresh fetch로 폴백.
      }
    }
  }
  const fresh = await fetchJwks(fetchImpl);
  if (kv) {
    await kv.put(KV_KEYS.authGoogleJwks, JSON.stringify(fresh), {
      expirationTtl: JWKS_CACHE_TTL_SEC,
    });
  }
  return { jwks: fresh, fromCache: false };
}

/** Google 인증서 엔드포인트에서 JWKS를 받아온다. 실패 시 throw(호출측이 jwks_unavailable로 매핑). */
async function fetchJwks(fetchImpl: typeof fetch): Promise<Jwks> {
  const res = await fetchImpl(GOOGLE_CERTS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as Jwks;
  if (!body || !Array.isArray(body.keys)) throw new Error("JWKS malformed");
  return body;
}

/** ASCII 문자열 → 바이트(JWT signingInput은 순수 ASCII). */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// WebCrypto BufferSource는 ArrayBuffer 백킹 뷰를 요구한다(hmac.ts와 동일 사유 — SharedArrayBuffer
// 가능성 배제). crypto에 넘기기 직전 한 번 복사한다(서명/데이터 길이라 비용 무시 가능).
function toBuf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
