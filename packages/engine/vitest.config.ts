// spec: WT-M2-01 세션 어댑테이션 — @wt/engine 커버리지 게이트(line 95%+, shared와 동일 방식).
// 이 파일이 있어야 `pnpm --filter @wt/engine test`(=vitest run --root .)가 저장소 루트의
// vitest.config.ts(test.projects 워크스페이스 설정)로 config 탐색이 올라가 전 워크스페이스를
// 실행해버리는 문제 없이, 이 패키지 자신의 root로 독립 실행된다(shared/data/moderation 동일 이유).
//
// 기본 환경은 node. IME 컨트롤러 테스트만 파일 상단 `// @vitest-environment jsdom`으로
// 브라우저 DOM을 켠다(합성 이벤트 dispatch용). 루트 vitest.config.ts의 engine 프로젝트도
// environment:'node'이므로 동일한 파일 단위 override가 루트 `pnpm test`에서도 적용된다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 실행 코드가 있는 파일만 계측. 배럴(index.ts)은 재수출뿐이라 제외.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
