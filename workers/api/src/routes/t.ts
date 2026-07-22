// spec: docs/06 §5.2(클라 전용 이벤트는 POST /api/t 단일 수집 엔드포인트로 배칭(10개/5초) 전송),
//       docs/03 §8.6(전역 리포터 — window.onerror/unhandledrejection, 샘플링 10%, 인터페이스
//       reportError(e, ctx) 추상화), docs/00 §11-D25 + WT-M6-03
//
// POST /api/v1/t — 클라 배치 텔레메트리 수신. 광고차단기로 이 경로 자체가 막혀도 핵심 지표
// (docs/06 §5.2 표의 서버 트리거 이벤트)는 무손실이라는 전제가 성립한다(이 라우트는 보조 신호
// 전용). 인증은 선택(optionalAuth) — 앱 초기 크래시처럼 세션 부트스트랩 이전에도 에러를 보고할
// 수 있어야 한다.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { optionalAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";
import { trackClientError, trackShareClick } from "../lib/telemetry";

const MAX_BATCH = 20; // 클라 배칭 주기(10개/5초)보다 여유 있게(재시도 합류 대비) — §5.2

const ClientErrorEvent = z
  .object({
    type: z.literal("client_error"),
    ts: z.number(),
    message: z.string().min(1).max(500),
    stack: z.string().max(4000).optional(),
  })
  .strict();

const ShareClickEvent = z
  .object({
    type: z.literal("share_click"),
    ts: z.number(),
    referrerHost: z.string().max(128).optional(),
    utmSource: z.string().max(64).optional(),
  })
  .strict();

const ClientEventSchema = z.discriminatedUnion("type", [ClientErrorEvent, ShareClickEvent]);

const BatchReqSchema = z
  .object({
    events: z.array(ClientEventSchema).min(1).max(MAX_BATCH),
  })
  .strict();

/** 스택 상위 3프레임만 남긴다(구현 세부 지시 — 개인정보/페이로드 최소화). */
function top3Frames(stack: string | undefined): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

export const t = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

t.post("/t", optionalAuth, rateLimit("t"), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = BatchReqSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "events 배열(1~20개)이 필요합니다.");
  }
  const pid = c.get("pid") ?? null;

  for (const ev of parsed.data.events) {
    if (ev.type === "client_error") {
      await trackClientError(c.env, pid, { message: ev.message, top3Frames: top3Frames(ev.stack) });
    } else if (ev.type === "share_click") {
      trackShareClick(c.env, { referrerHost: ev.referrerHost, utmSource: ev.utmSource });
    }
  }

  return c.json({ ok: true, received: parsed.data.events.length });
});
