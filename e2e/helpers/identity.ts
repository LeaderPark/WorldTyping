// spec: workers/api/src/routes/session.ts(NEW_PID_ABUSE_MAX=20/시간당 IP, blk:ip 24h 차단),
//       docs/04 §10.3(남용 방지), docs/07 WT-M5-05.
//
// [세션 예산 — 신규 사용자(pid) 상한, 실측 발견] Playwright는 스펙(파일)마다 격리된 브라우저
// 컨텍스트를 새로 발급한다. apps/web/src/stores/settings.ts의 readOrCreateDeviceId()는
// localStorage('wt:did')가 비어 있으면 새 UUID를 만든다 — 이 값이 서버의 pid 파생 입력이라,
// "새 컨텍스트 = 새 pid"가 스펙마다 반복된다. 로컬 wrangler dev는 CF-Connecting-IP 헤더가 없어
// 모든 요청이 동일한 ipHash(sha256("unknown"))를 공유하므로(workers/api/src/lib/ip-hash.ts),
// `pnpm e2e` 1회 연속 실행에서 스위트 전체의 "신규 pid 생성" 총량이 누적된다.
//
// 실측(이 작업 세션에서 로컬 KV를 직접 조회해 확인): 이 작업 이전부터 있던 스펙만으로 이미
// 시간당 상한(20/IP, workers/api/src/routes/session.ts NEW_PID_ABUSE_MAX)에 정확히 도달해 있다
// (cheat-suite 8종이 시나리오 격리를 위해 매번 신규 deviceId를 쓰는 설계 + 각 브라우저 기반
// 스펙의 신규 컨텍스트가 누적). E5/E8/E9가 고정 deviceId를 공유해도(아래 seedSharedDeviceId)
// 최소 1회는 "신규"로 잡혀 21번째에서 24h IP_BLOCKED가 걸리고, 이후 세션이 필요한 검증(E9의
// 온라인 복귀 후 실제 submit 왕복)이 타임아웃한다.
//
// 이 시간당 상한 자체(임계값)는 안티치트 정책이라 완화 대상이 아니다(작업 지시 원문 "안티치트
// 로직 불변" — NEW_PID_ABUSE_MAX를 바꾸거나 workers/api 코드를 고치는 것은 이 작업 범위 밖이고
// docs/00 §11 신규 결정이 필요해 리드 에스컬레이션 대상, 최종 보고 참조). 대신 이 헬퍼는 순수
// e2e 인프라측에서, forge.ts가 이미 쓰는 것과 동일한 "로컬 wrangler CLI로 e2e 전용 persist
// 디렉터리를 직접 조회"하는 패턴을 재사용해 — 이번 실행에서 쌓인 "신규 pid 카운터"와 그로 인한
// 차단 플래그만 리셋한다(서버 코드·임계값·다른 스펙의 D1 데이터는 전혀 건드리지 않음). 프로덕션
// 동작에는 영향이 없다 — 이 조작은 로컬 e2e-state KV 파일에만 적용된다.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_API_DIR = path.resolve(HERE, '../../workers/api');
// WT-M3-08 밀폐화 규약과 동일 — e2e-dev-server.mjs가 기동한 wrangler dev와 같은 persist 디렉터리.
const E2E_PERSIST_DIR = path.join(WORKERS_API_DIR, '.wrangler', 'e2e-state');

let cachedWranglerBin: string | undefined;

function resolveWranglerBin(): string {
  if (cachedWranglerBin) return cachedWranglerBin;
  const req = createRequire(path.join(WORKERS_API_DIR, 'package.json'));
  const pkgJsonPath = req.resolve('wrangler/package.json');
  const pkg = req('wrangler/package.json') as { bin: { wrangler: string } };
  cachedWranglerBin = path.join(path.dirname(pkgJsonPath), pkg.bin.wrangler);
  return cachedWranglerBin;
}

function runWranglerKv(args: string[]): string {
  return execFileSync(
    process.execPath,
    [resolveWranglerBin(), 'kv', ...args, '--binding=KV', '--local', `--persist-to=${E2E_PERSIST_DIR}`],
    { cwd: WORKERS_API_DIR, encoding: 'utf-8' },
  );
}

/**
 * 이번 `pnpm e2e` 실행에서 다른 스펙들이 이미 쌓아 둔 "시간당 신규 pid" 카운터와 그로 인한
 * blk:ip 차단 플래그를 지운다(위 파일 상단 주석 — 실측 근거·범위 참조). KV에 해당 키가 아직
 * 없으면(= 아직 상한에 도달하지 않은 정상 실행) delete가 아무 효과 없이 조용히 끝난다.
 */
export async function resetNewPidAbuseCounter(): Promise<void> {
  const ipHash = createHash('sha256').update('unknown').digest('hex');
  try {
    runWranglerKv(['key', 'delete', `blk:ip:${ipHash}`]);
  } catch {
    // 키 부재 등으로 delete가 비0 종료해도 목적(차단 해제) 자체는 이미 달성된 상태 — 무시.
  }
  try {
    const listed = runWranglerKv(['key', 'list', `--prefix=rl:session:new-pid:${ipHash}:`]);
    const keys = (JSON.parse(listed) as Array<{ name: string }>).map((e) => e.name);
    for (const key of keys) {
      try {
        runWranglerKv(['key', 'delete', key]);
      } catch {
        // 개별 삭제 실패는 이 함수의 목적(예산 확보)에 치명적이지 않음 — 계속 진행.
      }
    }
  } catch {
    // 목록 조회 자체가 실패해도(예: KV 네임스페이스가 아직 한 번도 안 쓰였음) 무해 — 무시.
  }
}

/** WT-M5-05 신규 스펙(E5/E8/E9)이 공유하는 고정 deviceId. 이 중 스위트 실행 순서상 가장 먼저
 *  세션을 여는 스펙만 서버에 "신규 pid" 1회로 잡히고, 나머지는 기존 사용자로 재사용된다. */
const SHARED_DEVICE_ID = 'a1f6c8de-5b2a-4e77-9c34-1d6f0a2e7b90';

/**
 * 다음 페이지 로드 전에 호출 — localStorage(wt:did)를 고정값으로 미리 채워 readOrCreateDeviceId()
 * 가 새 UUID를 만들지 않고 이 값을 재사용하게 한다. `page.addInitScript`는 이후의 모든 네비게이션
 * (최초 goto뿐 아니라 reload도)에 적용되므로 첫 네비게이션 이전에 한 번만 호출하면 된다.
 */
export async function seedSharedDeviceId(page: Page): Promise<void> {
  await page.addInitScript((id) => {
    try {
      window.localStorage.setItem('wt:did', id);
    } catch {
      // 사생활 모드 등 접근 불가 환경 — 새로 발급되게 그냥 둔다(무해, 이 헬퍼는 예산 최적화일 뿐
      // 정합성 요구사항이 아니다).
    }
  }, SHARED_DEVICE_ID);
}
