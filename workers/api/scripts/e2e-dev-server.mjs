// spec: WT-M3-08(E2E 밀폐화) — docs/00 §7.1 "migrations apply → 기동" 배포 순서 불변식과 동형.
//
// e2e/playwright.config.ts의 webServer.command가 실행하는 전용 dev 서버 기동 스크립트.
// `pnpm --filter @wt/api run e2e:dev`로만 쓰인다 — 개발자의 수동 `wrangler dev`/`pnpm dev`(기존
// "dev" 스크립트, 기본 .wrangler/state)는 절대 건드리지 않는다(분리 유지, 작업 지시 제약).
//
// 매 호출마다: 전용 persist 디렉터리(.wrangler/e2e-state — KV/D1 로컬 상태 전부 포함)를 통째로
// 삭제→재생성 → D1 마이그레이션 재적용 → 그 디렉터리로 `wrangler dev`를 기동한다. 이렇게 하면
// 이전 실행에서 쌓인 세션 부트스트랩 IP 어뷰즈 카운터·섀도우밴·레이트리밋 키·lb 데이터가
// 절대 다음 pnpm e2e 실행으로 넘어가지 않는다(WT-M3-08 배경 — 반복 실행 시 blk:ip 24h 차단으로
// E1/E4/치트⑥⑦ 전멸했던 실측 결함의 근본 원인).
//
// [WT-M3-08 후속 — 반복 실행 그린 불안정 수정] 리드 감사에서 "즉시 2연속 pnpm e2e" 중 1회
// e4(티어)가 boarding-card 잠금 상태로 90s 타임아웃(클라가 서버를 unreachable로 판단)한 사례가
// 재현됐다. 근본 원인은 persist-dir 리셋 로직 자체가 아니라 **이전 실행의 wrangler dev 프로세스
// 트리가 완전히 죽지 않고 8787을 계속 점유할 수 있다**는 것: Windows에서 Node child_process의
// `child.kill(signal)`은 대상 프로세스 자신만 종료시키고(TerminateProcess), wrangler dev가 그
// 아래에 띄우는 workerd 런타임(실제 포트 바인딩·요청 처리 주체)까지는 전파되지 않는다. 그
// 결과 wrangler dev(node) 프로세스는 죽어도 workerd가 고아 프로세스로 남아 8787을 계속 쥐고
// 있을 수 있고, Playwright의 webServer.reuseExistingServer가 로컬(비-CI)에서는 true였던 탓에
// 다음 `pnpm e2e` 실행이 그 고아 프로세스를 "이미 떠 있는 서버"로 착각해 재사용해 버려
// e2e:dev의 리셋(삭제→재생성→마이그레이션→재기동) 자체를 건너뛰는 경로가 있었다 —
// 그러면 이전 실행의 세션/레이트리밋/섀도우밴 상태가 그대로 남거나, 죽어가는 중인 고아가
// 응답 없이 걸려 있어 클라가 영원히 "loading"에 머문다. 두 가지를 함께 고친다:
//   ① playwright.config.ts: reuseExistingServer를 CI 여부와 무관하게 항상 false로 고정
//      (이 e2e 토폴로지의 존재 이유가 "매 실행 항상 새로 기동"이므로 재사용 자체가 오류).
//   ② 이 스크립트: 기동 "전"에 8787을 점유 중인 프로세스가 있으면 트리 전체를 강제 종료해
//      정리한다(Playwright 쪽 teardown이 이번에도 불완전했더라도 자가 치유). Windows는
//      `taskkill /T /F`(트리 전체), POSIX는 프로세스 그룹 kill을 쓴다.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_API_DIR = path.resolve(HERE, '..');
export const E2E_PERSIST_DIR = path.join(WORKERS_API_DIR, '.wrangler', 'e2e-state');
// wrangler dev 기본 포트(wrangler.toml에 dev.port 미지정) — e2e/playwright.config.ts의
// PORT 상수(8787)와 반드시 일치해야 한다.
const DEV_PORT = 8787;

