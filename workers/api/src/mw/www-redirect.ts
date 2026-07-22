// spec: docs/04 §7(wrangler.toml routes 주석 "www → apex 301"), docs/06 §10-1(도메인/SSL —
//       apex/www 리다이렉트), docs/00 §7 gotcha 7(오리진 하드코딩 금지), WT-M6-06
//
// www 서브도메인 요청을 apex(루트 도메인)로 301 리다이렉트한다. 어떤 실 도메인이 최종 배정되든
// (§11-D18, Q1 미결) 동일하게 동작해야 하므로 특정 문자열을 하드코딩하지 않는다 — 요청 자체의
// Host에서 "www." 접두사만 구조적으로 제거해 목적지를 만든다. www가 아닌 요청은 통과시킨다.
import type { MiddlewareHandler } from "hono";

export const wwwToApexRedirect: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.toLowerCase().startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    return c.redirect(url.toString(), 301);
  }
  await next();
};
