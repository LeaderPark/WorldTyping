// spec: docs/04 §2.4(Hono 골격), §1.1(D1/KV 용도) + WT-M0-02 [완료 조건]
// GET /api/v1/health — D1 SELECT 1 + KV read를 시도하고, 바인딩이 없으면(로컬 미시뮬레이션 등)
// 해당 체크를 skip으로 관대하게 처리한다. 라우트 CRUD 자체는 M3 소관 — 이 파일은 헬스체크 전용.

import { Hono } from "hono";
import type { Env } from "../env";

type CheckResult = { ok: true; skipped?: boolean } | { ok: false; skipped?: boolean; error: string };

export const health = new Hono<{ Bindings: Env }>();

health.get("/health", async (c) => {
  const checks: Record<string, CheckResult> = {
    d1: await checkD1(c.env.DB),
    kv: await checkKv(c.env.KV),
  };

  const ok = Object.values(checks).every((r) => r.ok);

  return c.json(
    {
      ok,
      environment: c.env.ENVIRONMENT ?? "dev",
      checks,
    },
    ok ? 200 : 503,
  );
});

async function checkD1(db: Env["DB"] | undefined): Promise<CheckResult> {
  if (!db) return { ok: true, skipped: true };
  try {
    await db.prepare("SELECT 1").first();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkKv(kv: Env["KV"] | undefined): Promise<CheckResult> {
  if (!kv) return { ok: true, skipped: true };
  try {
    await kv.get("health:probe");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
