// spec: docs/07-implementation-prompts.md §0.4-7 + WT-M3-01 세션 환경 어댑테이션(§2 조정 3)
//
// 파일명이 `vitest.config.ts`가 아니라 `vitest.workers.config.ts`인 이유: 이 이름이었다면
// workers/api/package.json의 기존 "test"(순수 node, index.test.ts) 스크립트가
// `vitest run --root .` 실행 시 이 파일을 자동 발견해 pool을 통째로 바꿔치기하고, 이 config의
// include(test/**/*.test.ts)가 src/**/*.test.ts를 담지 않아 기존 테스트가 0건 실행되는 조용한
// 회귀가 생긴다. 이름을 다르게 둬 `-c vitest.workers.config.ts`로 명시 지정했을 때만 적용되게
// 분리했다(§0.4-7 "거짓 그린 방지"와 동일한 정신 — 기존 그린을 깨뜨리지 않는다).
//
// vitest-pool-workers는 이 태스크(WT-M3-01)에서 최초 도입한다. 루트 vitest.config.ts의
// `test.projects`(apps/web·shared·data·engine·i18n·moderation·api)는 전부 plain node
// environment이고, pool-workers는 별도의 pool(workerd 기반 격리 러너)이 필요해 동일
// projects 배열에 자연스럽게 합쳐지지 않는다 — 억지로 합치면 기존 node 프로젝트들의
// 설정(예: apps/web의 jsdom override)까지 pool 전환의 영향권에 들어가 회귀 위험이 크다.
//
// 채택안(리드 사전 승인 조정 반영): workers/api 전용 vitest.config.ts를 이 파일로 두고
// `pnpm --filter @wt/api run test:workers`로 독립 실행한다. 루트 `pnpm test`는
// `vitest run`(기존 projects, src/**/*.test.ts만 — index.test.ts 등 순수 node 테스트)
// 다음에 이 스크립트를 이어 실행하도록 루트 package.json에 배선했다(§0.4-7 "거짓 그린 방지"
// 준수 — 루트 test와 --filter 실행이 항상 같은 테스트 집합을 돈다).
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ["test/**/*.test.ts"],
      // MatchRoom DO 테스트는 isolatedStorage=false가 필요해(Windows EBUSY 회피) 별도
      // vitest.do.config.ts로 분리 실행한다 — 여기서는 제외(§0.4-7 거짓 그린 방지: 같은 파일이
      // 두 설정에서 이중 실행되지 않게 한다).
      exclude: ["test/match-room.test.ts", "**/node_modules/**"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            // 마이그레이션 목록을 테스트 바인딩으로 주입 — setupFiles에서 applyD1Migrations로 적용.
            // 시크릿 3종은 wrangler.toml에 절대 기재하지 않으므로(코드/toml 기재 금지) 여기서
            // 테스트 전용 더미값으로 주입한다(WT-M3-02, 세션 환경 어댑테이션 §2 지시).
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_HMAC_SECRET: "test-session-secret",
              SESSION_HMAC_SECRET_PREV: "test-session-secret-prev",
              RUN_HMAC_SECRET: "test-run-secret",
              DAILY_SALT: "test-daily-salt",
            },
          },
          // 실 프로덕션 wrangler.toml을 그대로 사용(D1/KV/DO/Queue/AE 바인딩 전부 동일 시뮬레이션
          // 대상 — 세션 환경 지시 §2 "통합 검증 토폴로지" 취지와 일치).
          wrangler: { configPath: "./wrangler.toml" },
        },
      },
    },
  };
});
