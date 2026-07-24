// spec: WT-AUTH-01 acceptance — google-idtoken 서명/iss/aud/exp/kid 실패 각 케이스(로컬 RSA 키 목 JWKS).
//
// 순수 node vitest(vitest-pool-workers 아님 — cloudflare:test 미사용). WebCrypto(crypto.subtle)는
// Node 24 전역이라 로컬 RSA 키쌍 생성 + JWT RS256 서명 + JWKS 목이 그대로 돈다. fetch/KV는
// 주입/페이크로 대체 — 실 네트워크 없음.
import { beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64url, utf8ToBytes } from "@wt/shared";
import { verifyGoogleIdToken } from "./google-idtoken";
import { KV_KEYS } from "./kv-keys";

const CLIENT_ID = "615582111042-test.apps.googleusercontent.com";
const ISS = "https://accounts.google.com";
const KID = "test-key-1";
const NOW = 1_800_000_000_000; // 고정 기준 시각(ms)

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // exportKey('jwk') 반환형은 ArrayBuffer | JsonWebKey 유니온 — 'jwk' 포맷이라 JsonWebKey로 좁힌다.
  publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
});

function b64urlJson(obj: unknown): string {
  return bytesToBase64url(utf8ToBytes(JSON.stringify(obj)));
}

interface Claims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** 로컬 개인키로 RS256 JWT를 만든다. header/claims를 세밀 조정 가능(변조·필드 누락 케이스용). */
async function makeToken(claims: Claims, header?: Record<string, unknown>): Promise<string> {
  const h = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const p = b64urlJson(claims);
  const signingInput = h + "." + p;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    utf8ToBytes(signingInput),
  );
  return signingInput + "." + bytesToBase64url(new Uint8Array(sig));
}

