// spec: docs/03 §10.2 E4(서바이벌: 티어 T1 진입→방치→타임아웃 라이프 차감→라이프 0→부분 점수
//       결과, 미완주 상한 B / 게이지·하트 UI), docs/01 §7.1(티어 라이프 3·타임아웃=자동 스킵 −1)·
//       §7.2(국가당 제한시간), docs/00 §11-D27, WT-M2-08.
//
// 타이핑 없이 "방치"만으로 국가당 제한시간이 소진되며 라이프가 3→0으로 깎이는지 검증한다
// (임의 sleep 없이 hud-lives/result-view 를 expect 폴링). 첫 국가는 ×2 배수(§7.2)라 첫
// 타임아웃이 가장 길다. Chromium 필수(WebkKit/FF 프로젝트는 이 스펙을 매치하지 않음).

import { expect, test } from '@playwright/test';
import { gotoBoarding, departAndAwaitPlaying } from '../helpers/game';

test.describe('E4 — 서바이벌(티어 T1)', () => {
  test('방치→게이지 소진→라이프 차감→라이프 0→부분 점수·등급 상한 B', async ({ page }) => {
    await gotoBoarding(page, 'tier', '1');
    await departAndAwaitPlaying(page);

    // 하트 3개 + 국가당 게이지(서바이벌 전용 UI).
    const lives = page.getByTestId('hud-lives');
    await expect(lives).toHaveText('♥♥♥');
    await expect(page.getByTestId('time-limit-gauge')).toBeVisible();

    // 방치 → 첫 국가 제한시간(×2) 소진 → 자동 스킵 → 라이프 −1 (3→2).
    await expect(lives).toHaveText('♥♥', { timeout: 25_000 });

    // 계속 방치 → 라이프 0 → 게임오버(부분 점수) 결과 화면.
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 40_000 });

    // 미완주(게임오버): 결과 카드 outcome = "라이프 소진", 등급 상한 B(= S/A 불가 → B/C/D).
    await expect(page.getByTestId('result-grade')).toHaveText(/[BCD]/);
    await expect(page.getByTestId('result-card')).toContainText('라이프 소진');
  });
});
