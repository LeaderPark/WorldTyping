// spec: docs/04 §2.3-2(ConfigRes 전문)·§2.2(#15 GET /data/countries), docs/00 §7.4
//       (config:client edge cache 60s / data:countries:override 핫스왑) + WT-M3-02
//       [구현 세부 지시] #4 — "config 폴백"을 커버한다.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";

// config.ts의 ConfigResSchema가 timeLimit을 필수로 요구하므로, override 테스트에서 최소 형태로 채운다.
const DEFAULT_TIME_LIMIT = { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 };

interface ConfigRes {
  schemaVersion: 2;
  dataUrl: string;
  mapUrl: string;
  grades: { S: number; A: number; B: number; C: number };
  anticheat: { cpmHardCapKo: number; cpmHardCapEn: number; minMsPerKeystroke: number };
  featureFlags: Record<string, boolean>;
}

describe("GET /api/v1/config", () => {
  it("falls back to the bundled default config when KV config:client is absent", async () => {
    const res = await SELF.fetch(`${BASE}/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");

    const body = (await res.json()) as ConfigRes;
    expect(body.schemaVersion).toBe(2);
    expect(body.mapUrl).toBe("/data/countries-110m.json");
    // docs/00 §11-D12 확정값
    expect(body.anticheat).toEqual({ cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 });
    // @wt/shared DEFAULT_GRADE_CONFIG와 반드시 일치 — 이 라우트가 자체 상수를 재정의하면 안 된다.
    expect(body.grades).toEqual({ S: 450, A: 340, B: 230, C: 120 });
  });

  it("reflects the countries manifest sha256 in dataUrl as a cache-busting query param", async () => {
    const res = await SELF.fetch(`${BASE}/config`);
    const body = (await res.json()) as ConfigRes;
    // apps/web/dist/data/manifest.json(빌드 산출물)의 실제 sha256 접두 8자.
    expect(body.dataUrl).toBe("/data/countries.json?v=4b494daa");
  });

  it("overrides with KV config:client when present and it passes schema validation", async () => {
    const custom: ConfigRes = {
      schemaVersion: 2,
      dataUrl: "/ignored-by-route.json",
      mapUrl: "/data/countries-110m.json",
      grades: { S: 500, A: 400, B: 300, C: 200 },
      anticheat: { cpmHardCapKo: 1200, cpmHardCapEn: 1050, minMsPerKeystroke: 30 },
      featureFlags: { ghostMode: true },
    };
    await env.KV.put(KV_KEYS.configClient, JSON.stringify({ ...custom, timeLimit: DEFAULT_TIME_LIMIT }));

    const res = await SELF.fetch(`${BASE}/config`);
    const body = (await res.json()) as ConfigRes;
    expect(body.grades).toEqual(custom.grades);
    expect(body.anticheat).toEqual(custom.anticheat);
    expect(body.featureFlags).toEqual({ ghostMode: true });
    // dataUrl은 KV 저장값이 아니라 이 라우트가 항상 재계산한다(override 여부 판단 로직 단일화).
    expect(body.dataUrl).toBe("/data/countries.json?v=4b494daa");
  });

  it("falls back to defaults when KV config:client is present but fails schema validation", async () => {
    await env.KV.put(KV_KEYS.configClient, JSON.stringify({ schemaVersion: 2, grades: "not-an-object" }));
    const res = await SELF.fetch(`${BASE}/config`);
    const body = (await res.json()) as ConfigRes;
    expect(body.grades).toEqual({ S: 450, A: 340, B: 230, C: 120 });
  });

  it("falls back to defaults when KV config:client is not valid JSON", async () => {
    await env.KV.put(KV_KEYS.configClient, "{not json");
    const res = await SELF.fetch(`${BASE}/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigRes;
    expect(body.grades).toEqual({ S: 450, A: 340, B: 230, C: 120 });
  });

  it("switches dataUrl to /api/v1/data/countries when data:countries:override is set", async () => {
    await env.KV.put(KV_KEYS.dataCountriesOverride, JSON.stringify({ COUNTRIES: [] }));
    const res = await SELF.fetch(`${BASE}/config`);
    const body = (await res.json()) as ConfigRes;
    expect(body.dataUrl).toBe("/api/v1/data/countries");
  });
});

describe("GET /api/v1/data/countries", () => {
  it("404s when no override is active", async () => {
    const res = await SELF.fetch(`${BASE}/data/countries`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("serves the raw override JSON with a 300s cache header when active", async () => {
    const payload = JSON.stringify({ COUNTRIES: [{ id: "KR" }] });
    await env.KV.put(KV_KEYS.dataCountriesOverride, payload);

    const res = await SELF.fetch(`${BASE}/data/countries`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await res.text()).toBe(payload);
  });
});
