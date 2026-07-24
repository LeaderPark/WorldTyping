// spec: docs/04 §10.1(보안 헤더) + docs/06 §9.4(/r/*는 X-Frame-Options 미적용·프레임 임베드 허용,
//       게임 본체 라우트는 frame-ancestors 'self' CSP 유지 — 클릭재킹 방지) + docs/06 §10-1(HSTS
//       preload) + WT-M0-02 지시 4 + WT-M6-02 + WT-M6-06
// docs/04 §10.1 원문은 connect-src에 실 도메인 하드코딩 예시를 들지만(문서 내 예시 도메인은 §11-D18
// 확정에 따라 플레이스홀더로 읽는다), 도메인은 아직 미확정이고 PUBLIC_ORIGIN 변수로만 다뤄야
// 한다(docs/00 §7 gotcha 7). 그래서 connect-src는 'self' + wss: 'self' 원칙으로 둔다 — 오리진을
// 코드에 박지 않는다. 정적 응답을 포함한 전 응답에 적용한다(app.use('*', securityHeaders)).
//
// frame-ancestors(§9.4): 게임 본체는 'self'(동일 오리진 임베드만 — 클릭재킹 방지). 단 결과 공유
// 랜딩 /r/*는 블로그/SNS iframe 삽입을 자연 허용해야 바이럴이 산다 — 이 경로만 frame-ancestors와
// X-Frame-Options를 통째로 생략한다. (WT-M6-02 이전 코드는 전 경로 'none'이었다 — §9.4로 정정.)
//
// HSTS(WT-M6-06, docs/06 §10-1): max-age 2년 + includeSubDomains + preload — hstspreload.org
// 등재 최소 요건(1년 이상, 통상 2년 권장)을 코드로 항상 충족시켜 둔다. 브라우저는 HTTPS로 받은
// 응답에서만 이 헤더를 실제로 적용하므로(RFC 6797) 로컬 http(wrangler dev)에서 내려가도 무해하다.
// 목록 "제출" 자체(hstspreload.org 폼 제출)는 실 도메인 확정 후의 1회성 수동 절차라 코드가 할 수
// 없다 — 그 절차는 launch-checklist.md에 기재한다.

import type { MiddlewareHandler } from "hono";

// WT-AUTH-01(docs/00 §11-D68-⑤): 인증 채널은 "런타임 네트워크 없음"(02) 원칙의 명시적 예외다.
// GIS 클라이언트 스크립트/로그인 iframe/XHR은 accounts.google.com, 프로필 이미지는
// *.googleusercontent.com에서 온다 — 게임 본체 CSP(CSP_BASE)에만 이 오리진들을 허용한다(공유 랜딩
// /r/*의 CSP_EMBEDDABLE에는 로그인이 없어 추가하지 않는다).
const GOOGLE_ACCOUNTS = "https://accounts.google.com";
const GOOGLE_USERCONTENT = "https://*.googleusercontent.com";

/** 게임 본체(기본) CSP — frame-ancestors 'self'(§9.4) + Google 로그인 오리진(D68-⑤). */
const CSP_BASE = [
  "default-src 'self'",
  `connect-src 'self' wss: ${GOOGLE_ACCOUNTS}`,
  `img-src 'self' data: ${GOOGLE_USERCONTENT}`,
  `script-src 'self' ${GOOGLE_ACCOUNTS}`,
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  `frame-src ${GOOGLE_ACCOUNTS}`,
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
  c.res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
};
