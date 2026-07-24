// spec: docs/03 §10.2 E9(PWA 오프라인: SW 설치 후 오프라인 전환 → 대륙 모드 플레이 → 온라인
//       복귀 제출 큐 / CacheFirst 동작, pendingSubmission flush), §8.4(PWA/오프라인 —
//       navigateFallback, countries.json CacheFirst, /api/* NetworkOnly, pendingSubmission
//       IndexedDB 큐), apps/web/src/net/pending-queue.ts, docs/07 WT-M5-05.
//
// [세션 환경 어댑테이션] "E9: Playwright context.setOffline + SW precache, flush는 온라인 복귀
// 후 실제 API 반영 확인" — 모의 API가 아니라 이 스위트의 실제 wrangler dev(e2e:dev) 서버에
// 대고 검증한다.
//
// [실측 근거 — tooling/scripts/verify-pwa-offline.mjs의 가정을 이 스펙에서 재검증하며 발견]
// `registration.active.state === 'activated'`가 참이어도 `navigator.serviceWorker.controller`는
// 곧바로 채워지지 않는다 — clientsClaim()의 클레임이 이 탭에 실제로 반영되기까지 리로드가 한 번
// 더 필요할 수 있다(실측: 이 저장소의 대륙 보딩 페이지 기준 활성화 확인 직후 리로드 1회로는
// 아직 controller가 비어 있었고, 그 상태의 리로드는 fromServiceWorker()가 전부 false — SW 개입
// 없이 순수 네트워크로 끝나 CacheFirst 캐시가 전혀 채워지지 않았다). 그래서 리로드 직후
// `navigator.serviceWorker.controller`가 채워질 때까지 "확인→필요시 리로드"를 반복해 이 타이밍
// 의존성을 없앤다 — 몇 번째 리로드에서 클레임이 반영되는지는 환경마다 달라질 수 있으므로 결과를
// 직접 폴링하는 편이 특정 리로드 횟수를 하드코딩하는 것보다 견고하다.
//
// [세션 예산 — 신규 pid 상한, 실측 발견 — 최종 보고 escalations 동일 기재] `pnpm e2e` 전체를
// 한 번에 연속 실행하면(로컬 wrangler dev는 CF-Connecting-IP가 없어 전 요청이 동일 ipHash를
// 공유, workers/api/src/lib/ip-hash.ts) 이 스펙 이전의 기존 스펙만으로 이미 서버의 시간당 신규
// pid 상한(20/IP, workers/api/src/routes/session.ts NEW_PID_ABUSE_MAX)에 도달해 있다 — 그 상태의
// 다음 신규 세션 시도(이 스펙 포함 누구든)는 24h IP_BLOCKED로 거절되어 이 스펙의 "온라인 복귀 후
// 실제 submit 왕복" 검증이 불가능해진다. 이 임계값 자체는 안티치트 정책이라 완화 대상이 아니다
// (작업 지시 원문 "안티치트 로직 불변" — workers/api 코드·임계값 변경은 이 작업 범위 밖이며
// docs/00 §11 신규 결정이 필요해 리드 에스컬레이션 대상). 대신 helpers/identity.ts가 forge.ts와
// 동일한 패턴(로컬 wrangler CLI로 e2e 전용 persist 디렉터리 직접 조회)으로 "이번 실행에서 쌓인
// 카운터/차단 플래그"만 리셋한다(서버 코드·임계값·다른 스펙의 D1 데이터는 건드리지 않음 — 상세
// 근거는 helpers/identity.ts 상단 주석). E5/E8과 고정 deviceId를 공유하는 것(seedSharedDeviceId)
// 만으로는 부족함이 실측으로 확인돼(기존 스펙만으로 이미 상한 도달) 이 리셋이 함께 필요하다.
import { expect, test } from '@playwright/test';
import { gotoBoarding } from '../helpers/game';
import { reserveSessionSlot } from '../helpers/session-budget';
import { resetNewPidAbuseCounter, seedSharedDeviceId } from '../helpers/identity';
import { loginAs } from '../helpers/auth';

/** Cache Storage 경합 방지 — CacheFirst의 cache.put()은 event.waitUntil로 응답 반환 뒤에도
 *  계속 진행될 수 있어, "리로드 성공"만으로는 백그라운드 기록 완료를 보장하지 못한다. */
