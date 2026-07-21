// spec: docs/06 §4.2(닉네임 규칙·필터 파이프라인 전문), docs/04 §2.3-8/9(reason vocabulary),
//       docs/00 §11-D14(06 승: 2~12자·30일당 2회), docs/07 WT-M3-05 [구현 세부 지시 3·4]·
//       [완료 조건] — 닉네임 경계(중복/금칙어/횟수 초과).
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://local/api/v1";

interface CheckRes {
  ok: boolean;
  reason?: string;
}

async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

function check(token: string, nick: string): Promise<Response> {
  return SELF.fetch(`${BASE}/nickname/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nickname: nick }),
  });
}

function put(token: string, nick: string): Promise<Response> {
  return SELF.fetch(`${BASE}/nickname`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nickname: nick }),
  });
}

describe("POST /api/v1/nickname/check", () => {
  it("401 without a session bearer token", async () => {
    const res = await check("garbage", "김치워리어");
    expect(res.status).toBe(401);
  });

  it("ok:true for a clean, available nickname", async () => {
    const { token } = await bootstrap();
    const res = await check(token, `클린닉${crypto.randomUUID().slice(0, 4)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckRes;
    expect(body.ok).toBe(true);
    expect(body.reason).toBeUndefined();
  });

  it("rejects a 1-character nickname as TOO_SHORT (below minimum length 2)", async () => {
    const { token } = await bootstrap();
    const res = await check(token, "김");
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "TOO_SHORT" });
  });

  it("accepts a 12-character nickname (at the maximum length)", async () => {
    const { token } = await bootstrap();
    const res = await check(token, `kimchi${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`);
    const body = (await res.json()) as CheckRes;
    expect(body.ok).toBe(true);
  });

  it("rejects a 13-character nickname as TOO_LONG", async () => {
    const { token } = await bootstrap();
    const res = await check(token, "kimchi1234567"); // 13자
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("rejects invalid characters (symbol) as INVALID_CHARS", async () => {
    const { token } = await bootstrap();
    const res = await check(token, "kim!lee");
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "INVALID_CHARS" });
  });

  it("rejects a reserved prefix as RESERVED", async () => {
    const { token } = await bootstrap();
    const res = await check(token, "admin_ops");
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "RESERVED" });
  });

  it("rejects a badword-containing nickname as BLOCKED_WORD", async () => {
    const { token } = await bootstrap();
    const res = await check(token, "시발러버12");
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "BLOCKED_WORD" });
  });

  it("rejects a nickname already taken by another user as TAKEN", async () => {
    const owner = await bootstrap();
    const nick = `타겟닉${crypto.randomUUID().slice(0, 4)}`;
    const putRes = await put(owner.token, nick);
    expect(putRes.status).toBe(200);

    const other = await bootstrap();
    const res = await check(other.token, nick);
    const body = (await res.json()) as CheckRes;
    expect(body).toEqual({ ok: false, reason: "TAKEN" });
  });

  it("does not flag the requester's own current nickname as TAKEN", async () => {
    const { token, pid } = await bootstrap();
    const nick = `본인닉${crypto.randomUUID().slice(0, 4)}`;
    await put(token, nick);
    const res = await check(token, nick);
    const body = (await res.json()) as CheckRes;
    expect(body.ok).toBe(true);
    expect(pid).toHaveLength(12);
  });
});

describe("PUT /api/v1/nickname", () => {
  it("401 without a session bearer token", async () => {
    const res = await put("garbage", "김치워리어");
    expect(res.status).toBe(401);
  });

  it("400 NICKNAME_REJECTED for a format/content violation", async () => {
    const { token } = await bootstrap();
    const res = await put(token, "admin_x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NICKNAME_REJECTED");
  });

  it("commits a valid nickname and persists it (nickname + nickname_norm) in D1", async () => {
    const { token, pid } = await bootstrap();
    const nick = `여행자${crypto.randomUUID().slice(0, 4)}`;
    const res = await put(token, nick);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nickname: string };
    expect(body.nickname).toBe(nick);

    const row = await env.DB.prepare(`SELECT nickname, nickname_norm FROM users WHERE user_id = ?1`)
      .bind(pid)
      .first<{ nickname: string; nickname_norm: string }>();
    expect(row?.nickname).toBe(nick);
    expect(row?.nickname_norm).toBe(nick.normalize("NFC").toLowerCase());
  });

  it("409 NICKNAME_TAKEN when another user already owns the normalized form", async () => {
    const owner = await bootstrap();
    const nick = `선점닉${crypto.randomUUID().slice(0, 4)}`;
    await put(owner.token, nick);

    const other = await bootstrap();
    const res = await put(other.token, nick);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NICKNAME_TAKEN");
  });

  it("re-confirming the identical current nickname is a no-op (does not consume the change policy budget)", async () => {
    const { token } = await bootstrap();
    const nick = `동일닉${crypto.randomUUID().slice(0, 4)}`;
    await put(token, nick);
    // 동일 닉네임으로 3회 더 PUT해도(정책 한도 2회를 넘는 횟수) 변경이 아니므로 전부 200이어야 한다.
    for (let i = 0; i < 3; i += 1) {
      const res = await put(token, nick);
      expect(res.status).toBe(200);
    }
  });

  it("429 NICKNAME_CHANGE_LIMIT after 2 real changes within the 30-day window (§11-D14)", async () => {
    const { token } = await bootstrap();
    const first = await put(token, `첫닉${crypto.randomUUID().slice(0, 4)}`);
    expect(first.status).toBe(200);
    const second = await put(token, `둘닉${crypto.randomUUID().slice(0, 4)}`);
    expect(second.status).toBe(200);

    const third = await put(token, `셋닉${crypto.randomUUID().slice(0, 4)}`);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NICKNAME_CHANGE_LIMIT");
  });
});
