// spec: docs/06 §8.2(가용성 알림 — GET /api/health 2회 연속 실패)·docs/04 §8.2(도구 표) + WT-M6-04
//
// vitest-pool-workers 환경(D1/KV 실 바인딩 시뮬레이션)에서의 헬스체크 심층화 검증. 순수 라우팅
// (바인딩 부재 skip)은 src/index.test.ts가 이미 커버 — 여기는 바인딩이 "있을 때"의 정상 ok 경로 +
// fault injection 훅(§11 세션 어댑테이션 — 원격 인프라를 실제로 깨뜨릴 수 없어 이 훅으로 알림
// 경로 발화 테스트를 대신한다, tooling/ops/runbook.md 참조)을 검증한다.
//
// DO ping은 이 태스크에서 시도했다가 되돌렸다(health.ts 파일 상단 주석 — Windows EBUSY 회피).
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://local/api/v1";

interface HealthBody {
  ok: boolean;
  environment: string;
  checks: {
    d1: { ok: boolean; skipped?: boolean; error?: string };
    kv: { ok: boolean; skipped?: boolean; error?: string };
  };
}

describe("GET /api/v1/health (WT-M6-04 심층화)", () => {
  it("D1/KV 바인딩이 실재하는 로컬 시뮬레이션에서 전부 ok:true", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.checks.d1.ok).toBe(true);
    expect(body.checks.kv.ok).toBe(true);
  });

  it("?fault=d1 (dev 환경)이면 d1만 강제 실패하고 전체 ok:false, 503", async () => {
    const res = await SELF.fetch(`${BASE}/health?fault=d1`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(false);
    expect(body.checks.d1.ok).toBe(false);
    expect(body.checks.kv.ok).toBe(true);
  });

  it("?fault=kv이면 kv만 강제 실패한다", async () => {
    const res = await SELF.fetch(`${BASE}/health?fault=kv`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.checks.kv.ok).toBe(false);
    expect(body.checks.d1.ok).toBe(true);
  });

  it("알 수 없는 ?fault 값은 무시하고 정상 체크로 진행한다", async () => {
    const res = await SELF.fetch(`${BASE}/health?fault=bogus`);
    expect(res.status).toBe(200);
  });
});

// ENVIRONMENT='prod'에서 ?fault가 무시되는지는 c.env를 요청별로 바꿔치기할 수 있는 plain vitest
// 하네스(src/index.test.ts, makeEnv override)에서 검증한다 — SELF.fetch는 wrangler.toml
// [vars] ENVIRONMENT='dev' 고정이라 이 파일에서는 prod 시나리오를 만들 수 없다.
