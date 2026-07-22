// spec: docs/03 §10.2 E7(재연결: 레이스 중 WS 강제 절단 → 백오프 재연결 → resume 스냅샷, 관전 전환
//       UI, 중복 seq 폐기), docs/05 §7.2(grace/resume/race-sync)·§5(idx-1 멱등)·§13-F1/F2, WT-M4-06.
//       Chromium 전용(CDP IME).
//
// 사람 1인 + mock 스케줄 봇 1로 레이스를 RACING까지 올린 뒤 mock이 사람의 WS를 강제 절단한다.
// (A) grace 내 재접속 → race-sync 복원 + 중복 complete(idx-1) 서버 폐기, (B) grace 만료 → 관전.

import { test, expect } from '@playwright/test';
import { startMockServer, type MockServer } from '../mock-do-server';
import { enterRoom, readyUp, awaitRacePrompt, typeCountry, humanPlayerId, RACE_SET_NAMES } from '../helpers/mp';

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

test.describe('E7 — 재연결/관전 (mock DO)', () => {
  test('강제 절단 → grace 내 재연결 → race-sync 복원 + 중복 complete 서버 폐기', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const ROOM = 'E7RESUME';

    await enterRoom(page, ROOM);
    // 사람이 붙은 뒤 2번째 레이서로 스케줄 봇을 넣어 전원 레디 자동 시작을 성립시킨다.
    mock.scheduleBot(ROOM, { nickname: 'GHOST', steps: [{ atMs: 6000, idx: 1, combo: 1 }] });
    await readyUp(page);

    const cdp = await page.context().newCDPSession(page);
    await awaitRacePrompt(page, C0);

    // 첫 국가 완주(idx 0→1). 서버 권위 nextIndex=1 확인.
    await typeCountry(cdp, page, C0, C1);
    const pid = humanPlayerId(mock.room(ROOM));
    await expect.poll(() => mock.room(ROOM)?.player(pid)?.nextIndex).toBe(1);

    // 강제 절단(grace). 클라는 1006 → 백오프 재연결.
    expect(mock.cutPlayer(ROOM, pid)).toBe(true);

    // 백오프 재연결 완료(mock 측 connState가 grace→connected로 복귀 = 클라가 hello(resume)로 재접속).
    await expect.poll(() => mock.room(ROOM)?.player(pid)?.connState, { timeout: 15_000 }).toBe('connected');
    // race-sync 스냅샷 복원: 서버 권위 nextIndex(1)가 보존되고, 클라는 여전히 idx1(태국)에서 이어친다.
    expect(mock.room(ROOM)?.player(pid)?.nextIndex).toBe(1);
    await expect(page.getByTestId('prompt-mount')).toHaveText(C1, { timeout: 15_000 });
    // 레이스가 여전히 살아있다(관전 강등이 아니라 활성 복귀) — 상대(GHOST) 트랙이 렌더된다.
    await expect(page.locator('[data-testid^="opponent-track-meta-"]').first()).toBeVisible();

    // 중복 seq 폐기: 재접속 직후 직전 인덱스(0) complete가 재도착해도 서버가 멱등 폐기(nextIndex 불변).
    expect(mock.injectComplete(ROOM, pid, 0)).toBe(true);
    expect(mock.room(ROOM)?.player(pid)?.nextIndex).toBe(1);
    expect(mock.room(ROOM)?.player(pid)?.ignoredDupCompletes).toBe(1);
    // (재연결 후 완주→결과 렌더는 E6이 커버한다. E7은 재연결/resume/중복폐기 계약만 검증한다.)
  });

  test('강제 절단 → grace 만료 후 재접속 → 관전 모드', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const ROOM = 'E7SPEC';

    await enterRoom(page, ROOM);
    mock.scheduleBot(ROOM, { nickname: 'GHOST', steps: [{ atMs: 9000, idx: 1 }] });
    await readyUp(page);

    const cdp = await page.context().newCDPSession(page);
    await awaitRacePrompt(page, C0);
    await typeCountry(cdp, page, C0, C1); // idx1까지 진행해둔다

    const pid = humanPlayerId(mock.room(ROOM));
    // grace 만료(=즉시 left) 시나리오로 절단 → 재접속은 관전으로 강등(§7.2-4).
    expect(mock.cutPlayer(ROOM, pid, { expire: true })).toBe(true);

    // 재접속 후 관전 배지 노출(입력 채널 없음, 트랙만).
    await expect(page.getByTestId('spectator-badge')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('race-spectator')).toBeVisible();
  });
});
