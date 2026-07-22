// spec: docs/03 §10.2(E2E 시나리오·CI 매트릭스: Chromium 모든 PR / WebKit·Firefox는 E1·E3만,
//       IME 케이스 제외 — CDP 불가), WT-M2-08.
//
// 한글 IME 재현은 CDP Input.imeSetComposition 에 의존하므로 Chromium 프로젝트에서만 동작한다.
// WebKit/Firefox 프로젝트는 계약대로 config에 정의하되(로컬 필수 실행은 Chromium만 — WT-M2-08
// 세션 조정), IME 스펙은 각 스펙이 browserName!=='chromium'에서 skip 처리한다.
//
// [webServer — 통합 토폴로지: wrangler dev 단일 오리진] WT-M3-06부터는 vite preview(정적
// SPA만, 백엔드 없음) 대신 apps/web을 프로덕션 빌드한 뒤 workers/api를 `wrangler dev`로 띄워
// 그 산출물을 서빙한다(wrangler.toml `[assets] directory = "../../apps/web/dist"`,
// `run_worker_first = ["/api/*", ...]`) — SPA와 /api/*가 동일 오리진(8787) 하나에서 나온다.
// D37(프로덕션 프리뷰 대상 확정)의 취지는 그대로 유지한다: 여전히 "빌드 산출물"을 대상으로
// 하고, StrictMode 이펙트 이중 호출 문제(아래 원래 사유)도 프로덕션 빌드라 재현되지 않는다.
// 세션 부트스트랩·runs/start·submit·lb·daily 등 M3 API가 실제로 존재해야 하는 E2E(제출→순위
// →RankPage 노출)라 이 통합이 D37의 자연스러운 확장이다(작업 특이 조정 — 최종 보고 notes 기재).
//
// 원래 사유(참고): apps/web은 <StrictMode>로 감싸여 있는데(main.tsx), vite dev에서는 StrictMode가
// 이펙트를 이중 호출한다. 그 과정에서 useTypingEngine(WT-M2-03)의 `useEffect(()=>teardown)` 정리가
// TypingInputController를 detach한 뒤 재부착되지 않아, dev 빌드에서는 hidden input에 컨트롤러가
// 붙지 않는다(=타이핑 입력이 엔진에 전달되지 않음 — 실측 확인). 이 dev-only 이슈는 최종 보고
// escalations에 기록했다(useTypingEngine StrictMode-안전성 = WT-M2-03 후속 검토 대상).
// PW_DEV=1 로 vite dev 서버 경로를 강제할 수 있다(진단용 — 이 경로는 /api를 vite proxy로
// wrangler dev(8787)에 넘기므로, 별도로 `pnpm --filter @wt/api run dev`가 떠 있어야 한다).
//
// [WT-M3-08 — E2E 밀폐화] 반복 실행 시 wrangler dev의 로컬 영속 상태(.wrangler/state의 KV/D1)에
// 이전 실행 잔재(세션 부트스트랩 IP 어뷰즈 카운터, 섀도우밴, 레이트리밋 키, lb 데이터)가 누적돼
// 두 번째 이후 실행에서 blk:ip 24h 차단으로 E1/E4/치트⑥⑦이 전멸하는 결함이 실측됐다. 그래서
// PROD_COMMAND는 개발자의 수동 `wrangler dev`(기본 .wrangler/state)와 완전히 분리된 전용 persist
// 디렉터리(workers/api/.wrangler/e2e-state)를 매 실행 삭제→재생성→마이그레이션 재적용한 뒤 그
// 디렉터리로 wrangler dev를 기동한다(workers/api/scripts/e2e-dev-server.mjs, "e2e:dev" 스크립트
// — §11-D 배포 순서 불변식 "migrations apply → 기동"과 동형). 이 script 자체가 매 실행 밀폐화를
// 보장하므로 별도의 사전 migrations apply 수동 스텝이 필요 없다(ci.yml도 동일하게 이 스텝을 뺐다).
//
// [후속 수정 — reuseExistingServer는 항상 false] 원래 `!process.env.CI`였던 탓에 로컬(비-CI)
// 실행에서는 true였다. 이 밀폐화 토폴로지의 존재 이유가 "매 pnpm e2e 실행마다 항상 새로
// 리셋된 서버"인데, 직전 실행의 wrangler dev 프로세스 트리가 (특히 Windows에서 workerd 자식
// 프로세스까지) 완전히 종료되지 않고 8787을 붙든 채 남아 있으면 true 설정이 그 잔여 프로세스를
// "이미 뜬 서버"로 오인해 재사용해버려 e2e:dev의 리셋 자체를 건너뛰는 경로가 있었다(리드 감사에서
// 즉시 2연속 실행 중 1회 e4가 boarding-card 잠금 상태로 타임아웃한 사례의 근본 원인). 이제
// e2e-dev-server.mjs가 기동 전 8787 점유 프로세스를 자체적으로 정리하므로 이중 방어가 되지만,
// Playwright 레벨에서도 재사용 자체를 원천 차단해 "항상 이 스크립트가 새로 만든 서버로만 테스트"
// 라는 불변식을 명시적으로 강제한다.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USE_DEV = !!process.env.PW_DEV;
const PORT = USE_DEV ? 5173 : 8787;
const BASE_URL = `http://localhost:${PORT}`;
// e2e/package.json 이 "type":"module" 이라 config는 ESM으로 로드된다(__dirname 없음).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const IME_SPECS = ['**/e1-first-visit.spec.ts', '**/e3-miss-skip.spec.ts'];

// 통합 토폴로지: 매 실행 최신 코드로 SPA를 빌드한 뒤 wrangler dev(단일 오리진, 기본 8787)로
// 서빙한다. "e2e:dev"(위 밀폐화 스크립트)가 dev 서버를 기동한다 — 개발자의 평소 "dev" 스크립트와는
// 다른 명령이다. dev(진단용): vite dev(/api는 vite.config.ts 프록시로 8787에 전달, 밀폐화 없음).
const PROD_COMMAND = 'pnpm --filter @wt/web build && pnpm --filter @wt/api run e2e:dev';
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
    // E6/E7 mock-do-server는 자체서명 WSS(8899)로 뜬다(CSP connect-src가 ws:는 막고 wss:는 허용).
    // 이 인증서를 수용하려면 컨텍스트가 HTTPS 오류를 무시해야 한다. E1~E4(HTTP 동일오리진)엔 무영향.
    ignoreHTTPSErrors: true,
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
    // WT-M4-06: 웹 빌드에 VITE_WS_BASE를 심어 멀티 클라가 WS만 e2e mock-do-server(8899)로 붙게 한다.
    // E1~E4는 /multi를 방문하지 않아 이 값이 무해하게 무시된다(WS 연결 자체가 없음). E6/E7 스펙이
    // beforeAll에서 이 포트로 mock을 띄운다. 프로덕션 빌드는 이 env 없이 돌아 경로가 불변이다.
    env: { ...process.env, VITE_WS_BASE: 'wss://localhost:8899' } as Record<string, string>,
    url: BASE_URL,
    // 항상 false — 위 "후속 수정" 주석 참조(로컬 재사용이 밀폐화 리셋을 건너뛰게 하는 경로였다).
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
