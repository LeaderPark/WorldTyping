#!/usr/bin/env node
// spec: WT-M5-01b acceptance ⑤(D45) — HeroMap Suspense fallback(플레이스홀더)/지도 로드 완료 상태
// 스크린샷을 e2e/artifacts/에 저장한다(수동 확인 항목 대체). check-lighthouse.mjs와 동일 토폴로지
// (e2e:dev — 프로덕션 등가 wrangler dev)를 재사용한다. 일회성 진단 스크립트로, CI 게이트가
// 아니다(수동 산출물 저장 전용).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// e2e 워크스페이스의 @playwright/test를 재사용한다(check-lighthouse.mjs와 동일 패턴 — 별도 설치 없음).
const { chromium } = createRequire(path.join(REPO_ROOT, 'e2e', 'package.json'))('@playwright/test');
const PORT = 8787;
const URL = `http://localhost:${PORT}/`;
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
    await waitForServer(URL, 60_000);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 500, height: 900 } });

    // 언어 게이트가 스크린샷을 가리지 않도록 방문 전 'wt:lang'을 미리 세팅(§4.2 계약과 무관 —
    // 이 스크립트는 히어로 지도 상태 캡처가 목적이라 게이트는 별개 관심사).
    await page.addInitScript(() => {
      window.localStorage.setItem('wt:lang', 'ko');
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // 상태 ①: HeroMap 청크가 아직 도착하지 않은 즉시 페인트 시점(Suspense fallback 또는
    // HeroMap 내부 topology-fetch-중 placeholder) — data-testid="hero-map-loading"가 보이는
    // 첫 프레임을 최대한 빨리 캡처한다.
    await page.waitForSelector('[data-testid="hero-map"]', { state: 'attached', timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'wt-m5-01b-hero-placeholder.png') });
    console.log('[capture] placeholder 스크린샷 저장');

    // 상태 ②: 지도가 실제로 로드 완료된 시점(WorldMap의 base 레이어 폴리곤이 렌더).
    await page.waitForSelector('[data-testid="hero-map"] [data-country]', { timeout: 15_000 });
    // 레이아웃 안정화를 위해 한 프레임 더 기다린다.
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT_DIR, 'wt-m5-01b-hero-loaded.png') });
    console.log('[capture] 로드 완료 스크린샷 저장');
  } finally {
    await browser?.close();
    killTree(server);
  }
}

main().catch((err) => {
  console.error('[capture] FAIL', err);
  process.exitCode = 1;
});
