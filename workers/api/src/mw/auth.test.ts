// spec: WT-AUTH-01 acceptance — requireAccountAuth(계정 세션 게이트). requireAuth의 acct 세팅 포함.
//
// 순수 node vitest — D1/KV 불필요(토큰 서명/검증만). 미니 Hono 앱에 두 미들웨어를 얹어 검증한다
// (프로덕션 라우트를 건드리지 않고 미들웨어 자체를 격리 테스트 — 계정 게이팅 라우트는 W2 소관).
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { signAccountSessionToken, signSessionToken } from "@wt/shared";
import { requireAccountAuth, requireAuth, type AuthVariables } from "./auth";
import { apiErrorHandler } from "../lib/api-error";
import type { Env } from "../env";

const SECRET = "test-session-secret-for-mw-auth";
const PID = "PlayerPid1234";
const NOW = 1_800_000_000_000;

// SESSION_HMAC_SECRET만 실제로 쓰인다(verifyToken). 나머지는 미사용이라 얕은 캐스팅.
const env = { SESSION_HMAC_SECRET: SECRET } as unknown as Env;

function makeApp() {
  // index.ts와 동일 합성: onError는 Variables 없는 상위 앱, 라우트는 AuthVariables 하위 앱에 두고
  // app.route로 마운트한다(ErrorHandler 제네릭 불변성 회피 — 캐스팅 불필요).
  const app = new Hono<{ Bindings: Env }>();
  app.onError(apiErrorHandler);
  const sub = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  sub.get("/plain", requireAuth, (c) => c.json({ pid: c.get("pid"), acct: c.get("acct") }));
  sub.get("/account", requireAccountAuth, (c) => c.json({ pid: c.get("pid"), acct: c.get("acct") }));
  app.route("/", sub);
  return app;
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe("requireAuth — acct 클레임 반영", () => {
  it("게스트 세션 토큰이면 acct=false로 통과", async () => {
    const app = makeApp();
    const token = await signSessionToken(SECRET, PID, NOW);
    const res = await app.request("/plain", bearer(token), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pid: string; acct: boolean };
    expect(body.pid).toBe(PID);
    expect(body.acct).toBe(false);
  });

  it("계정 세션 토큰(acct:1)이면 acct=true로 통과", async () => {
    const app = makeApp();
    const token = await signAccountSessionToken(SECRET, PID, NOW);
    const res = await app.request("/plain", bearer(token), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acct: boolean };
    expect(body.acct).toBe(true);
  });

  it("토큰 없음 → 401 INVALID_TOKEN", async () => {
    const app = makeApp();
    const res = await app.request("/plain", {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("requireAccountAuth — 계정 세션 전용 게이트", () => {
  it("계정 세션 토큰(acct:1)이면 200", async () => {
    const app = makeApp();
    const token = await signAccountSessionToken(SECRET, PID, NOW);
    const res = await app.request("/account", bearer(token), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pid: string; acct: boolean };
    expect(body.pid).toBe(PID);
    expect(body.acct).toBe(true);
  });

  it("게스트 세션 토큰(유효하지만 acct 아님) → 401 LOGIN_REQUIRED", async () => {
    const app = makeApp();
    const token = await signSessionToken(SECRET, PID, NOW);
    const res = await app.request("/account", bearer(token), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("LOGIN_REQUIRED");
  });

  it("토큰 없음 → 401 INVALID_TOKEN(게스트 거부 코드와 구별)", async () => {
    const app = makeApp();
    const res = await app.request("/account", {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TOKEN");
  });

  it("변조/무효 토큰 → 401 INVALID_TOKEN", async () => {
    const app = makeApp();
    const res = await app.request("/account", bearer("wt1.garbage.sig"), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TOKEN");
  });
});
