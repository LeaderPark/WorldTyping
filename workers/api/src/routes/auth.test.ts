// spec: WT-AUTH-01 acceptance — auth 라우트의 dev 심 prod 404 + 입력 검증 + Google 검증 실패 401.
//
// 순수 node vitest(cloudflare:test 아님). D1이 없는 게이트/검증 경로만 여기서 검증한다. 실제 DB
// upsert(신규/재로그인 멱등·닉네임 충돌)는 pool-workers 통합 테스트(test/auth.test.ts)가 담당한다.
// 미니 Hono 앱에 auth 라우트를 얹고 env를 요청별로 주입한다(index.test.ts makeEnv 선례).
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { auth } from "./auth";
import { apiErrorHandler } from "../lib/api-error";
import type { Env } from "../env";

const BASE = "http://local/api/v1";
const CLIENT_ID = "615582111042-test.apps.googleusercontent.com";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: undefined as unknown as Env["ASSETS"],
    DB: undefined as unknown as Env["DB"],
    KV: undefined as unknown as Env["KV"],
    BUCKET: undefined as unknown as Env["BUCKET"],
    EVENTS: undefined as unknown as Env["EVENTS"],
    AE: undefined as unknown as Env["AE"],
    MATCH_ROOM: undefined as unknown as Env["MATCH_ROOM"],
    MATCHMAKER: undefined as unknown as Env["MATCHMAKER"],
    SESSION_HMAC_SECRET: "test-secret",
    RUN_HMAC_SECRET: "test-secret",
    DAILY_SALT: "test-salt",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ENVIRONMENT: "dev",
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(apiErrorHandler);
  app.route("/api/v1", auth);
  return app;
}

async function postJson(path: string, body: unknown, env: Env): Promise<Response> {
  return makeApp().request(
    `${BASE}${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

describe("POST /auth/dev — dev 전용 테스트 심 게이팅(§11-D68-⑩)", () => {
  it("ENVIRONMENT='prod'이면 404(라우트 부재 취급) — DB 접근 이전에 차단", async () => {
    const res = await postJson("/auth/dev", { sub: "x" }, makeEnv({ ENVIRONMENT: "prod" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ENVIRONMENT='staging'이어도 404", async () => {
    const res = await postJson("/auth/dev", { sub: "x" }, makeEnv({ ENVIRONMENT: "staging" }));
    expect(res.status).toBe(404);
  });

  it("ENVIRONMENT='dev'면 게이트 통과(그 뒤 DB 미바인딩이라 503) — 404가 아님을 확인", async () => {
    // DB 미바인딩(makeEnv 기본) → 게이트를 지난 뒤 503. 404가 아니라는 것이 dev 활성의 증거.
    const res = await postJson("/auth/dev", { sub: "x" }, makeEnv({ ENVIRONMENT: "dev" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("dev인데 sub 누락 → 400 INVALID_BODY (DB 있음 가정)", async () => {
    const res = await postJson("/auth/dev", { name: "no sub" }, makeEnv({ DB: {} as Env["DB"] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });
});

describe("POST /auth/google — 입력 검증 + Google 검증 실패", () => {
  it("credential 누락 → 400 INVALID_BODY", async () => {
    const res = await postJson("/auth/google", {}, makeEnv({ DB: {} as Env["DB"] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });

  it("초과 필드 → zod .strict() 400", async () => {
    const res = await postJson(
      "/auth/google",
      { credential: "a.b.c", extra: "nope" },
      makeEnv({ DB: {} as Env["DB"] }),
    );
    expect(res.status).toBe(400);
  });

  it("GOOGLE_CLIENT_ID 미설정 → 503(계정 로그인 비활성)", async () => {
    const res = await postJson(
      "/auth/google",
      { credential: "a.b.c" },
      makeEnv({ DB: {} as Env["DB"], GOOGLE_CLIENT_ID: undefined }),
    );
    expect(res.status).toBe(503);
  });

  it("형식이 깨진 credential → 401 INVALID_TOKEN(JWT 파싱 실패, 네트워크 없음)", async () => {
    // 2분절이라 verifyGoogleIdToken이 JWKS fetch 이전에 malformed로 실패한다 → 라우트 401.
    // fetch를 감시해 네트워크가 실제로 발생하지 않음을 함께 단언한다.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await postJson(
        "/auth/google",
        { credential: "onlytwo.segments" },
        makeEnv({ DB: {} as Env["DB"] }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_TOKEN");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
