#!/usr/bin/env node
// spec: docs/03 §8.5(성능 예산 — "LCP(홈, Moto G4급) < 2.5s: Lighthouse CI(threshold assert)"),
//       WT-M5-01 세션 특이 조정("로컬에서 lhci 구성이 과도하면 Playwright Chromium 기반
//       프로그램적 Lighthouse 실행 … LCP<2.5s를 실측하고, ci.yml에는 잡 스텝만 추가").
//
// 실행: `pnpm build`(apps/web/dist)가 이미 끝난 상태에서 `node tooling/scripts/check-lighthouse.mjs`.
// 1) 대상 서버는 `wrangler dev`(workers/api의 e2e:dev — e2e/playwright.config.ts와 동일한
//    "프로덕션 프리뷰(D37) + 단일 오리진" 토폴로지, WT-M3-08 밀폐화 스크립트 재사용)다. 순수
//    `vite preview`(백엔드 없음)를 대상으로 최초 실측했을 때 /api/* 프록시가 전부
//    ECONNREFUSED로 실패해(백엔드 부재) 홈 화면의 세션/데일리/리더보드 fetch가 비정상적으로
//    재시도·지연되며 LCP가 예산을 초과하는 비현실적인 결과가 나왔다(최종 보고 escalations
//    참조) — 실제 배포 환경과 등가인 이 토폴로지가 올바른 측정 대상이다.
// 2) e2e가 설치해둔 Playwright Chromium 실행 파일을 새 CLI 설치 없이 재사용한다(chrome-launcher
//    가 그 실행 파일로 헤드리스 크롬을 띄운다).
// 3) lighthouse(홈 '/')를 config 오버라이드 없이 돌린다 — Lighthouse 기본 프리셋 자체가 이미
//    "모바일(Moto G4급 CPU/메모리 스로틀링 + 저속 4G 네트워크 에뮬레이션)"이라 §8.5 문구와
//    그대로 일치한다(desktop 프리셋을 쓰려면 별도 config가 필요하지만 여기선 안 씀).
// 4) `largest-contentful-paint` 감사의 numericValue(ms)가 2500 미만인지 assert하고, 실측치를
//    stdout에 출력한다(최종 보고 detail에 이 숫자를 옮겨 적는다).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8787;
const URL = `http://localhost:${PORT}/`;
const LCP_BUDGET_MS = 2500;

function resolvePlaywrightChromium() {
  const req = createRequire(path.join(REPO_ROOT, 'e2e', 'package.json'));
  const { chromium } = req('@playwright/test');
  return chromium.executablePath();
}

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

/** e2e-dev-server.mjs의 Windows 트리 강제종료 패턴과 동일 — child.kill()만으로는 wrangler dev
 *  아래 workerd 자식이 고아로 남아 포트를 계속 쥔 채 다음 실행을 방해할 수 있다. */
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
  console.log('[lighthouse] wrangler dev(e2e:dev, 프로덕션 등가 토폴로지) 기동…');
  const server = spawn('pnpm', ['--filter', '@wt/api', 'run', 'e2e:dev'], {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stderr.write(`[e2e:dev] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[e2e:dev] ${d}`));

  let chrome;
  try {
    await waitForServer(URL, 60_000);
    console.log('[lighthouse] 서버 응답 확인, Chromium 기동…');

    chrome = await launch({
      chromePath: resolvePlaywrightChromium(),
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    });

    const runnerResult = await lighthouse(URL, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
    });

    const lcp = runnerResult.lhr.audits['largest-contentful-paint'];
    const lcpMs = lcp.numericValue;
    const perfScore = runnerResult.lhr.categories.performance.score;

    console.log(`[lighthouse] LCP = ${lcpMs.toFixed(0)}ms (budget < ${LCP_BUDGET_MS}ms)`);
    console.log(`[lighthouse] performance score = ${(perfScore * 100).toFixed(0)}/100`);

    if (lcpMs >= LCP_BUDGET_MS) {
      throw new Error(
        `LCP 예산 위반: ${lcpMs.toFixed(0)}ms >= ${LCP_BUDGET_MS}ms (docs/03 §8.5)`,
      );
    }
    console.log('[lighthouse] PASS — LCP 예산 내.');
  } finally {
    // Windows에서 chrome-launcher의 임시 프로필 디렉터리 정리가 간헐적으로 EPERM(파일 잠금
    // 해제 지연)을 던진다 — 정리 실패가 위 판정 결과를 가리면 안 되므로 별도로 무시한다.
    try {
      chrome?.kill();
    } catch (err) {
      console.warn('[lighthouse] chrome 정리 경고(무시):', String(err));
    }
    killTree(server);
  }
}

main().catch((err) => {
  console.error('[lighthouse] FAIL', err);
  process.exitCode = 1;
});
