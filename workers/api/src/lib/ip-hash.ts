// spec: docs/04 §6.5("IP는 CF-Connecting-IP의 SHA-256 해시만") + §10.3(남용 방지) + WT-M3-02
//
// 요청 IP 원문은 어디에도 저장하지 않는다 — 항상 이 해시를 거쳐서만 KV 키/카운터에 쓴다.
import type { Context } from "hono";

/** CF-Connecting-IP 헤더가 없는 로컬 개발(wrangler dev 로컬 curl 등) 폴백 값. */
const UNKNOWN_IP = "unknown";

export function getClientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP") ?? UNKNOWN_IP;
}

/** SHA-256(ip) → 소문자 hex 64자. WebCrypto만 사용(Node Buffer 금지 — Workers 런타임 호환). */
export async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 요청 국가(alpha-2). `CF-IPCountry` 헤더를 우선 신뢰하고, 없으면 `cf.country`로 폴백한다
 * (§11-D61 — self-host/miniflare처럼 `cf` 객체가 비어 있는 환경에서도 리버스 프록시가 세팅한
 * `CF-IPCountry` 헤더만으로 geo를 얻을 수 있게 한다). 'T1'(Tor exit) / 'XX'(알 수 없음)는 두
 * 경로 동일하게 NULL 처리(docs/06 §1.3 주석).
 */
export function getGeoCountry(c: Context): string | null {
  const headerCountry = c.req.header("CF-IPCountry");
  const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
  const country = headerCountry ?? cf?.country;
  if (!country || country === "T1" || country === "XX") return null;
  return country;
}
