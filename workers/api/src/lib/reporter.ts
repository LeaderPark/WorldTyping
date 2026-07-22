// spec: docs/06 §8.1(오류 추적)·§8.2 Sentry(toucan-js) 표(`tracesSampleRate: 0.05`), docs/04
//       §8.2(도구 표 — Sentry `SENTRY_DSN` secret) + WT-M6-04
//
// 예외 캡처의 단일 원천. Hono `app.onError`와 DO 최상위 `fetch` catch가 이 함수 하나만
// 호출한다 — Sentry 클라이언트 구성이 두 곳에서 갈라지지 않게 하기 위함(프로토콜/판정과
// 동일한 "단일 소스" 원칙).
//
// SENTRY_DSN 미설정(로컬/dev 기본값, .dev.vars.example에 실값 없음)이면 완전 no-op이다 —
// 시크릿 부재를 에러로 취급하지 않는다(config:client/config:anticheat 폴백과 동일 톤).
// 캡처 자체가 실패(네트워크·DSN 파싱 오류 등)해도 삼킨다 — 관측 채널의 실패가 원 요청/DO
// 핸들러의 응답을 절대 막아서는 안 된다.
import { Toucan } from "toucan-js";
import type { Env } from "../env";
import { log } from "./log";

/** ExecutionContext 전체가 아니라 waitUntil만 필요하다 — Hono의 Context#executionCtx 타입이
 *  패키지별 @cloudflare/workers-types 버전 차이로 완전히 맞물리지 않아(예: `tracing` 필드
 *  요구 버전 불일치) 최소 구조적 타입으로 좁혀 크로스 패키지 타입 마찰을 피한다. */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CaptureOptions {
  /** DO/Worker fetch 컨텍스트 — 있으면 toucan이 waitUntil로 전송을 완주시킨다(핸들러 반환 후 유실 방지). */
  ctx?: WaitUntilCtx;
  request?: Request;
  /** 캡처 지점 식별(예: 'do:MatchRoom', 'hono:onError'). Sentry 태그로 남는다. */
  tag?: string;
}

/**
 * 예외 1건을 Sentry로 전송한다. env.SENTRY_DSN이 없으면 즉시 반환(no-op).
 */
export function captureException(env: Pick<Env, "SENTRY_DSN">, err: unknown, opts: CaptureOptions = {}): void {
  if (!env.SENTRY_DSN) return;
  try {
    const toucan = new Toucan({
      dsn: env.SENTRY_DSN,
      context: opts.ctx ? { waitUntil: opts.ctx.waitUntil.bind(opts.ctx), request: opts.request } : undefined,
      request: opts.request,
      tracesSampleRate: 0.05, // docs/06 §8.2
    });
    if (opts.tag) toucan.setTag("wt.source", opts.tag);
    toucan.captureException(err);
  } catch (reportErr) {
    // Sentry 전송 실패 자체는 원 에러 처리를 막지 않는다 — 구조화 로그로만 남긴다.
    log("reporter_capture_failed", {
      message: reportErr instanceof Error ? reportErr.message : String(reportErr),
    });
  }
}
