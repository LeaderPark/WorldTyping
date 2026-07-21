// spec: docs/06 §3.6(신고 플로우 전문 — POST /api/report, Queue 적재), docs/00 §11-D16(Queue는
//       AE 적재·신고·고스트 저장 전용, 제출 경로는 동기) + docs/07 WT-M3-05
//
// POST /api/v1/report — Queue(wt-events)에 적재만 하고 즉시 응답한다. D1 reports INSERT와 5건
// 임계 flagged 승격은 비동기 컨슈머(queue/consumer.ts)가 수행한다(§11-D16 — 제출 경로만 동기,
// 신고 처리는 Queue 소관).
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { requireAuth, type AuthVariables } from "../mw/auth";
import type { ReportQueueMessage } from "../queue/consumer";

/**
 * docs/06 §3.6 UI 문구("매크로 의심/닉네임 부적절/기타")를 내부 코드로 대응한 값 — 신고 사유
 * 어휘 자체는 문서에 canonical 상수표가 없어 이 구현에서 채택했다(verdict_reason처럼
 * snake_case 내부 코드, 표시는 클라 i18n 키 소관).
 */
const ReportReasonSchema = z.enum(["macro_suspected", "nickname_inappropriate", "other"]);

const ReportReqSchema = z
  .object({
    targetRunId: z.string().min(1).max(64).optional(),
    targetUserId: z.string().min(1).max(64).optional(),
    reason: ReportReasonSchema,
  })
  .strict()
  .refine((v) => v.targetRunId !== undefined || v.targetUserId !== undefined, {
    message: "targetRunId 또는 targetUserId 중 하나가 필요합니다.",
  });

export const report = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

report.post("/report", requireAuth, async (c) => {
  const parsed = ReportReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "report 요청 형식이 올바르지 않습니다.");
  }
  const { targetRunId, targetUserId, reason } = parsed.data;
  const reporterUserId = c.get("pid");

  // 자기 자신 신고는 무의미 — 큐에 적재하지 않고 조용히 성공 처리(어뷰징 시그널 최소화, docs/06
  // §3.1 "공격자에게 실패 신호를 명확히 주지 않는다"와 동일 톤).
  if (targetUserId !== undefined && targetUserId === reporterUserId) {
    return c.json({ accepted: true });
  }

  const message: ReportQueueMessage = {
    type: "report",
    reporterUserId,
    targetUserId: targetUserId ?? null,
    targetRunId: targetRunId ?? null,
    reason,
    createdAt: Date.now(),
  };

  if (c.env.EVENTS) {
    await c.env.EVENTS.send(message);
  }

  return c.json({ accepted: true });
});