async function countriesCached(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(async () => {
    const cache = await caches.open('wt-countries-data');
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes('/data/countries.json'));
  });
}

test.describe('E9 — PWA 오프라인', () => {
  test('SW 설치 → 온라인 예열 → 오프라인 대륙 완주 → 온라인 복귀 시 실제 API 반영', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'SW/오프라인 재현은 Chromium 전용');

    await resetNewPidAbuseCounter();
    await seedSharedDeviceId(page);
    // [WT-AUTH 이행] 랭킹 게이팅(§11-D68-①)으로 비로그인 제출은 useRunSubmit이 idle로 남겨(제출 보류)
    // ResultView가 result-login-cta를 그린다 — 오프라인 큐 적재("온라인 연결 시 자동 제출됩니다")·
    // 온라인 복귀 후 실제 submit 왕복이 전부 로그인 이후에만 일어난다. 첫 네비게이션(온라인) 이전에
    // 계정 세션을 주입해(helpers/auth.ts, /auth/dev) 로그인 상태로 부팅하면, 오프라인 출발 판은
    // runToken 없이 queueOffline→'queued' 라벨을 그리고, 온라인 복귀 시 flush가 계정 신원으로
    // /runs/start·/runs/submit을 왕복한다(오프라인 큐/flush 자체는 WT-AUTH 이전과 동일 기전).
    await loginAs(page, 'auth-e9');
    await gotoBoarding(page, 'continent', 'south-america'); // 세션 슬롯 1.

    // §8.4 vite-plugin-pwa(registerType:'prompt') — 최초 등록·활성화 자체는 즉시 진행된다.
    await page.waitForFunction(
      async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated',
      null,
      { timeout: 15_000 },
    );

    // 온라인 예열 리로드 반복 — SW가 이 탭을 실제로 통제(controller 확정)하고 countries.json이
    // CacheFirst 캐시에 실제로 적재될 때까지(위 실측 근거 주석 참조). 무한 루프 방지 상한 5회.
    let controlled = false;
    let cached = false;
    for (let attempt = 0; attempt < 5 && !(controlled && cached); attempt++) {
      await reserveSessionSlot(); // 세션 슬롯 N.
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByTestId('boarding-pass')).toBeVisible();
      controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
      if (controlled) {
        cached = await countriesCached(page);
      }
    }
    expect(controlled, 'SW가 이 탭을 통제하지 못했다(controller 미확정)').toBe(true);
    expect(cached, 'countries.json이 CacheFirst 캐시에 적재되지 않았다').toBe(true);

    // 오프라인 전환 후 재진입 — navigateFallback(index.html) + CacheFirst(countries.json)만으로
    // 브라우저 오프라인 오류 페이지 대신 정상 렌더돼야 한다. 네트워크에 닿지 못해 실패하므로
    // session-budget 슬롯을 소비하지 않는다.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 20_000 });
    await expect(page.getByTestId('boarding-pass')).toBeVisible({ timeout: 15_000 });

    // 오프라인 상태로 대륙 모드 완주(로컬 세트 — 네트워크 불필요, useGameSession 참조).
    await page.getByTestId('boarding-card').click();
    const promptMount = page.getByTestId('prompt-mount');
    await expect(promptMount).not.toBeEmpty({ timeout: 20_000 });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Escape');
    }
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });

    // runToken 없이 시작(오프라인 출발, useRunStart→offline-fallback) → useRunSubmit이 즉시
    // pendingSubmission 큐에 적재하고 "온라인 연결 시 자동 제출됩니다" 라벨을 보여준다(§8.4,
    // net/pending-queue.ts enqueuePending).
    await expect(page.getByTestId('result-verdict-label')).toHaveText(
      '온라인 연결 시 자동 제출됩니다',
    );

    // 온라인 복귀(리로드 없음) — bootLoader가 이미 등록한 'online' 리스너(registerPendingQueueAutoFlush)
    // 가 flushPendingQueue()를 유발해 실제 POST /runs/start·/runs/submit이 왕복하는지 확인한다.
    const submitResPromise = page.waitForResponse(
      (res) => res.url().includes('/api/v1/runs/submit') && res.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await context.setOffline(false);
    const submitRes = await submitResPromise;
    expect(submitRes.ok()).toBe(true);
  });
});
