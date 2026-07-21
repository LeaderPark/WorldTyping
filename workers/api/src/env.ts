// spec: docs/04 §2.4(Hono 앱 골격의 Env 인터페이스) + docs/00 §7(바인딩/시크릿) + §11-D8,D19,D25
// WT-M0-02: Env 인터페이스만 정의한다(라우트/DO 본문은 이후 마일스톤).
//
// docs/04 §2.4 원문 대비 개명 사항 (docs/00 §11 확정 결정 반영):
//   - SCORE_QUEUE → EVENTS       (§11-D16: Queue는 AE 적재/신고/고스트 저장 전용, wt-events)
//   - LOBBY       → MATCHMAKER  (§11-D8: LobbyDO 폐기, Matchmaker DO로 대체)
//   - AE 바인딩명은 04·06 그대로 유지 (§11-D25)

export interface Env {
  // Static Assets — apps/web/dist (SPA + public/data). run_worker_first 밖은 여기로 직행.
  ASSETS: Fetcher;

  // D1 — wt-main-{env} (users/runs/lb_best/matches/match_participants/reports/admin_audit/
  //                     user_unlocks/daily_challenges/shares/kpi_daily)
  DB: D1Database;

  // KV — wt-kv-{env}, 단일 네임스페이스 + 프리픽스 운용 (config:*, lb:*, daily:*, rl:*, data:* …)
  KV: KVNamespace;

  // R2 — wt-{env} (OG 카드, 고스트 리플레이 blob). v1 필수 아님 — 바인딩만 준비.
  BUCKET: R2Bucket;

  // Queue — wt-events-{env}. producer=API Worker, consumer=동일 Worker의 queue() 핸들러.
  EVENTS: Queue<unknown>;

  // Analytics Engine — wt_telemetry (docs/06 §5.2 이벤트 스키마)
  AE: AnalyticsEngineDataset;

  // Durable Objects (SQLite-backed, new_sqlite_classes) — 본문은 M4 소관, 지금은 빈 스텁 export만.
  MATCH_ROOM: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;

  // Rate Limiting binding — runs/submit 1차 방어 (KV 쓰기 절감, docs/04 §9.3). M0에서는 자리만.
  RL?: RateLimit;

  // Secrets (wrangler secret put --env 로만 주입 — 코드/toml에 값 기재 절대 금지)
  SESSION_HMAC_SECRET: string;
  // 키 로테이션 병행 검증용 구(舊) 시크릿(docs/04 §7 "구/신 2키 7일 병행 검증", WT-M3-02).
  // 로테이션 중이 아니면 미설정 — mw/auth.ts와 routes/session.ts의 verifyToken 호출이
  // [SESSION_HMAC_SECRET, SESSION_HMAC_SECRET_PREV] 순으로 시도한다(둘 중 하나만 맞아도 통과).
  SESSION_HMAC_SECRET_PREV?: string;
  RUN_HMAC_SECRET: string;
  DAILY_SALT: string;
  SENTRY_DSN?: string;
  TURNSTILE_SECRET?: string;

  // 환경 식별 (wrangler.toml [vars] / [env.*.vars])
  ENVIRONMENT: "dev" | "staging" | "prod";
}

// Cloudflare Rate Limiting binding 타입은 @cloudflare/workers-types 미포함 버전 대비 최소 선언.
// (실 프로젝트에 rate_limiting 바인딩을 추가하는 시점에 workers-types 갱신으로 대체된다.)
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
