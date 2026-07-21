// spec: WT-M1-01 세션 어댑테이션 — @wt/shared 커버리지 게이트(line 95%+).
// 이 설정은 `pnpm --filter @wt/shared test`(=vitest run --root .)에서만 로드된다.
// 루트 vitest.config.ts는 test.projects 인라인 객체를 쓰므로 이 파일을 흡수하지 않는다.
import { defineConfig } from 'vitest/config';

// v8 커버리지 계측은 JS 실행을 크게 느리게 만든다(마이크로벤치의 벽시계 측정을 무의미하게 함).
// --coverage 유무를 테스트 환경에 전달해, WT-M1-04 토큰 성능 스모크의 100ms 단언이
// 계측 없는 실측 실행(`pnpm --filter @wt/shared test`)에서만 강제되도록 한다.
const coverageEnabled = process.argv.includes('--coverage');

export default defineConfig({
  test: {
    env: { WT_VITEST_COVERAGE: coverageEnabled ? '1' : '0' },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 실행 코드가 있는 판정 엔진만 계측. 타입 전용 파일(types/**, protocol/messages.ts)·배럴(index.ts)은 제외.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/types/**', 'src/protocol/messages.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
