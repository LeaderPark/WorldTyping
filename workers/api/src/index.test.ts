// spec: docs/04 §2.1(에러 포맷)·§2.4(Hono 골격) + WT-M0-02 [완료 조건]
// 순수 vitest(non-worker pool)로 Hono app.fetch 라우팅만 검증한다. DO/D1/KV 실 바인딩을
// 요구하는 통합 테스트(vitest-pool-workers)는 각 기능이 실제로 채워지는 마일스톤(M3/M4) 소관.
import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: vi.fn(async (req: Request) => new Response(`asset:${new URL(req.url).pathname}`)),
    } as unknown as Env["ASSETS"],
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
    ENVIRONMENT: "dev",
    ...overrides,
  };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe("@wt/api worker fetch", () => {
  it("GET /api/v1/health → 200 JSON with skipped checks when bindings absent", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/v1/health"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      ok: boolean;
      checks: { d1: { skipped?: boolean }; kv: { skipped?: boolean } };
    };
    expect(body.ok).toBe(true);
    expect(body.checks.d1.skipped).toBe(true);
    expect(body.checks.kv.skipped).toBe(true);
  });

  it("WT-M6-04: ?fault=d1 강제 실패 훅은 ENVIRONMENT='prod'에서는 무시된다(외부 조작 불가 가드)", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/v1/health?fault=d1"),
      makeEnv({ ENVIRONMENT: "prod" }),
      ctx,
    );
    // DB/KV/MATCH_ROOM 전부 undefined(makeEnv 기본값)라 fault 무시 여부와 무관하게 skipped=true로
    // ok:true가 나온다 — 가드 자체는 checks.d1.error에 "injected fault"가 없는 것으로 확인한다.
    const body = (await res.json()) as { checks: { d1: { error?: string } } };
    expect(body.checks.d1.error).toBeUndefined();
  });

  it("WT-M6-04: ?fault=d1은 ENVIRONMENT='dev'에서는 실제로 적용된다(대조군)", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/v1/health?fault=d1"),
      makeEnv({ ENVIRONMENT: "dev" }),
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { d1: { ok: boolean; error?: string } } };
    expect(body.checks.d1.ok).toBe(false);
    expect(body.checks.d1.error).toContain("injected fault");
  });

  it("GET /api/v1/unknown → 404 ApiError JSON", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/v1/unknown"), makeEnv(), ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });

  it("falls back to ASSETS.fetch for non-/api paths reaching the worker", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("http://localhost/some/spa/route"), env, ctx);
    expect(await res.text()).toBe("asset:/some/spa/route");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("applies security headers on every response", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/v1/health"), makeEnv(), ctx);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("reflects CORS origin only for dev localhost:5173 when ENVIRONMENT=dev", async () => {
    const req = new Request("http://localhost/api/v1/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    const res = await worker.fetch(req, makeEnv({ ENVIRONMENT: "dev" }), ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("does not reflect an untrusted origin", async () => {
    const req = new Request("http://localhost/api/v1/health", {
      headers: { Origin: "https://evil.example" },
    });
    const res = await worker.fetch(req, makeEnv({ ENVIRONMENT: "dev" }), ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
