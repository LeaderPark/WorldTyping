// spec: docs/04 §10.1(보안 헤더) + WT-M0-02 지시 4
// docs/04 §10.1 원문은 connect-src에 실 도메인(worldtyping.gg)을 하드코딩하지만,
// 도메인은 아직 미확정이고 PUBLIC_ORIGIN 변수로만 다뤄야 한다(docs/00 §7 gotcha 7).
// 그래서 connect-src는 'self' + wss: 'self' 원칙으로 둔다 — 오리진을 코드에 박지 않는다.
// 정적 응답을 포함한 전 응답에 적용한다(app.use('*', securityHeaders)).

import type { MiddlewareHandler } from "hono";

const CSP = [
  "default-src 'self'",
  "connect-src 'self' wss:",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Content-Security-Policy", CSP);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
};
