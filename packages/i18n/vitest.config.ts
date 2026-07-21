// spec: WT-M1-07 — 이 설정이 있어야 `pnpm --filter @wt/i18n test`(=vitest run --root .)가
// 저장소 루트의 vitest.config.ts(test.projects 워크스페이스 설정)로 config 탐색이 올라가
// 전 워크스페이스를 실행해버리는 문제 없이, 이 패키지 자신의 root로 독립 실행된다
// (packages/shared·data가 이미 동일한 이유로 자체 vitest.config.ts를 갖고 있다).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60,
      },
    },
  },
});
