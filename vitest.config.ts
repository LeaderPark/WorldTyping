// spec: WT-M0-01 §3(세션 환경 어댑테이션) — vitest.workspace.ts가 deprecated이므로
// 루트 vitest.config.ts의 test.projects 하나로 전 워크스페이스 테스트를 통합한다.
import { defineConfig } from "vitest/config";

const node = (name: string, root: string, include: string[] = ["src/**/*.test.{ts,tsx}"]) => ({
  test: {
    name,
    root,
    environment: "node" as const,
    include,
  },
});

export default defineConfig({
  test: {
    projects: [
      node("web", "apps/web"),
      node("api", "workers/api"),
      node("shared", "packages/shared"),
      // data: content/routes.test.ts(WT-M1-06)는 src/ 밖에 있어 별도 include가 필요하다.
      node("data", "packages/data", ["src/**/*.test.{ts,tsx}", "content/**/*.test.{ts,tsx}"]),
      node("engine", "packages/engine"),
      node("i18n", "packages/i18n"),
      node("moderation", "packages/moderation"),
    ],
  },
});
