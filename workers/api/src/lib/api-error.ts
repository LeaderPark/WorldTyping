// spec: docs/04 §2.1(ApiError 전역 포맷) + WT-M3-02 지시 3("에러 포맷은 ApiError 전역 통일,
// Hono onError")
//
// 라우트/미들웨어는 실패를 직접 c.json()으로 조립하지 않고 ApiHttpError를 throw한다 —
// index.ts의 app.onError(apiErrorHandler) 단 한 곳만이 응답 포맷을 안다(포맷 드리프트 방지).
import type { ErrorHandler } from "hono";
import type { Env } from "../env";
import { captureException } from "./reporter";
import { logError } from "./log";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSec?: number;
  };
}

/** docs/04 §2.1 ApiError를 던지기 위한 예외 타입. status는 실제 쓰는 값만 좁혀둔다. */
export class ApiHttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export const apiErrorHandler: ErrorHandler<{ Bindings: Env }> = async (err, c) => {
  // 미들웨어가 핸들러 진입 전에 거부하면(레이트리밋 429 등) POST 바디 스트림이 한 번도
  // 소비되지 않는다 — 응답을 만들기 전에 최선을 다해 드레인해 둔다. 단, workerd 자체가
  // "응답을 반환했는데 요청 바디를 안 읽었다"는 케이스를 백그라운드(우리 코드가 절대
  // await할 수 없는, 핸들러 리턴 이후 스케줄된) 태스크로 별도 드레인하는 내장 동작을
  // 갖고 있어, 그 배경 태스크와 경합하면 workerd 로그에
  // "workerd/io/io-context.c++:435: info: uncaught exception; ... Can't read from request
  // stream after response has been sent"이 여전히 찍힐 수 있다(관측 확인: WT-M3-02,
  // vitest-pool-workers에서 레이트리밋 429 경로 재현). info 레벨이고 우리 쪽 Promise 체인
  // 밖(uncaught)에서 나는 workerd 자체 로그라 응답 내용·테스트 결과에는 영향이 없다 —
  // 그래도 가능한 경우(우리 코드가 아직 스트림을 안 건드렸을 때)는 명시적으로 취소해 둔다.
  const reqBody = c.req.raw.body;
  if (reqBody && !c.req.raw.bodyUsed) {
    try {
      await reqBody.cancel();
    } catch {
      // 이미 다른 경로에서 잠겨있거나 소비된 경우 — 무시(원 에러 응답은 그대로 진행).
    }
  }

  if (err instanceof ApiHttpError) {
    const body: ApiErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}),
      },
    };
    return c.json(body, err.status);
  }

  // 미처리 예외: 원인은 서버 로그 + Sentry로만(클라에는 코드/사유 노출 안 함), 응답은 여전히
  // ApiError 포맷. captureException은 SENTRY_DSN 미설정 시 no-op(파일 상단 reporter.ts 참조).
  logError("unhandled_error", { message: err instanceof Error ? err.message : String(err), path: c.req.path });
  // c.executionCtx는 일부 실행 컨텍스트(예: 유닛 테스트 하네스)에서 접근 자체가 throw할 수 있어
  // 안전하게 얻는다 — 얻지 못하면 ctx 없이 captureException을 호출한다(reporter.ts가 그래도 처리).
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    execCtx = c.executionCtx;
  } catch {
    execCtx = undefined;
  }
  captureException(c.env, err, { ctx: execCtx, request: c.req.raw, tag: "hono:onError" });
  const body: ApiErrorBody = { error: { code: "INTERNAL", message: "internal server error" } };
  return c.json(body, 500);
};
