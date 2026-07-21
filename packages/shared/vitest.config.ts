// spec: WT-M1-01 세션 어댑테이션 — @wt/shared 커버리지 게이트(line 95%+).
// 이 설정은 `pnpm --filter @wt/shared test`(=vitest run --root .)에서만 로드된다.
// 루트 vitest.config.ts는 test.projects 인라인 객체를 쓰므로 이 파일을 흡수하지 않는다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 실행 코드가 있는 판정 엔진만 계측. 타입 전용 파일(types/**)·배럴(index.ts)은 제외.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/types/**'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
