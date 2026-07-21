// spec: docs/03 §10.2(E2E 시나리오·CI 매트릭스: Chromium 모든 PR / WebKit·Firefox는 E1·E3만,
//       IME 케이스 제외 — CDP 불가), WT-M2-08.
//
// 한글 IME 재현은 CDP Input.imeSetComposition 에 의존하므로 Chromium 프로젝트에서만 동작한다.
// WebKit/Firefox 프로젝트는 계약대로 config에 정의하되(로컬 필수 실행은 Chromium만 — WT-M2-08
// 세션 조정), IME 스펙은 각 스펙이 browserName!=='chromium'에서 skip 처리한다.
//
// [webServer — 프로덕션 프리뷰 대상] 기본적으로 apps/web을 프로덕션 빌드해 vite preview로 띄운다.
// 이유: apps/web은 <StrictMode>로 감싸여 있는데(main.tsx), vite dev에서는 StrictMode가 이펙트를
// 이중 호출한다. 그 과정에서 useTypingEngine(WT-M2-03)의 `useEffect(()=>teardown)` 정리가
// TypingInputController를 detach한 뒤 재부착되지 않아, dev 빌드에서는 hidden input에 컨트롤러가
// 붙지 않는다(=타이핑 입력이 엔진에 전달되지 않음 — 실측 확인). 프로덕션 빌드는 이펙트 이중
// 호출이 없어 정상 동작하며, E2E가 검증해야 하는 대상도 "실제 배포되는 프로덕션 동작"이다.
// 이 dev-only 이슈는 최종 보고 escalations에 기록했다(useTypingEngine StrictMode-안전성 = WT-M2-03
// 후속 검토 대상). PW_DEV=1 로 dev 서버 경로를 강제할 수 있다(진단용).
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USE_DEV = !!process.env.PW_DEV;
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;
// e2e/package.json 이 "type":"module" 이라 config는 ESM으로 로드된다(__dirname 없음).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const IME_SPECS = ['**/e1-first-visit.spec.ts', '**/e3-miss-skip.spec.ts'];

// 프로덕션 프리뷰: 매 실행 최신 코드로 빌드 후 preview. dev(진단용): vite dev.
const PROD_COMMAND =
  'pnpm --filter @wt/web build && pnpm --filter @wt/web exec vite preview --port 5173 --strictPort';
const DEV_COMMAND = 'pnpm --filter @wt/web run dev -- --port 5173 --strictPort';

export default defineConfig({
  testDir: './specs',
  // IME 조합 타이밍 테스트는 병렬 부하에서 흔들릴 수 있어 직렬 실행(결정성 우선, 스펙 수가 적음).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // "무 flake"를 정직하게 검출하기 위해 재시도 없음 — 실패는 곧바로 드러난다.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'ko-KR', // settings.lang 기본값(detectDefaultLang)을 ko로 → 한글 출제/컨트롤러 ko.
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], locale: 'ko-KR' },
    },
    {
      name: 'webkit',
      testMatch: IME_SPECS,
      use: { ...devices['Desktop Safari'], locale: 'ko-KR' },
    },
    {
      name: 'firefox',
      testMatch: IME_SPECS,
      use: { ...devices['Desktop Firefox'], locale: 'ko-KR' },
    },
  ],
  webServer: {
    command: USE_DEV ? DEV_COMMAND : PROD_COMMAND,
    cwd: REPO_ROOT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
