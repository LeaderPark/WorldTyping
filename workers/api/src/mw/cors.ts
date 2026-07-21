// spec: docs/04 §7(CORS: 동일 오리진 설계, dev localhost:5173 + staging 도메인만 예외) + WT-M0-02 지시 4
// prod는 동일 오리진(SPA+API가 한 Worker)이라 CORS 자체가 불필요 — 아래는 dev/staging 전용 예외.
// /api/* 에만 적용한다(index.ts에서 app.use('/api/*', corsMiddleware)).

import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

const DEV_ORIGIN = "http://localhost:5173";
const ALLOW_HEADERS = "Authorization, Content-Type";
const MAX_AGE = "86400";

export const corsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header("Origin");
  const env = c.env.ENVIRONMENT ?? "dev";

  const allowedOrigin = resolveAllowedOrigin(env, origin);

  if (allowedOrigin) {
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Max-Age", MAX_AGE);
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
};

function resolveAllowedOrigin(env: Env["ENVIRONMENT"], origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  // dev: wrangler dev 로컬 Vite(5173)만 반사 (ENVIRONMENT==='dev'일 때만, docs/04 §7)
  if (env === "dev" && origin === DEV_ORIGIN) return origin;
  // staging: staging 도메인(하드코딩 금지 — PUBLIC_ORIGIN 계열 호스트명 패턴만 허용)
  if (env === "staging" && /^https:\/\/staging\./.test(origin)) return origin;
  return undefined;
}
