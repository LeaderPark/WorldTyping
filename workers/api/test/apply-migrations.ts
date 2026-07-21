// spec: WT-M3-01 — vitest-pool-workers 표준 패턴(readD1Migrations + applyD1Migrations).
// 각 테스트 워커 인스턴스가 뜰 때 0001~0004 마이그레이션을 순서대로 로컬 D1(env.DB)에 적용한다.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
