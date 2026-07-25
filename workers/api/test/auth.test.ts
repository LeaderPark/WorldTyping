// spec: WT-AUTH-01 acceptance — auth 라우트 DB 통합(신규/재로그인 upsert 멱등·이메일 검증 저장·
//       삭제권 정합) + WT-FIX-GOOGLENAME(§11 후속) — Google 표시명을 ID형 값(USER_xxxx) 없이 그대로
//       쓰고, nickname_norm을 `u#${userId}`로 고정해 표시명 중복을 전역 허용한다. vitest-pool-workers
//       (실 D1/KV 시뮬레이션) + 0005 마이그레이션.
//
// /auth/dev(dev 심)로 계정 세션을 발급받아 upsert 경로를 검증한다 — 실 Google 토큰을 만들 수 없어
// dev 심이 유일한 통합 진입점이다(§11-D68-⑩). /auth/google의 크립토 검증은 src/lib/google-idtoken
// .test.ts(node)가 담당하고, 여기서는 검증 이후 공유되는 upsert/토큰/DB 부수효과만 본다.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bytesToBase64url,
  derivePlayerId,
  deriveDeviceHash,
  SessionPayloadSchema,
  utf8ToBytes,
  verifyToken,
} from "@wt/shared";
import type { AuthIdentityRow, UserRow } from "../src/db/types";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";

interface AuthRes {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
  geo: string;
  acct: true;
  email?: string;
}

async function authDev(body: { sub: string; name?: string; email?: string }): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectedPid(sub: string): Promise<string> {
  return derivePlayerId(env.SESSION_HMAC_SECRET, "google:" + sub);
}

