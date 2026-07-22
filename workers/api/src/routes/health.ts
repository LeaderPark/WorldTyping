// spec: docs/04 §2.4(Hono 골격), §1.1(D1/KV 용도) + WT-M0-02 [완료 조건], docs/06 §8.2(가용성
//       알림 — `GET /api/health`(D1 SELECT 1 + KV read 포함) 2회 연속 실패 → Health Checks),
//       docs/00 §11-D48(로컬은 정보용, 규범 판정은 원격) + WT-M6-04
//
// GET /api/v1/health — D1 SELECT 1 + KV read를 시도하고, 바인딩이 없으면(로컬 미시뮬레이션 등)
// 해당 체크를 skip으로 관대하게 처리한다.
//
// [WT-M6-04 심층화 — 구현 결정, 최종 보고 escalations 참조] docs/06 §8.4 작업 지시는 "(선택) DO
// ping"을 포함한 심층화를 요청했으나, MatchRoom/Matchmaker DO는 SQLite-backed(new_sqlite_classes)
// 라 vitest-pool-workers + Windows 조합에서 DO 인스턴스 생성이 파일 잠금(EBUSY)을 유발한다(이미
// 레포가 match-room/matchmaker/multi-routes/ghost/reconnect/og-multi 테스트를 별도
// vitest.do.config.ts(isolatedStorage=false)로 분리해 회피 중인 바로 그 문제 — CLAUDE.md 함정 2).
// /health는 og.test.ts를 포함해 여러 테스트 파일이 스모크 체크로 호출하는 핫 엔드포인트라, DO
// ping을 넣으면 그 모든 호출부가 새로 DO 스토리지 격리 문제에 노출된다(실측: 도입 시 og.test.ts
// 테스트 러너가 EBUSY로 크래시). 실제 프로덕션(Cloudflare 원격)에서는 이 문제가 없지만, 로컬
// 재현성이 깨지는 비용이 "선택" 항목의 이득보다 커 DO ping은 보류한다 — 리드가 원격에서만
// 검증하는 조건부 배선을 원하면 §11에 결정 추가 요망.
//
// [fault injection] docs/06 §8 알림 경로(Health Checks 2회 연속 실패 → Slack/이메일)를 로컬/
// staging에서 실제로 발화시켜 보려면 인프라를 실제로 깨뜨릴 수 없다(원격 계정 미연결 — 세션
// 어댑테이션 §2). 그래서 `?fault=d1|kv` 쿼리 파라미터로 해당 체크만 강제 실패시키는 훅을
// prod 이외 환경에서만 허용한다(ENVIRONMENT!=='prod' 가드 — prod에서 공개 노출 시 헬스체크를
// 외부에서 조작할 수 있는 취약점이 되므로 절대 허용하지 않는다). 절차는 tooling/ops/runbook.md
// "알림 경로 강제 발화 테스트" 항목 참고.
import { Hono } from "hono";
import type { Env } from "../env";
import { logError } from "../lib/log";

type CheckResult = { ok: true; skipped?: boolean } | { ok: false; skipped?: boolean; error: string };

export const health = new Hono<{ Bindings: Env }>();

const FAULT_KEYS = ["d1", "kv"] as const;
type FaultKey = (typeof FAULT_KEYS)[number];

health.get("/health", async (c) => {
  // prod에서는 절대 허용하지 않는다(파일 상단 주석) — 외부에서 헬스체크 결과를 조작 못하게.
  const faultParam = c.env.ENVIRONMENT !== "prod" ? c.req.query("fault") : undefined;
  const fault: FaultKey | undefined = FAULT_KEYS.includes(faultParam as FaultKey)
    ? (faultParam as FaultKey)
    : undefined;

  const checks: { d1: CheckResult; kv: CheckResult } = {
    d1: fault === "d1" ? injectedFailure("d1") : await checkD1(c.env.DB),
    kv: fault === "kv" ? injectedFailure("kv") : await checkKv(c.env.KV),
  };

  const ok = Object.values(checks).every((r) => r.ok);

  if (!ok) {
    // docs/06 §8.2 "가용성" 알림 임계(2회 연속 실패)의 관측 원천 — 구조화 로그로 남긴다.
    logError("health_check_failed", { d1: checks.d1.ok, kv: checks.kv.ok, injectedFault: fault ?? null });
  }

  return c.json(
    {
      ok,
      environment: c.env.ENVIRONMENT ?? "dev",
      checks,
    },
    ok ? 200 : 503,
  );
});

function injectedFailure(key: FaultKey): CheckResult {
  return { ok: false, error: `injected fault (?fault=${key}, non-prod only)` };
}

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
