// spec: WT-AUTH-01 acceptance — auth 라우트 DB 통합(신규/재로그인 upsert 멱등·닉네임 충돌·이메일
//       검증 저장·삭제권 정합). vitest-pool-workers(실 D1/KV 시뮬레이션) + 0005 마이그레이션.
//
// /auth/dev(dev 심)로 계정 세션을 발급받아 upsert 경로를 검증한다 — 실 Google 토큰을 만들 수 없어
// dev 심이 유일한 통합 진입점이다(§11-D68-⑩). /auth/google의 크립토 검증은 src/lib/google-idtoken
// .test.ts(node)가 담당하고, 여기서는 검증 이후 공유되는 upsert/토큰/DB 부수효과만 본다.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { derivePlayerId, SessionPayloadSchema, verifyToken } from "@wt/shared";
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

    // DB 부수효과.
    const user = await selectUser(body.playerId);
    expect(user?.status).toBe("active");
    expect(user?.nickname).toBe("HeroPlayer");
    const ident = await selectIdentity(sub);
    expect(ident?.user_id).toBe(body.playerId);
    expect(ident?.provider).toBe("google");
  });

  it("같은 sub 재로그인 → 멱등(같은 playerId·닉네임 보존, users 행 1개, last_login 갱신)", async () => {
    const sub = "sub-idem-" + crypto.randomUUID();
    const first = (await (await authDev({ sub, name: "FirstName" })).json()) as AuthRes;
    const firstIdent = await selectIdentity(sub);

    // 이름을 바꿔 다시 로그인 — 닉네임은 최초값을 보존해야 한다(유저 커스터마이즈 보호).
    const second = (await (await authDev({ sub, name: "ChangedName" })).json()) as AuthRes;

    expect(second.playerId).toBe(first.playerId);
    expect(second.nickname).toBe(first.nickname); // 보존(ChangedName으로 덮어쓰지 않음).

    // users 행은 하나뿐(재생성 없음).
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE user_id = ?1`)
      .bind(first.playerId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    // auth_identities.last_login 갱신(>= 최초). name은 최신값으로 갱신.
    const secondIdent = await selectIdentity(sub);
    expect(secondIdent?.last_login).toBeGreaterThanOrEqual(firstIdent?.last_login ?? 0);
    expect(secondIdent?.name).toBe("ChangedName");
  });

  it("닉네임 충돌(같은 표시명, 다른 sub) → 두 번째는 다른 닉네임으로 폴백", async () => {
    const uniq = crypto.randomUUID().slice(0, 6);
    const name = `Clash${uniq}`; // 11자 이내·NICK_RE 유효.
    const a = (await (await authDev({ sub: "clash-a-" + uniq, name })).json()) as AuthRes;
    const b = (await (await authDev({ sub: "clash-b-" + uniq, name })).json()) as AuthRes;

    expect(a.playerId).not.toBe(b.playerId);
    expect(a.nickname).toBe(name);
    expect(b.nickname).not.toBe(a.nickname); // USER_xxxx 폴백.
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

  it("표시명이 형식 부적합(이모지 등)이면 USER_xxxx로 폴백 생성", async () => {
    const sub = "sub-emoji-" + crypto.randomUUID();
    const res = await authDev({ sub, name: "🎮🎮🎮" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthRes;
    expect(body.nickname).toMatch(/^USER_[0-9A-Z]{4}$/);
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