function selectUser(userId: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE user_id = ?1`).bind(userId).first<UserRow>();
}

function selectIdentity(sub: string): Promise<AuthIdentityRow | null> {
  return env.DB.prepare(`SELECT * FROM auth_identities WHERE provider='google' AND subject = ?1`)
    .bind(sub)
    .first<AuthIdentityRow>();
}

describe("POST /auth/dev — 계정 생성(upsert) + 계정 세션 토큰", () => {
  it("신규 sub → 계정 생성, acct:1 세션 토큰, 결정적 playerId, auth_identities/users 행 생성", async () => {
    const sub = "sub-new-" + crypto.randomUUID();
    const res = await authDev({ sub, name: "HeroPlayer" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthRes;

    expect(body.acct).toBe(true);
    expect(body.playerId).toBe(await expectedPid(sub));
    expect(body.nickname).toBe("HeroPlayer"); // 정제 결과(형식 유효 → 그대로).

    // 계정 세션 토큰은 acct:1로 검증된다.
    const verified = await verifyToken(body.token, env.SESSION_HMAC_SECRET, SessionPayloadSchema);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.pid).toBe(body.playerId);
      expect(verified.payload.acct).toBe(1);
    }

    // DB 부수효과. nickname_norm은 표시명이 아니라 user_id 기반(`u#${userId}`) — 구조적으로 항상
    // 유일하다(WT-FIX-GOOGLENAME).
    const user = await selectUser(body.playerId);
    expect(user?.status).toBe("active");
    expect(user?.nickname).toBe("HeroPlayer");
    expect(user?.nickname_norm).toBe(`u#${body.playerId}`);
    const ident = await selectIdentity(sub);
    expect(ident?.user_id).toBe(body.playerId);
    expect(ident?.provider).toBe("google");
  });

  it("같은 sub 재로그인 + 동일 Google 이름 → no-op(닉네임·updated_at 불변, users 행 1개, last_login만 갱신)", async () => {
    const sub = "sub-idem-" + crypto.randomUUID();
    const first = (await (await authDev({ sub, name: "FirstName" })).json()) as AuthRes;
    const firstIdent = await selectIdentity(sub);
    const firstUser = await selectUser(first.playerId);

    const second = (await (await authDev({ sub, name: "FirstName" })).json()) as AuthRes;

    expect(second.playerId).toBe(first.playerId);
    expect(second.nickname).toBe("FirstName");

    // users 행은 하나뿐(재생성 없음). 이름이 그대로라 resyncAccountNickname이 UPDATE를 스킵한다
    // (불필요 쓰기 없음 — updated_at 불변으로 확인).
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE user_id = ?1`)
      .bind(first.playerId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const secondUser = await selectUser(first.playerId);
    expect(secondUser?.updated_at).toBe(firstUser?.updated_at);
    expect(secondUser?.nickname_norm).toBe(`u#${first.playerId}`);

    // auth_identities.last_login은 매 로그인 갱신(>= 최초).
    const secondIdent = await selectIdentity(sub);
    expect(secondIdent?.last_login).toBeGreaterThanOrEqual(firstIdent?.last_login ?? 0);
  });

  it("같은 sub 재로그인 + Google 이름 변경 → 닉네임 자동 재동기화(더 이상 보존하지 않음), users 행 1개 유지", async () => {
    // WT-FIX-GOOGLENAME §11 후속: 과거엔 유저 커스터마이즈 보호를 이유로 재로그인 시 기존 닉네임을
    // 보존했으나(구 설계), 계정 표시명이 실명 정책으로 바뀌면서 "Google 이름을 그대로 쓴다"가
    // 최우선이 됐다 — 이름이 바뀌면 다음 로그인에 즉시 반영한다.
    const sub = "sub-resync-" + crypto.randomUUID();
    const first = (await (await authDev({ sub, name: "FirstName" })).json()) as AuthRes;

    const second = (await (await authDev({ sub, name: "ChangedName" })).json()) as AuthRes;

    expect(second.playerId).toBe(first.playerId);
    expect(second.nickname).toBe("ChangedName");

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE user_id = ?1`)
      .bind(first.playerId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const user = await selectUser(first.playerId);
    expect(user?.nickname).toBe("ChangedName");
    expect(user?.nickname_norm).toBe(`u#${first.playerId}`); // 재동기화 후에도 user_id 기반 유지.

    const secondIdent = await selectIdentity(sub);
    expect(secondIdent?.name).toBe("ChangedName");
  });

  it("레거시 USER_xxxx 강등 계정(구 버그 시뮬레이션) → 재로그인 한 번으로 원래 Google 이름으로 자동 치유", async () => {
    // 버그 재현: 구 코드는 nickname_norm UNIQUE 충돌 시 USER_xxxx로 강등했다. 그 결과물을 직접
    // INSERT로 심어(현재 코드는 더 이상 이 상태를 만들지 않으므로 API로는 재현 불가) 회귀를 막는다.
    const sub = "sub-heal-" + crypto.randomUUID();
    const pid = await expectedPid(sub);
    const deviceHash = await deriveDeviceHash(env.SESSION_HMAC_SECRET, "google:" + sub);
    const seededAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(pid, deviceHash, "USER_OCGF", "user_ocgf", seededAt)
      .run();

    const relogin = (await (await authDev({ sub, name: "OriginalName" })).json()) as AuthRes;

    expect(relogin.playerId).toBe(pid);
    expect(relogin.nickname).toBe("OriginalName");
    const user = await selectUser(pid);
    expect(user?.nickname).toBe("OriginalName");
    expect(user?.nickname_norm).toBe(`u#${pid}`);
  });

  it("닉네임 중복(같은 Google 표시명, 다른 sub) → 두 계정 모두 같은 표시명 유지, nickname_norm은 서로 다름(user_id 기반)", async () => {
    // 과거엔 두 번째 계정이 USER_xxxx로 강등됐다. 이제 표시명 중복은 전역 허용이다.
    const uniq = crypto.randomUUID().slice(0, 6);
    const name = `Clash${uniq}`;
    const a = (await (await authDev({ sub: "clash-a-" + uniq, name })).json()) as AuthRes;
    const b = (await (await authDev({ sub: "clash-b-" + uniq, name })).json()) as AuthRes;

    expect(a.playerId).not.toBe(b.playerId);
    expect(a.nickname).toBe(name);
    expect(b.nickname).toBe(name); // 강등 없음 — 둘 다 동일 표시명.

    const userA = await selectUser(a.playerId);
    const userB = await selectUser(b.playerId);
    expect(userA?.nickname_norm).toBe(`u#${a.playerId}`);
    expect(userB?.nickname_norm).toBe(`u#${b.playerId}`);
    expect(userA?.nickname_norm).not.toBe(userB?.nickname_norm);
  });

  it("email은 검증(dev 심에서 email 제공 시)된 경우만 저장, 미제공이면 NULL", async () => {
    const subWith = "sub-email-" + crypto.randomUUID();
    const withEmail = (await (await authDev({ sub: subWith, name: "MailUser", email: "mail@ex.com" })).json()) as AuthRes;
    expect(withEmail.email).toBe("mail@ex.com");
    expect((await selectIdentity(subWith))?.email).toBe("mail@ex.com");

    const subNo = "sub-noemail-" + crypto.randomUUID();
    const noEmail = (await (await authDev({ sub: subNo, name: "NoMail" })).json()) as AuthRes;
    expect(noEmail.email).toBeUndefined();
    expect((await selectIdentity(subNo))?.email).toBeNull();
  });

  it("표시명 미제공 → 상수 'PLAYER'로 폴백(랜덤 접미사 없음)", async () => {
    const sub = "sub-noname-" + crypto.randomUUID();
    const res = await authDev({ sub }); // name 필드 자체를 생략.
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthRes;
    expect(body.nickname).toBe("PLAYER");
  });

  it("표시명이 이모지 등으로만 구성돼 정제 후 빈 문자열이면 'PLAYER'로 폴백(더 이상 USER_xxxx 아님)", async () => {
    const sub = "sub-emoji-" + crypto.randomUUID();
    const res = await authDev({ sub, name: "🎮🎮🎮" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthRes;
    expect(body.nickname).toBe("PLAYER");
  });

  it("한글/라틴이 아닌 스크립트(일본어·키릴) 표시명도 그대로 보존된다(NICK_RE 검사 제거)", async () => {
    const subJa = "sub-ja-" + crypto.randomUUID();
    const ja = (await (await authDev({ sub: subJa, name: "田中太郎" })).json()) as AuthRes;
    expect(ja.nickname).toBe("田中太郎");

    const subRu = "sub-ru-" + crypto.randomUUID();
    const ru = (await (await authDev({ sub: subRu, name: "Иван Петров" })).json()) as AuthRes;
    expect(ru.nickname).toBe("Иван Петров");
  });

  it("12 코드포인트를 초과하는 표시명은 12자로 클램프된다", async () => {
    const sub = "sub-long-" + crypto.randomUUID();
    const res = await authDev({ sub, name: "ABCDEFGHIJKLMNOP" }); // 16자.
    const body = (await res.json()) as AuthRes;
    expect(body.nickname).toBe("ABCDEFGHIJKL");
    expect(Array.from(body.nickname).length).toBe(12);
  });
});

