// spec: WT-M2-05 세션 어댑테이션 — @wt/web 커버리지 게이트(line 60%+, CLAUDE.md "그 외 60%").
// 이 파일이 있어야 `pnpm --filter @wt/web test`(=vitest run --root .)가 저장소 루트의
// vitest.config.ts(test.projects 워크스페이스 설정)로 config 탐색이 올라가 전 워크스페이스를
// 실행해버리는 문제 없이, 이 패키지 자신의 root로 독립 실행된다(shared/data/engine/i18n/moderation
// 과 동일 이유).
//
// 기본 환경은 node(순수 로직 테스트가 대다수). DOM/React 렌더가 필요한 테스트 파일만 상단에
// `// @vitest-environment jsdom`으로 개별 override한다(packages/engine의 IME 컨트롤러 테스트와
// 동일 패턴) — 루트 vitest.config.ts의 web 프로젝트도 environment:'node'이므로 동일한 파일
// 단위 override가 루트 `pnpm test`에서도 그대로 적용된다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60,
      },
    },
  },
});
