// spec: docs/04 §2.2(#15 GET /api/v1/data/countries)·§2.1(공통 규약), docs/00 §7.4
//       (`data:countries:override` 핫스왑 채널) + WT-M3-02
//
// KV 핫스왑이 활성일 때만 의미가 있는 라우트다 — GET /config가 override 존재 시에만
// dataUrl을 이 경로로 바꿔준다(config.ts). override가 없으면 404(정적 자산이 원천이라는 뜻).
import { Hono } from "hono";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";

export const data = new Hono<{ Bindings: Env }>();

data.get("/data/countries", async (c) => {
  const kv = c.env.KV;
  if (!kv) {
    throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "KV binding not configured");
  }
  const raw = await kv.get(KV_KEYS.dataCountriesOverride);
  if (!raw) {
    throw new ApiHttpError(404, "NOT_FOUND", "No countries override is currently active");
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.body(raw, 200, { "Content-Type": "application/json; charset=utf-8" });
});
