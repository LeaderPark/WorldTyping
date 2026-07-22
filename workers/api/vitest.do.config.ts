// spec: WT-M4-01 세션 어댑테이션 §2("자동화 등가물"·"기존 그린 유지") + §0.4-7(거짓 그린 방지)
//
// MatchRoom DO 전용 vitest-pool-workers 설정. 메인 vitest.workers.config.ts와 분리한 이유:
//   Durable Object 테스트는 방마다 per-DO SQLite 파일을 남기는데, 메인 설정의 isolatedStorage(기본 true)는
//   매 테스트 종료 시 그 파일을 unlink 하려다 Windows에서 EBUSY(파일 잠김)로 러너 전체를 죽인다
//   (DO 인스턴스가 alarm/스토리지를 물고 있어 mmap 해제 전 삭제 불가 — miniflare/Windows 알려진 제약).
// 해결: 이 파일에서만 isolatedStorage=false 로 두고, 테스트는 방 코드(newRoomCode)·raceId로 상태를
//   자체 격리한다(공유 D1/DO 스토리지에 유니크 키로만 쓴다 → 상호 간섭 없음). 라우트(D1/KV) 통합 테스트는
//   기존 격리 그대로 vitest.workers.config.ts에서 계속 돈다(§0.4-7 "기존 그린 유지").
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      // WT-M4-01: match-room / WT-M4-02: matchmaker·multi-routes. 셋 다 MatchRoom/Matchmaker DO의
      // SQLite 파일을 남겨 isolatedStorage=true면 Windows EBUSY로 러너가 죽는다 → 여기(false)에서 실행.
      include: ["test/match-room.test.ts", "test/matchmaker.test.ts", "test/multi-routes.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // DO SQLite unlink(EBUSY) 회피 — 위 주석 참조. 테스트가 유니크 키로 자체 격리한다.
          isolatedStorage: false,
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_HMAC_SECRET: "test-session-secret",
              SESSION_HMAC_SECRET_PREV: "test-session-secret-prev",
              RUN_HMAC_SECRET: "test-run-secret",
              DAILY_SALT: "test-daily-salt",
            },
          },
          wrangler: { configPath: "./wrangler.toml" },
        },
      },
    },
  };
});
