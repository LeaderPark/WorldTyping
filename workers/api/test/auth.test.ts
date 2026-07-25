// spec: WT-AUTH-01 acceptance — auth 라우트 DB 통합(신규/재로그인 upsert 멱등·이메일 검증 저장·
//       삭제권 정합) + WT-FIX-GOOGLENAME(§11 후속) — Google 표시명을 ID형 값(USER_xxxx) 없이 그대로
//       쓰고, nickname_norm을 `u#${userId}`로 고정해 표시명 중복을 전역 허용한다. vitest-pool-workers
//       (실 D1/KV 시뮬레이션) + 0005 마이그레이션.
//
// /auth/dev(dev 심)로 계정 세션을 발급받아 upsert 경로를 검증한다 — 실 Google 토큰을 만들 수 없어
// dev 심이 유일한 통합 진입점이다(§11-D68-⑩). /auth/google의 크립토 검증은 src/lib/google-idtoken
// .test.ts(node)가 담당하고, 여기서는 검증 이후 공유되는 upsert/토큰/DB 부수효과만 본다.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { derivePlayerId, deriveDeviceHash, SessionPayloadSchema, verifyToken } from "@wt/shared";
import type { AuthIdentityRow, UserRow } from "../src/db/types";

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
