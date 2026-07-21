// spec: WT-M0-01 §3(세션 환경 어댑테이션) — vitest.workspace.ts가 deprecated이므로
// 루트 vitest.config.ts의 test.projects 하나로 전 워크스페이스 테스트를 통합한다.
import { defineConfig } from "vitest/config";

const node = (
  name: string,
  root: string,
  include: string[] = ["src/**/*.test.{ts,tsx}"],
  setupFiles: string[] = [],
) => ({
  test: {
    name,
    root,
    environment: "node" as const,
    include,
    setupFiles,
  },
});

export default defineConfig({
  test: {
    projects: [
      // @wt/web: jest-dom 매처(toBeInTheDocument 등)는 jsdom override 테스트 파일에서만
      // 쓰이지만, 셋업 자체는 environment 무관하게 등록해도 무해하다(apps/web/vitest.config.ts와
      // 동일 셋업을 여기서도 로드해 루트 `pnpm test`와 `--filter @wt/web test`가 같은 매처
      // 집합으로 실행되게 한다 — 거짓 그린 방지, §0.4-7항).
      node("web", "apps/web", ["src/**/*.test.{ts,tsx}"], ["./src/vitest.setup.ts"]),
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
