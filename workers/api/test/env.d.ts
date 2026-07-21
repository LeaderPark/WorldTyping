// spec: WT-M3-01 — cloudflare:test의 ProvidedEnv에 테스트 전용 바인딩(TEST_MIGRATIONS)을 추가한다.
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
