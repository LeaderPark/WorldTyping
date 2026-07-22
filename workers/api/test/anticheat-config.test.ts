// spec: docs/00 §11-D12(config:anticheat 통합)·D53(newPidAbuseMaxPerHour 핫스왑 승격) + WT-M6-04
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadAnticheatConfig, DEFAULT_ANTICHEAT_CONFIG } from "../src/lib/anticheat-config";
import { KV_KEYS } from "../src/lib/kv-keys";

describe("lib/anticheat-config — loadAnticheatConfig (WT-M6-04 D53)", () => {
  it("KV 미설정(get 결과 없음)이면 번들 기본값(newPidAbuseMaxPerHour=20 포함)을 반환한다", async () => {
    await env.KV.delete(KV_KEYS.configAnticheat);
    const cfg = await loadAnticheatConfig(env.KV);
    expect(cfg).toEqual(DEFAULT_ANTICHEAT_CONFIG);
    expect(cfg.newPidAbuseMaxPerHour).toBe(20);
  });

  it("유효한 KV 값이면 newPidAbuseMaxPerHour를 포함해 그대로 반영한다", async () => {
    const override = { ...DEFAULT_ANTICHEAT_CONFIG, newPidAbuseMaxPerHour: 5 };
    await env.KV.put(KV_KEYS.configAnticheat, JSON.stringify(override));
    try {
      const cfg = await loadAnticheatConfig(env.KV);
      expect(cfg.newPidAbuseMaxPerHour).toBe(5);
    } finally {
      await env.KV.delete(KV_KEYS.configAnticheat);
    }
  });

  it("newPidAbuseMaxPerHour 누락(구버전 KV 값)이면 스키마 검증 실패로 전량 기본값 폴백한다", async () => {
    const { newPidAbuseMaxPerHour: _omit, ...legacy } = DEFAULT_ANTICHEAT_CONFIG;
    await env.KV.put(KV_KEYS.configAnticheat, JSON.stringify(legacy));
    try {
      const cfg = await loadAnticheatConfig(env.KV);
      expect(cfg).toEqual(DEFAULT_ANTICHEAT_CONFIG);
    } finally {
      await env.KV.delete(KV_KEYS.configAnticheat);
    }
  });

  it("잘못된 JSON이면 전량 기본값 폴백한다", async () => {
    await env.KV.put(KV_KEYS.configAnticheat, "{not json");
    try {
      const cfg = await loadAnticheatConfig(env.KV);
      expect(cfg).toEqual(DEFAULT_ANTICHEAT_CONFIG);
    } finally {
      await env.KV.delete(KV_KEYS.configAnticheat);
    }
  });

  it("kv 인자 자체가 undefined(바인딩 미구성)면 기본값을 반환한다", async () => {
    const cfg = await loadAnticheatConfig(undefined);
    expect(cfg).toEqual(DEFAULT_ANTICHEAT_CONFIG);
  });
});