// ───────── WT-AUTH-REDIRECT: GIS ux_mode:'redirect' 전체 페이지 이동 로그인 ─────────
//
// /auth/dev와 달리 이 경로는 **실 credential 검증기를 그대로 통과**해야 한다(그게 이 경로의
// 핵심이다). 로컬 RSA 키쌍으로 JWT를 서명하고 그 공개키를 KV `auth:google:jwks`에 미리 심어
// 두면 google-idtoken이 캐시 히트로 검증을 끝내므로 실 네트워크 없이 전 구간이 돈다
// (src/lib/google-idtoken.test.ts의 목 JWKS 기법을 pool-workers 통합으로 옮긴 것).

const KID = "redirect-test-key";
const ISS = "https://accounts.google.com";
const CSRF = "csrf-abc-123";
const AUTHCODE_RE = /^\/\?authcode=([0-9a-f]{32})$/;

interface ExchangeRes {
  token: string;
  user: {
    playerId: string;
    nickname: string;
    expiresAt: string;
    geo: string;
    acct: true;
    email?: string;
    name?: string;
    picture?: string;
  };
}

let redirectKeys: CryptoKeyPair | null = null;

async function ensureKeyPair(): Promise<CryptoKeyPair> {
  redirectKeys ??= (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return redirectKeys;
}

/** 로컬 공개키를 KV JWKS 캐시에 심는다(isolatedStorage라 테스트마다 다시 필요). */
async function seedJwks(): Promise<void> {
  const { publicKey } = await ensureKeyPair();
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  await env.KV.put(
    KV_KEYS.authGoogleJwks,
    JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] }),
  );
}

