#!/usr/bin/env node
// spec: docs/07 WT-M5-02 세션 특이 조정("'Pixel 7 스크린샷 PR 첨부'는 Playwright Pixel 7
// 에뮬레이션 스크린샷 저장 + notes 경로 기재로 대체"), docs/03 §7.1(키보드 높이 대응 —
// visualViewport, "프롬프트가 항상 키보드 위 중앙"). capture-hero-map-states.mjs와 동일
// 토폴로지·패턴(e2e:dev 재사용, 일회성 진단 스크립트로 CI 게이트 아님).
//
// 헤드리스 Chromium은 실제 OS 소프트 키보드를 띄우지 않는다 — 그래서 Pixel 7 기기 뷰포트로
// 게임 화면에 진입한 뒤, 키보드가 화면 하단 ~40%를 차지했을 때와 등가인 뷰포트 높이로
// setViewportSize를 다시 호출해 시각적으로 동등한 상태를 재현한다(Chromium은 CDP로 뷰포트를
// 바꾸면 window.innerHeight/visualViewport.height가 함께 갱신되고 resize 이벤트가 발사되므로,
// useLayoutMode.ts가 실제 프로덕션 코드 경로 그대로 --vv-height/--vv-offset-top을 갱신한다 —
// 이 스크립트는 훅 로직을 우회하지 않는다).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { chromium, devices } = createRequire(path.join(REPO_ROOT, 'e2e', 'package.json'))(
  '@playwright/test',
);
const PORT = 8787;
const BASE_URL = `http://localhost:${PORT}/`;
const OUT_DIR = path.join(REPO_ROOT, 'e2e', 'artifacts');

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url)
        .then(() => resolve())
        .catch((err) => {
          if (Date.now() > deadline) reject(err);
          else setTimeout(poll, 500);
        });
    })();
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function main() {
  console.log('[capture] wrangler dev(e2e:dev) 기동…');
  const server = spawn('pnpm', ['--filter', '@wt/api', 'run', 'e2e:dev'], {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    await waitForServer(BASE_URL, 60_000);
    const pixel7 = devices['Pixel 7'];
    browser = await chromium.launch();
    const context = await browser.newContext({ ...pixel7, locale: 'ko-KR' });
    const page = await context.newPage();

    await page.addInitScript(() => {
      window.localStorage.setItem('wt:lang', 'ko');
    });

    // 대륙(남미선) 보딩패스까지 직접 진입 → 탭 → 첫 국가 프롬프트가 뜰 때까지.
    await page.goto(`${BASE_URL}play/continent/south-america`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="boarding-pass"]', { timeout: 20_000 });
    await page.getByTestId('boarding-card').click();
    await page.waitForSelector('[data-testid="prompt-mount"]:not(:empty)', { timeout: 20_000 });

    const fullHeight = pixel7.viewport.height;
    const withKeyboardHeight = Math.round(fullHeight * 0.58); // ~42% 키보드 점유 근사(§7.1).

    console.log('[capture] 키보드 미표시(정상 뷰포트) 스크린샷 저장');
    await page.screenshot({ path: path.join(OUT_DIR, 'wt-m5-02-pixel7-no-keyboard.png') });

    console.log('[capture] 뷰포트 축소(소프트 키보드 등가) → --vv-height 갱신 대기');
    await page.setViewportSize({ width: pixel7.viewport.width, height: withKeyboardHeight });
    // useLayoutMode.ts가 window resize를 구독해 --vv-height를 갱신할 때까지 폴링(임의 sleep 없음).
    await page.waitForFunction(
      (expected) =>
        document.documentElement.style.getPropertyValue('--vv-height') === `${expected}px`,
      withKeyboardHeight,
      { timeout: 5_000 },
    );

    await page.screenshot({ path: path.join(OUT_DIR, 'wt-m5-02-pixel7-keyboard-prompt.png') });
    console.log('[capture] 키보드 위 프롬프트 중앙 정렬 스크린샷 저장');
  } finally {
    await browser?.close();
    killTree(server);
  }
}

main().catch((err) => {
  console.error('[capture] FAIL', err);
  process.exitCode = 1;
});
