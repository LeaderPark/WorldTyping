// spec: docs/03 §10.2 E6(멀티 2인 레이스: 브라우저 컨텍스트 2개 + 모의 WS 서버 — 카운트다운 동시
//       출발, 상대 진행바 보간, 완주 순위 = 서버 result 일치, 클라 표시값이 서버 값으로 대체),
//       docs/05 §12(시퀀스), WT-M4-06. Chromium 전용(CDP IME).
//
// mock-do-server를 beforeAll에서 8899로 띄우고(클라 빌드가 VITE_WS_BASE로 여기에 붙는다) 두 브라우저
// 컨텍스트가 같은 방에서 실제로 타이핑해 레이스를 완주한다. 세트는 mock 기본 2국(몽골·태국)로 짧게.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../mock-do-server';
import { enterRoom, readyUp, awaitRacePrompt, typeCountry, RACE_SET_NAMES } from '../helpers/mp';

const [C0, C1] = RACE_SET_NAMES; // 몽골, 태국

let mock: MockServer;

test.beforeAll(async () => {
  mock = await startMockServer({ port: 8899 });
});
test.afterAll(async () => {
  await mock.close();
});
test.afterEach(() => {
  mock.reset();
});

async function newPlayer(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: 'ko-KR', ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  return { ctx, page };
}

test.describe('E6 — 멀티 2인 레이스 (mock DO)', () => {
  test('동시 출발 · 상대 트랙 보간 · 완주 순위=서버 results · 서버 값 대체', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const ROOM = 'E6RACE';

    const p1 = await newPlayer(browser);
    const p2 = await newPlayer(browser);

    // (1) 두 컨텍스트가 같은 방 대기실 입장(P1 먼저 → 호스트/PLR1). 세션 예산은 enterRoom이 예약.
    await enterRoom(p1.page, ROOM);
    await enterRoom(p2.page, ROOM);
    // 두 슬롯이 채워졌는지(양쪽 join 반영).
    await expect(
      p1.page.locator('[data-testid="waiting-room-slots"] .wt-waiting-slot:not(.wt-waiting-slot--empty)'),
    ).toHaveCount(2);

    // (2) 둘 다 레디 → 서버(mock)가 전원 레디 판정으로 동일 startAt을 브로드캐스트하며 자동 시작.
    await readyUp(p1.page);
    await readyUp(p2.page);

    const cdp1 = await p1.page.context().newCDPSession(p1.page);
    const cdp2 = await p2.page.context().newCDPSession(p2.page);

    // (3) 동시 출발: 양쪽이 같은 첫 국가로 playing 진입(startAt은 mock이 동일값 브로드캐스트).
    await awaitRacePrompt(p1.page, C0);
    await awaitRacePrompt(p2.page, C0);

    // (4) 상대 트랙 보간: P1이 첫 국가를 완주하면 P2 화면의 상대(P1) 트랙 진행이 1로 오른다.
    const oppMetaOnP2 = p2.page.locator('[data-testid^="opponent-track-meta-"]').first();
    await expect(oppMetaOnP2).toContainText(`0 / 2`);
    await typeCountry(cdp1, p1.page, C0, C1); // P1 idx 0→1
    await expect(oppMetaOnP2).toContainText(`1 / 2`);

    // (5) P1이 먼저 전부 완주(rank 1), 이어서 P2 완주(rank 2) → 서버 순위 결정.
    await typeCountry(cdp1, p1.page, C1, null);
    await expect(p1.page.getByTestId('race-finish-wait')).toBeVisible();

    await typeCountry(cdp2, p2.page, C0, C1);
    await typeCountry(cdp2, p2.page, C1, null);

    // (6) 결과: 양쪽 모두 서버 results 표출. 순위=완주 순서(P1 1위, P2 2위), 표시값은 서버 값.
    await expect(p1.page.getByTestId('race-result')).toBeVisible({ timeout: 20_000 });
    await expect(p2.page.getByTestId('race-result')).toBeVisible({ timeout: 20_000 });

    await expect(p1.page.locator('[data-testid="race-result-table"] tbody tr')).toHaveCount(2);
    // 내 행(P1) = 1위 / 내 행(P2) = 2위 (서버 결정 순위).
    await expect(p1.page.locator('.wt-race-result__row--me td').first()).toHaveText('1');
    await expect(p2.page.locator('.wt-race-result__row--me td').first()).toHaveText('2');
    // 서버 값 대체: 완주 시간이 서버 경과(x.xs)로 렌더된다(레이스 중 로컬 표시가 아님).
    await expect(p1.page.getByTestId('race-result-table')).toContainText(/\d+\.\ds/);

    await p1.ctx.close();
    await p2.ctx.close();
  });
});