function b64urlJson(obj: unknown): string {
  return bytesToBase64url(utf8ToBytes(JSON.stringify(obj)));
}

async function makeCredential(overrides: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = await ensureKeyPair();
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = b64urlJson({
    iss: ISS,
    aud: env.GOOGLE_CLIENT_ID,
    sub: "redir-sub-" + crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "redir@example.com",
    email_verified: true,
    name: "RedirUser",
    picture: "https://lh3.googleusercontent.com/redir-avatar",
    ...overrides,
  });
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, utf8ToBytes(signingInput));
  return `${signingInput}.${bytesToBase64url(new Uint8Array(sig))}`;
}

function postRedirect(fields: Record<string, string>, cookieCsrf?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookieCsrf !== undefined) headers.Cookie = `g_csrf_token=${cookieCsrf}`;
  return SELF.fetch(`${BASE}/auth/google/redirect`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
    // 302를 따라가면 SPA 자산 폴백까지 흘러가 Location 검증이 불가능해진다.
    redirect: "manual",
  });
}

function postExchange(code: string): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/google/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("POST /auth/google/redirect — GIS ux_mode:'redirect' 폼 POST 착지점", () => {
  beforeEach(async () => {
    await seedJwks();
  });

  it("정상 credential + CSRF 일치 → 302 /?authcode={32hex}, 토큰은 URL에 실리지 않는다", async () => {
    const credential = await makeCredential();
    const res = await postRedirect({ credential, g_csrf_token: CSRF }, CSRF);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(AUTHCODE_RE);
    // 세션 토큰(wt1)이 URL에 새어나가지 않는다 — 코드만 실린다.
    expect(location).not.toContain("wt1");

    // 코드 자체는 KV에만 존재한다.
    const code = AUTHCODE_RE.exec(location)?.[1] ?? "";
    expect(await env.KV.get(KV_KEYS.authCode(code))).not.toBeNull();
  });

  it("발급된 코드는 exchange로 정확히 1회만 계정 세션이 된다(재사용은 401)", async () => {
    const credential = await makeCredential();
    const redirected = await postRedirect({ credential, g_csrf_token: CSRF }, CSRF);
    const code = AUTHCODE_RE.exec(redirected.headers.get("Location") ?? "")?.[1] ?? "";
    expect(code).toHaveLength(32);

    const first = await postExchange(code);
    expect(first.status).toBe(200);
    const body = (await first.json()) as ExchangeRes;

    // /auth/google(JSON 경로)과 완전히 같은 계정 세션 — acct:1 토큰 + 동일 upsert 산출물.
    expect(body.user.acct).toBe(true);
    expect(body.user.nickname).toBe("RedirUser");
    expect(body.user.email).toBe("redir@example.com");
    // redirect 모드는 클라가 credential을 못 보므로 표시 프로필을 서버가 실어 준다.
    expect(body.user.name).toBe("RedirUser");
    expect(body.user.picture).toBe("https://lh3.googleusercontent.com/redir-avatar");

    const verified = await verifyToken(body.token, env.SESSION_HMAC_SECRET, SessionPayloadSchema);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.pid).toBe(body.user.playerId);
      expect(verified.payload.acct).toBe(1);
    }
    expect((await selectUser(body.user.playerId))?.status).toBe("active");

    // 단일 사용 — 두 번째 교환은 401(KV에서 이미 소각).
    const second = await postExchange(code);
    expect(second.status).toBe(401);
    expect(await env.KV.get(KV_KEYS.authCode(code))).toBeNull();
  });

  it("CSRF 실패(불일치·쿠키 부재·바디 토큰 부재) → 302 /?authError=1 (JSON 400 아님, 계정 생성 없음)", async () => {
    // 리드 확정: 전체 페이지 이동 중인 사용자에게 JSON 400은 막다른 골목이라 credential 검증
    // 실패와 동일하게 SPA 로그인 모달로 되돌린다. 인증 자체는 여전히 거부된다(계정 미생성).
    const sub = "csrf-reject-" + crypto.randomUUID();
    const credential = await makeCredential({ sub });

    const mismatched = await postRedirect({ credential, g_csrf_token: CSRF }, "other-value");
    expect(mismatched.status).toBe(302);
    expect(mismatched.headers.get("Location")).toBe("/?authError=1");

    const noCookie = await postRedirect({ credential, g_csrf_token: CSRF });
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.get("Location")).toBe("/?authError=1");

    const noBodyToken = await postRedirect({ credential }, CSRF);
    expect(noBodyToken.status).toBe(302);
    expect(noBodyToken.headers.get("Location")).toBe("/?authError=1");

    // 세 경우 모두 credential 검증까지 가지 않았다 — 계정도, 교환 코드도 만들어지지 않는다.
    expect(await selectUser(await expectedPid(sub))).toBeNull();
    expect((await env.KV.list({ prefix: "authcode:" })).keys).toHaveLength(0);
  });

  it("검증 실패 credential(서명 변조) → 302 /?authError=1 (500/400 아님, 계정 생성 없음)", async () => {
    const credential = await makeCredential();
    // 페이로드만 바꿔치기 → 서명 불일치. sub도 바뀌므로 그 pid의 계정 부재를 함께 확인한다.
    const tamperedSub = "tampered-" + crypto.randomUUID();
    const parts = credential.split(".");
    parts[1] = b64urlJson({
      iss: ISS,
      aud: env.GOOGLE_CLIENT_ID,
      sub: tamperedSub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await postRedirect({ credential: parts.join("."), g_csrf_token: CSRF }, CSRF);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=1");
    expect(await selectUser(await expectedPid(tamperedSub))).toBeNull();
  });
});

