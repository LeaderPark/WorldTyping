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
  /** 이 세션이 Google 로그인으로 발급된 "계정" 세션인가(SessionPayload.acct===1, WT-AUTH-01).
   *  requireAuth가 항상 세팅한다(게스트 세션은 false). requireAccountAuth가 이 값으로 게이팅한다. */
  acct: boolean;
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
  c.set("acct", result.payload.acct === 1);
  await next();
};

/**
 * 계정(Google 로그인) 세션 전용 게이트(WT-AUTH-01, docs/00 §11-D68 — 멀티 REST 4종 등). requireAuth의
 * 서명 검증을 그대로 재사용(내부 next로 위임 — 검증 로직 중복 금지)한 뒤, acct 세션이 아니면 401
 * `LOGIN_REQUIRED`로 막는다. 게스트 토큰(유효하지만 acct 아님)은 여기서 명시적 신규 코드로 거부해
 * 클라가 "로그인 필요" UI로 분기할 수 있게 한다(무효 토큰의 INVALID_TOKEN과 구별).
 */
export const requireAccountAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> = async (
  c,
  next,
) => {
  // requireAuth는 실패 시 throw하고, 성공 시 innerNext를 호출하며 pid/acct를 세팅한다. innerNext는
  // 실제 next가 아니라 "인증 통과" 표식일 뿐 — 여기서 acct를 추가 검사한 뒤 진짜 next를 부른다.
  await requireAuth(c, async () => {
    if (!c.get("acct")) {
      throw new ApiHttpError(401, "LOGIN_REQUIRED", "This action requires a Google account login.");
    }
    await next();
  });
};

/**
 * requireAuth의 관용판(WT-M6-03 POST /api/v1/t 전용). Authorization이 없거나 검증에 실패해도
 * 요청을 막지 않는다 — client_error 등은 세션 부트스트랩 이전(앱 초기 크래시)에도 발생할 수
 * 있어 텔레메트리 수집 자체를 막으면 안 된다. 검증 성공 시에만 `c.set('pid', ...)`하고, 실패는
 * 조용히 pid 미설정으로 다음 핸들러에 넘긴다(판정 로직은 requireAuth와 동일하게 shared
 * verifyToken에 위임 — 재구현하지 않는다).
 */
export const optionalAuth: MiddlewareHandler<{ Bindings: Env; Variables: Partial<AuthVariables> }> = async (
  c,
  next,
) => {
  const header = c.req.header("Authorization");
  const token =
    header && header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;
  if (token) {
    const result = await verifyToken(
      token,
      [c.env.SESSION_HMAC_SECRET, c.env.SESSION_HMAC_SECRET_PREV],
      SessionPayloadSchema,
    );
    if (result.ok) {
      c.set("pid", result.payload.pid);
      c.set("acct", result.payload.acct === 1);
    }
  }
  await next();
};
