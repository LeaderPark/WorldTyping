// spec: WT-M1-05 세션 어댑테이션 — @wt/data 커버리지 게이트(line 95%+).
// `pnpm --filter @wt/data test`(=vitest run --root .) / `--coverage` 에서 로드된다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'content/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 로직 파일만 계측. 빌드 산출 데이터(generated/**)·배럴(index.ts)은 제외.
      include: ['src/**/*.ts', 'content/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'content/**/*.test.ts', 'src/index.ts', 'src/generated/**'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
