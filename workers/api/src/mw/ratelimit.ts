// spec: docs/04 §6.5(레이트리밋 KV 고정윈도 — LIMITS 표 전문) + WT-M3-02
//
// KV 고정윈도(관대한 1차 방어). KV는 결과적 일관성이라 경계 오차를 허용한다 — 정밀 한도는
// 각 쓰기 엔드포인트의 D1/DO 검증(runToken 재사용 방지 등, docs/06 §3)이 담당한다.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { getClientIp, hashIp } from "../lib/ip-hash";

interface LimitRule {
  per: "ip" | "pid";
  window: number; // seconds
  max: number;
}

/** docs/04 §6.5 LIMITS 표 그대로. 키(scope 문자열)를 바꾸지 말 것 — rl:{scope}:... 로 그대로 쓰인다. */
export const LIMITS = {
  session: { per: "ip", window: 60, max: 10 },
  "runs/start": { per: "pid", window: 60, max: 10 },
  "runs/submit": { per: "pid", window: 60, max: 10 },
  nickname: { per: "pid", window: 3600, max: 5 },
  "rooms(create)": { per: "pid", window: 60, max: 5 },
  leaderboard: { per: "ip", window: 60, max: 60 },
} as const satisfies Record<string, LimitRule>;

export type RateLimitScope = keyof typeof LIMITS;

// Cloudflare Rate Limiting binding(RL) 훅 자리: 콜로 로컬·저지연 이중 방어(docs/04 §6.5 말미).
// v1 초반은 아래 KV 고정윈도만으로 충분 — 트래픽이 임계에 닿으면 여기서 `c.env.RL?.limit(...)`를
// 먼저 호출해 KV 쓰기 자체를 줄이는 형태로 확장한다(env.ts의 RL 바인딩은 이미 자리만 존재).

/**
 * scope에 해당하는 KV 고정윈도 미들웨어. per:'pid'는 requireAuth 이후에 붙여야
 * `c.get('pid')`가 채워져 있다 — 아직 pid가 없으면(비인증 라우트에 pid 스코프를 잘못 붙인 경우)
 * 방어적으로 'anon' 서브젝트로 묶는다(버그를 숨기지 않도록 별도 감지는 상위 라우트 리뷰 소관).
 */
export function rateLimit(
  scope: RateLimitScope,
): MiddlewareHandler<{ Bindings: Env; Variables: { pid?: string } }> {
  const rule = LIMITS[scope];

  return async (c, next) => {
    const kv = c.env.KV;
    // 로컬 개발 등 KV 미바인딩 시 관대하게 skip(health.ts와 동일한 톤 — WT-M0-02 패턴 계승).
    if (!kv) {
      await next();
      return;
    }

    const subject = rule.per === "pid" ? (c.get("pid") ?? "anon") : await hashIp(getClientIp(c));
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / rule.window) * rule.window;
    const key = KV_KEYS.rateLimit(scope, subject, windowStart);

    const raw = await kv.get(key);
    const count = raw ? Number(raw) : 0;

    if (count >= rule.max) {
      const retryAfterSec = Math.max(windowStart + rule.window - nowSec, 1);
      throw new ApiHttpError(429, "RATE_LIMITED", `Rate limit exceeded for scope '${scope}'`, retryAfterSec);
    }

    // TTL은 윈도보다 살짝 여유(+5s)를 둬 경계 근처 조회가 만료로 사라지는 것을 방지.
    await kv.put(key, String(count + 1), { expirationTtl: rule.window + 5 });
    await next();
  };
}
