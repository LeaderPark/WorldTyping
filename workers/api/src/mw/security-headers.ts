// spec: docs/04 §10.1(보안 헤더) + docs/06 §9.4(/r/*는 X-Frame-Options 미적용·프레임 임베드 허용,
//       게임 본체 라우트는 frame-ancestors 'self' CSP 유지 — 클릭재킹 방지) + WT-M0-02 지시 4 + WT-M6-02
// docs/04 §10.1 원문은 connect-src에 실 도메인(worldtyping.gg)을 하드코딩하지만,
// 도메인은 아직 미확정이고 PUBLIC_ORIGIN 변수로만 다뤄야 한다(docs/00 §7 gotcha 7).
// 그래서 connect-src는 'self' + wss: 'self' 원칙으로 둔다 — 오리진을 코드에 박지 않는다.
// 정적 응답을 포함한 전 응답에 적용한다(app.use('*', securityHeaders)).
//
// frame-ancestors(§9.4): 게임 본체는 'self'(동일 오리진 임베드만 — 클릭재킹 방지). 단 결과 공유
// 랜딩 /r/*는 블로그/SNS iframe 삽입을 자연 허용해야 바이럴이 산다 — 이 경로만 frame-ancestors와
// X-Frame-Options를 통째로 생략한다. (WT-M6-02 이전 코드는 전 경로 'none'이었다 — §9.4로 정정.)

import type { MiddlewareHandler } from "hono";

/** 게임 본체(기본) CSP — frame-ancestors 'self'(§9.4). */
const CSP_BASE = [
  "default-src 'self'",
  "connect-src 'self' wss:",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** /r/* 공유 랜딩 CSP — frame-ancestors 미포함(임베드 허용, §9.4). */
const CSP_EMBEDDABLE = [
  "default-src 'self'",
  "connect-src 'self' wss:",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
].join("; ");

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  // WebSocket 업그레이드(/ws/room/:code — WT-M4-02) 응답(101)은 헤더가 불변이라 set 시 throw한다.
  // 응답 status가 아니라 요청 Upgrade 헤더로 판정한다(101 응답은 Hono 레이어에서 헤더 접근 자체가
  // 불변이라 status 검사 전에 걸린다). 업그레이드 요청 경로는 보안 헤더 부착을 통째로 건너뛴다.
  const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
  await next();
  if (isUpgrade) return;
  // /r/* 공유 랜딩만 임베드 허용(X-Frame-Options 미적용 + frame-ancestors 생략, §9.4).
  const embeddable = c.req.path.startsWith("/r/");
  c.res.headers.set("Content-Security-Policy", embeddable ? CSP_EMBEDDABLE : CSP_BASE);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
};