describe("POST /auth/google/exchange — 1회용 코드 교환", () => {
  it("존재하지 않는(=만료된) 코드 → 401", async () => {
    // TTL 60s는 테스트에서 기다릴 수 없다 — 만료 후 상태(KV get null)와 완전히 같은 경로를 탄다.
    const res = await postExchange("0123456789abcdef0123456789abcdef");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CODE");
  });

  it("TTL 만료로 KV에서 사라진 코드 → 401", async () => {
    const code = "deadbeefdeadbeefdeadbeefdeadbeef";
    await env.KV.put(KV_KEYS.authCode(code), JSON.stringify({ token: "t", user: {} }));
    await env.KV.delete(KV_KEYS.authCode(code)); // 만료 시뮬레이션.
    expect((await postExchange(code)).status).toBe(401);
  });

  it("형식이 어긋난 code → 400", async () => {
    expect((await postExchange("not-a-code")).status).toBe(400);
  });
});

describe("DELETE /users/me — 계정 삭제 시 auth_identities도 제거(삭제권)", () => {
  it("계정 삭제 후 auth_identities 행이 사라지고, 재로그인하면 계정이 초기화 복원된다", async () => {
    const sub = "sub-del-" + crypto.randomUUID();
    const created = (await (await authDev({ sub, name: "ToDelete" })).json()) as AuthRes;
    expect(await selectIdentity(sub)).not.toBeNull();

    const del = await SELF.fetch(`${BASE}/users/me`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(del.status).toBe(200);

    // auth_identities 행 삭제 + users.status='deleted'.
    expect(await selectIdentity(sub)).toBeNull();
    expect((await selectUser(created.playerId))?.status).toBe("deleted");

    // 같은 sub로 재로그인 → 같은 user_id를 활성으로 복원 + auth_identities 재생성.
    const relogin = (await (await authDev({ sub, name: "Reborn" })).json()) as AuthRes;
    expect(relogin.playerId).toBe(created.playerId);
    expect((await selectUser(created.playerId))?.status).toBe("active");
    expect(await selectIdentity(sub)).not.toBeNull();
  });
});