/**
 * DEV_PORT를 점유 중인 프로세스(직전 실행의 wrangler dev/workerd가 불완전 종료로 남긴 고아 등)를
 * 전부 찾아 트리째 강제 종료한다. 아무것도 없으면(정상 케이스) 조용히 통과한다 — best-effort라
 * 실패해도 이 스크립트 자체를 죽이지 않는다(그다음 wrangler dev 기동이 EADDRINUSE로 실패하면
 * 그때 명확한 에러로 드러난다).
 */
function killPortOwner(port) {
  try {
    if (process.platform === 'win32') {
      const ps = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
        ],
        { encoding: 'utf-8' },
      );
      const pids = [...new Set((ps.stdout ?? '').split(/\s+/).filter((s) => /^\d+$/.test(s)))];
      for (const pid of pids) {
        if (Number(pid) === process.pid) continue;
        process.stderr.write(`[e2e-dev-server] 포트 ${port} 점유 중인 잔여 프로세스(pid ${pid}) 트리 강제 종료\n`);
        spawnSync('taskkill', ['/PID', pid, '/T', '/F']);
      }
    } else {
      const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf-8' });
      const pids = [...new Set((lsof.stdout ?? '').split(/\s+/).filter((s) => /^\d+$/.test(s)))];
      for (const pid of pids) {
        if (Number(pid) === process.pid) continue;
        process.stderr.write(`[e2e-dev-server] 포트 ${port} 점유 중인 잔여 프로세스(pid ${pid}) 강제 종료\n`);
        try {
          process.kill(-Number(pid), 'SIGKILL'); // 프로세스 그룹째
        } catch {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            /* 이미 종료됨 — 무시 */
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[e2e-dev-server] killPortOwner 경고(무시하고 계속): ${String(err)}\n`);
  }
}

function resolveWranglerBin() {
  // workers/api 관점의 require라야 그 패키지의 devDependency(wrangler)를 찾는다.
  const req = createRequire(path.join(WORKERS_API_DIR, 'package.json'));
  const pkgJsonPath = req.resolve('wrangler/package.json');
  const pkg = req('wrangler/package.json');
  return path.join(path.dirname(pkgJsonPath), pkg.bin.wrangler);
}

function resetPersistDir() {
  fs.rmSync(E2E_PERSIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(E2E_PERSIST_DIR, { recursive: true });
}

function applyMigrations(wranglerBin) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, 'd1', 'migrations', 'apply', 'wt-main-dev', '--local', '--persist-to', E2E_PERSIST_DIR],
    { cwd: WORKERS_API_DIR, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.stderr.write(`[e2e-dev-server] migrations apply 실패 (exit ${result.status})\n`);
    process.exit(result.status ?? 1);
  }
}

function startDevServer(wranglerBin) {
  // POSIX: 새 프로세스 그룹의 리더로 띄워, 종료 시 그룹째(-pid) 죽여 wrangler dev가 내부적으로
  // 띄우는 workerd 등 자식까지 함께 정리한다. Windows는 프로세스 그룹 개념이 달라
  // taskkill /T(트리)로 대신한다(아래 forward()).
  const child = spawn(process.execPath, [wranglerBin, 'dev', '--persist-to', E2E_PERSIST_DIR], {
    cwd: WORKERS_API_DIR,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  const forward = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // child.kill(signal)은 Windows에서 대상 프로세스 자신만 종료시키고 wrangler dev 아래의
      // workerd 자식까지는 전파되지 않아 고아로 남을 수 있다(포트 점유 잔존 → 다음 실행이
      // 이를 "이미 뜬 서버"로 오인하는 근본 원인이었다) — 트리 전체를 강제 종료한다.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-child.pid, signal); // 프로세스 그룹째
      } catch {
        child.kill(signal);
      }
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code ?? 0;
    }
  });
}

process.stderr.write(`[e2e-dev-server] 잔여 포트 점유 프로세스 정리: ${DEV_PORT}\n`);
killPortOwner(DEV_PORT);
process.stderr.write(`[e2e-dev-server] persist dir 초기화: ${E2E_PERSIST_DIR}\n`);
resetPersistDir();
const wranglerBin = resolveWranglerBin();
applyMigrations(wranglerBin);
process.stderr.write('[e2e-dev-server] migrations 적용 완료 — wrangler dev 기동\n');
startDevServer(wranglerBin);
