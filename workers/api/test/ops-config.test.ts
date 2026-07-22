// spec: docs/06 §8.2(부정 급증 자체 체크 → Slack) + WT-M6-04 작업 특이 조정("Slack webhook URL은
// KV config에서 로드, 부재 시 skip 로그")
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOpsConfig, notifySlack } from "../src/lib/ops-config";
import { KV_KEYS } from "../src/lib/kv-keys";

describe("lib/ops-config", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.KV.delete(KV_KEYS.configOps);
  });

  it("KV 미설정이면 slackWebhookUrl=null(기본값)", async () => {
    const cfg = await loadOpsConfig(env.KV);
    expect(cfg.slackWebhookUrl).toBeNull();
  });

  it("유효한 URL이면 그대로 반영", async () => {
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "https://hooks.slack.example/abc" }));
    const cfg = await loadOpsConfig(env.KV);
    expect(cfg.slackWebhookUrl).toBe("https://hooks.slack.example/abc");
  });

  it("스키마 위반(URL 아님)이면 폴백(null)", async () => {
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "not-a-url" }));
    const cfg = await loadOpsConfig(env.KV);
    expect(cfg.slackWebhookUrl).toBeNull();
  });

  it("잘못된 JSON이면 폴백(null)", async () => {
    await env.KV.put(KV_KEYS.configOps, "{broken");
    const cfg = await loadOpsConfig(env.KV);
    expect(cfg.slackWebhookUrl).toBeNull();
  });

  it("kv 인자 자체가 undefined면 기본값을 반환한다", async () => {
    const cfg = await loadOpsConfig(undefined);
    expect(cfg.slackWebhookUrl).toBeNull();
  });

  it("notifySlack: webhook 미설정이면 fetch를 호출하지 않는다(skip)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await notifySlack(env.KV, "test message");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifySlack: webhook 설정 시 POST로 text 페이로드를 보낸다", async () => {
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "https://hooks.slack.example/xyz" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await notifySlack(env.KV, "hello");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.slack.example/xyz",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as { text: string };
    expect(body.text).toBe("hello");
  });

  it("notifySlack: fetch 실패해도 throw하지 않는다(관대한 폴백)", async () => {
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "https://hooks.slack.example/fail" }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(notifySlack(env.KV, "hello")).resolves.toBeUndefined();
  });

  it("notifySlack: webhook이 non-2xx를 반환해도 throw하지 않는다", async () => {
    await env.KV.put(KV_KEYS.configOps, JSON.stringify({ slackWebhookUrl: "https://hooks.slack.example/500" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    await expect(notifySlack(env.KV, "hello")).resolves.toBeUndefined();
  });
});
