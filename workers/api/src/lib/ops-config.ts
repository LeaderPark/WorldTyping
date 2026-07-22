// spec: docs/06 §8.2(알림 표 — 부정 급증 5분 Cron 자체 체크 → Slack) + WT-M6-04 작업 특이 조정
//       ("Slack webhook URL은 KV config에서 로드, 부재 시 skip 로그")
//
// KV `config:ops`(핫스왑)에서 운영 알림 설정을 로드한다. anticheat-config.ts와 동일한 관대한
// 폴백 톤: 부재/파싱 실패/스키마 불일치는 "알림 비활성"으로 취급하고 skip 로그만 남긴다 —
// 운영 알림 설정 자체가 요청 경로에 있지 않으므로(Cron 전용) 실패해도 기능에 영향이 없다.
import { z } from "zod";
import { KV_KEYS } from "./kv-keys";
import { log, logError } from "./log";

export interface OpsConfig {
  /** 부정 급증/장애 알림용 Slack Incoming Webhook URL. 미설정 시 알림 전송을 skip한다. */
  slackWebhookUrl: string | null;
}

const OpsConfigSchema = z
  .object({
    slackWebhookUrl: z.string().url().nullable().optional(),
  })
  .strict();

const DEFAULT_OPS_CONFIG: OpsConfig = { slackWebhookUrl: null };

export async function loadOpsConfig(kv?: KVNamespace): Promise<OpsConfig> {
  if (!kv) return { ...DEFAULT_OPS_CONFIG };
  const raw = await kv.get(KV_KEYS.configOps);
  if (!raw) return { ...DEFAULT_OPS_CONFIG };
  try {
    const parsed = OpsConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { slackWebhookUrl: parsed.data.slackWebhookUrl ?? null };
    logError("config_ops_schema_invalid", { message: parsed.error.message });
  } catch (err) {
    logError("config_ops_json_invalid", { message: err instanceof Error ? err.message : String(err) });
  }
  return { ...DEFAULT_OPS_CONFIG };
}

/**
 * Slack Incoming Webhook으로 텍스트 메시지 1건을 보낸다. webhook URL 미설정/전송 실패는 전부
 * 삼키고 skip/warn 로그만 남긴다(운영 알림 채널 자체의 장애가 호출부 로직을 막아선 안 된다).
 */
export async function notifySlack(kv: KVNamespace | undefined, text: string): Promise<void> {
  const { slackWebhookUrl } = await loadOpsConfig(kv);
  if (!slackWebhookUrl) {
    log("slack_notify_skipped", { reason: "no_webhook_configured" });
    return;
  }
  try {
    const res = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      logError("slack_notify_failed", { status: res.status });
    }
  } catch (err) {
    logError("slack_notify_failed", { message: err instanceof Error ? err.message : String(err) });
  }
}
