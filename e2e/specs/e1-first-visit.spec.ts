// spec: docs/03 §10.2 E1(첫 방문 여정: 랜딩→언어 선택→남미선 완주 / 3클릭 내 인게임 도달,
//       12개국 IME 완주, 결과 등급·점수, R 리트라이 2초 내 재개), WT-M2-08.
//
// 한글 IME 재현(CDP)은 Chromium 전용 — WebKit/Firefox에서는 전체 스킵(config에 프로젝트만 정의).

import { expect, test, type Page } from '@playwright/test';
import { typeHangul } from '../helpers/ime';
import { awaitPrompt } from '../helpers/game';

// docs/02 routes.ts ROUTE_SOUTH_AMERICA(12개국, 시작점 CO) — countries.json의 nameKo(§11-D22 canonical).
const SOUTH_AMERICA_KO = [
  '콜롬비아', '베네수엘라', '가이아나', '수리남', '브라질', '파라과이',
  '우루과이', '아르헨티나', '칠레', '볼리비아', '페루', '에콰도르',
];

async function landingToSouthAmerica(page: Page): Promise<void> {
  await page.goto('/');
  // S2 언어 게이트(첫 방문, localStorage 'wt:lang' 부재) → 한국어 선택.
  await expect(page.getByTestId('language-gate')).toBeVisible();
  await page.getByTestId('lang-ko').click();
  // 3클릭: 싱글 → 대륙 → 남미선.
  await page.getByTestId('home-card-single').click();
  await page.getByTestId('mode-card-continent').click();
  await page.getByTestId('track-item-continent-south-america').click();
  await expect(page.getByTestId('boarding-pass')).toBeVisible();
}

test.describe('E1 — 첫 방문 여정', () => {
  test('랜딩→언어 선택→남미선 12개국 IME 완주→결과→R 리트라이 재개', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME 재현은 Chromium 전용(§10.2)');

    await landingToSouthAmerica(page);

    // 보딩패스 탭 → 카운트다운 → 플레이(첫 국가 제시).
    await page.getByTestId('boarding-card').click();
    const promptMount = page.getByTestId('prompt-mount');
    await expect(promptMount).toHaveText(SOUTH_AMERICA_KO[0]!, { timeout: 20_000 });

    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('hidden-typing-input').evaluate((el) => (el as HTMLInputElement).focus());

    // 12개국을 두벌식 IME로 순서대로 완주. 각 국가 제시를 expect 폴링으로 동기화(임의 sleep 없음).
    for (let i = 0; i < SOUTH_AMERICA_KO.length; i++) {
      const name = SOUTH_AMERICA_KO[i]!;
      await awaitPrompt(promptMount, name);
      if (i === 0) {
        // 첫 정답(EXACT) 시 온보딩 자동진행 토스트(role=status aria-live) 1회 — 첫 방문 계정.
        await typeHangul(cdp, name);
        await expect(page.getByTestId('onboarding-toast')).toBeVisible();
      } else {
        await typeHangul(cdp, name);
      }
    }

    // S7 결과: 등급(S/A/B/C/D) + 점수 카드 표시.
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('result-grade')).toHaveText(/[SABCD]/);
    await expect(page.getByTestId('result-card')).toBeVisible();

    // R 리트라이 → 2초 내 카운트다운 재개(RETRY_COUNTDOWN_MS=1500 → 곧바로 game-view 복귀).
    await page.keyboard.press('r');
    await expect(page.getByTestId('game-view')).toBeVisible({ timeout: 2_000 });
    await expect(result).toBeHidden();
  });
});
