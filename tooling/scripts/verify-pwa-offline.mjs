#!/usr/bin/env node
// spec: docs/03 §8.4(PWA/오프라인 — "오프라인 동작 범위: 싱글 3모드 + 데일리 연습 플레이 가능"),
//       WT-M5-01 세션 특이 조정("E9 사전 수동 검증(SW 오프라인 완주)은 WT-M5-05 E9가 자동화 —
//       여기서는 SW 등록/청크 구성/size-limit까지"). 이 스크립트는 그 "사전 수동 검증"을
//       Playwright 스크린샷 자동 저장으로 대체한다(전체 완주 흐름까지는 WT-M5-05 몫 —
//       여기서는 "SW가 실제로 등록되고, 오프라인에서도 앱 셸이 브라우저 오류 페이지 대신
//       정상 렌더된다"만 확인).
//
// 실행: `pnpm build`(apps/web/dist) 이후 `node tooling/scripts/verify-pwa-offline.mjs`(저장소
// 루트 기준). e2e 워크스페이스가 설치해둔 @playwright/test를 재사용한다 — 별도 브라우저 설치
// 불필요. Node ESM의 상대 경로 실행은 "이 스크립트 파일 위치" 기준으로 node_modules를 탐색하므로
// (cwd가 아니라) createRequire로 e2e/package.json 기준 스코프를 명시해 우회한다.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { chromium } = createRequire(path.join(REPO_ROOT, 'e2e', 'package.json'))('@playwright/test');
// wrangler dev(e2e:dev) 대상 — vite preview(백엔드 없음)가 아니라 실제 배포 토폴로지와 등가인
// 서버(D37)를 써야 세션 부트스트랩·SW 등록이 프로덕션과 동일하게 재현된다(check-lighthouse.mjs
// 와 동일 취지, 최종 보고 escalations 참조).
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
          else setTimeout(poll, 300);
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
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('[pwa-offline] wrangler dev(e2e:dev) 기동…');
  const server = spawn('pnpm', ['--filter', '@wt/api', 'run', 'e2e:dev'], {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stderr.write(`[e2e:dev] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[e2e:dev] ${d}`));

  let browser;
  try {
    await waitForServer(BASE_URL, 60_000);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    // SW 등록 완료까지 대기(registerType:'prompt'라도 초기 등록 자체는 즉시 일어난다).
    const swState = await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg?.active?.state ?? null;
      },
      null,
      { timeout: 15_000 },
    );
    console.log(`[pwa-offline] SW 등록 확인: active.state = ${await swState.jsonValue()}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'pwa-01-sw-registered.png'), fullPage: true });

    // [중요] 최초 진입 시점엔 SW가 아직 이 탭을 제어하지 않는다(등록은 백그라운드에서 진행) —
    // clientsClaim으로 위 activated 확인 직후 즉시 클레임되긴 하지만, 그 "최초 진입" 자체의
    // 리소스 요청(예: /data/countries.json)은 이미 SW 개입 없이 순수 네트워크로 끝난 뒤라
    // runtime CacheFirst 캐시("wt-countries-data")에 아무것도 담기지 않는다. 그래서 온라인
    // 상태에서 한 번 더 새로고침해 "이제부터 이 탭의 모든 요청을 SW가 가로채는" 상태에서 실제로
    // 캐시를 예열한 뒤에야 오프라인 재진입을 검증하는 것이 올바른 시나리오다(실제 사용자도
    // "한 번 방문 → 이후 오프라인" 흐름이지, "무방문 상태로 바로 오프라인"은 PWA 일반의
    // 전제가 아니다).
    await page.reload({ waitUntil: 'networkidle' });
    console.log('[pwa-offline] 온라인 예열 새로고침 완료(SW가 이제부터 이 탭의 요청을 가로챈다).');

    page.on('console', (msg) => console.log(`[page console] ${msg.type()}: ${msg.text()}`));
    page.on('requestfailed', (req) =>
      console.log(`[page requestfailed] ${req.url()} — ${req.failure()?.errorText}`),
    );

    // 오프라인 전환 후 재방문 — precache/runtime 캐시된 앱 셸·데이터가 브라우저 오프라인 오류
    // 페이지 대신 정상 렌더돼야 한다.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 20_000 });
    console.log(`[pwa-offline] 오프라인 reload page url = ${page.url()}`);

    await page.waitForSelector('[data-testid="home-page"]', { timeout: 15_000 });
    console.log('[pwa-offline] 오프라인 재로드에서도 홈 화면 렌더 확인.');
    await page.screenshot({ path: path.join(OUT_DIR, 'pwa-02-offline-home.png'), fullPage: true });

    await context.setOffline(false);
    console.log('[pwa-offline] PASS');
  } finally {
    await browser?.close();
    killTree(server);
  }
}

main().catch((err) => {
  console.error('[pwa-offline] FAIL', err);
  process.exitCode = 1;
});