/** JWK 하나(kid 부여)로 JWKS를 반환하는 목 fetch. */
function jwksFetch(jwks: { keys: unknown[] }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function goodJwks(): { keys: unknown[] } {
  return { keys: [{ ...publicJwk, kid: KID, use: "sig", alg: "RS256" }] };
}

function validClaims(overrides: Partial<Claims> = {}): Claims {
  return {
    iss: ISS,
    aud: CLIENT_ID,
    sub: "google-sub-1234567890",
    exp: Math.floor(NOW / 1000) + 3600,
    email: "player@example.com",
    email_verified: true,
    name: "Test Player",
    ...overrides,
  };
}

describe("verifyGoogleIdToken — 성공 경로", () => {
  it("유효한 RS256 ID-token을 검증하고 클레임을 돌려준다", async () => {
    const token = await makeToken(validClaims());
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.sub).toBe("google-sub-1234567890");
      expect(r.identity.email).toBe("player@example.com");
      expect(r.identity.emailVerified).toBe(true);
      expect(r.identity.name).toBe("Test Player");
    }
  });

  it("email_verified=false면 email을 신뢰하지 않는다(undefined)", async () => {
    const token = await makeToken(validClaims({ email_verified: false }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.emailVerified).toBe(false);
      expect(r.identity.email).toBeUndefined();
    }
  });

  it("email_verified가 문자열 'true'여도 검증으로 인정한다(Google 변형 포맷)", async () => {
    const token = await makeToken(validClaims({ email_verified: "true" }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.email).toBe("player@example.com");
  });

  it("aud가 배열이고 clientId를 포함하면 통과한다", async () => {
    const token = await makeToken(validClaims({ aud: ["other-client", CLIENT_ID] }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("iss가 'accounts.google.com'(스킴 없는 변형)이어도 통과한다", async () => {
    const token = await makeToken(validClaims({ iss: "accounts.google.com" }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});

describe("verifyGoogleIdToken — 실패 경로", () => {
  it("서명 변조 → bad_signature", async () => {
    const token = await makeToken(validClaims());
    const parts = token.split(".");
    // 서명 세그먼트 1글자 플립.
    const s = parts[2]!;
    parts[2] = (s[0] === "A" ? "B" : "A") + s.slice(1);
    const r = await verifyGoogleIdToken(parts.join("."), {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("다른 키로 서명된 토큰 → bad_signature(공개키 불일치)", async () => {
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const h = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
    const p = b64urlJson(validClaims());
    const signingInput = h + "." + p;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, utf8ToBytes(signingInput));
    const forged = signingInput + "." + bytesToBase64url(new Uint8Array(sig));
    const r = await verifyGoogleIdToken(forged, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("iss 불일치 → bad_issuer", async () => {
    const token = await makeToken(validClaims({ iss: "https://evil.example" }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "bad_issuer" });
  });

  it("aud 불일치 → bad_audience", async () => {
    const token = await makeToken(validClaims({ aud: "some-other-client.apps.googleusercontent.com" }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "bad_audience" });
  });

  it("만료(exp가 now-300s보다 과거) → expired", async () => {
    // exp = now - 400s → 300s 유예를 넘겨 만료.
    const token = await makeToken(validClaims({ exp: Math.floor(NOW / 1000) - 400 }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("만료 경계: now-299s는 유예 내라 통과(서명 유효 전제)", async () => {
    const token = await makeToken(validClaims({ exp: Math.floor(NOW / 1000) - 299 }));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("sub 없음 → no_subject", async () => {
    const c = validClaims();
    delete c.sub;
    const token = await makeToken(c);
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "no_subject" });
  });

  it("alg가 RS256이 아니면 → unsupported_alg (서명 검증 이전 차단)", async () => {
    const token = await makeToken(validClaims(), { alg: "none" });
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("헤더에 kid 없음 → no_kid", async () => {
    // header에서 kid를 제거(빈 문자열 header override로 kid를 덮어써 제거).
    const h = b64urlJson({ alg: "RS256", typ: "JWT" });
    const p = b64urlJson(validClaims());
    const signingInput = h + "." + p;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      utf8ToBytes(signingInput),
    );
    const token = signingInput + "." + bytesToBase64url(new Uint8Array(sig));
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "no_kid" });
  });

  it("JWKS에 해당 kid가 없음(KV 없음, 재조회 불가) → unknown_kid", async () => {
    const token = await makeToken(validClaims());
    const wrong = { keys: [{ ...publicJwk, kid: "some-other-kid", use: "sig", alg: "RS256" }] };
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(wrong),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("3분절이 아니면 → malformed", async () => {
    const r = await verifyGoogleIdToken("not.a.valid.jwt.token", {
      clientId: CLIENT_ID,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "malformed" });
  });

  it("JWKS fetch 실패(비 2xx) → jwks_unavailable", async () => {
    const token = await makeToken(validClaims());
    const failFetch = (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchImpl: failFetch,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "jwks_unavailable" });
  });
});

describe("verifyGoogleIdToken — KV 캐시 + kid 미스 1회 재조회", () => {
  function fakeKv(seed?: string): { kv: KVNamespace; store: Map<string, string> } {
    const store = new Map<string, string>();
    if (seed) store.set(KV_KEYS.authGoogleJwks, seed);
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as KVNamespace;
    return { kv, store };
  }

  it("캐시에 stale JWKS(다른 kid)만 있으면 fetch로 1회 재조회해 성공하고 캐시를 갱신한다", async () => {
    const token = await makeToken(validClaims());
    // 캐시에는 엉뚱한 kid만 — fresh fetch가 올바른 kid를 준다.
    const stale = JSON.stringify({ keys: [{ ...publicJwk, kid: "stale-kid", use: "sig" }] });
    const { kv, store } = fakeKv(stale);
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      kv,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
    // 재조회 결과가 캐시에 반영됐는지 — 이제 올바른 kid가 들어 있어야 한다.
    const cached = JSON.parse(store.get(KV_KEYS.authGoogleJwks)!) as { keys: Array<{ kid: string }> };
    expect(cached.keys.some((k) => k.kid === KID)).toBe(true);
  });

  it("캐시가 비어 있으면 fetch 후 캐시에 저장한다", async () => {
    const token = await makeToken(validClaims());
    const { kv, store } = fakeKv();
    expect(store.has(KV_KEYS.authGoogleJwks)).toBe(false);
    const r = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      kv,
      fetchImpl: jwksFetch(goodJwks()),
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(store.has(KV_KEYS.authGoogleJwks)).toBe(true);
  });
});
