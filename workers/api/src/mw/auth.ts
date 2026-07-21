// spec: docs/04 §2.1("인증: Authorization: Bearer <sessionToken>")·§5.2(세션 토큰 검증 순서),
//       docs/00 §11-D11(wt1. 포맷·30일·구/신 2키 병행) + WT-M3-02
//
// 모든 쓰기 라우트(및 인증 필요 GET)가 공유하는 Bearer 검증 미들웨어. 판정은 전부
// @wt/shared의 verifyToken에 위임한다(서명 검증 로직을 여기서 재구현하지 않는다).
import type { MiddlewareHandler } from "hono";
import { SessionPayloadSchema, verifyToken } from "@wt/shared";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";

const BEARER_PREFIX = "Bearer ";

export interface AuthVariables {
  pid: string;
}

/**
 * Authorization 헤더에서 wt1 세션 토큰을 추출·검증하고, 통과 시 `c.set('pid', ...)`한다.
 * 실패는 전부 401 INVALID_TOKEN(docs/04 §2.1 ApiError 코드) — 어떤 검증 단계에서 실패했는지는
 * 메시지에만 담고 클라 분기 가능한 별도 코드는 주지 않는다(공격자에게 힌트 최소화).
 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> = async (
  c,
  next,
) => {
  const header = c.req.header("Authorization");
  const token =
    header && header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;

  if (!token) {
    throw new ApiHttpError(401, "INVALID_TOKEN", "Missing Authorization: Bearer <sessionToken>");
  }

  const result = await verifyToken(
    token,
    [c.env.SESSION_HMAC_SECRET, c.env.SESSION_HMAC_SECRET_PREV],
    SessionPayloadSchema,
  );

  if (!result.ok) {
    throw new ApiHttpError(401, "INVALID_TOKEN", `Session token rejected (${result.reason})`);
  }

  c.set("pid", result.payload.pid);
  await next();
};
