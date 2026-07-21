// spec: docs/03 §4.1(라우트: /play/:mode/:trackId → GamePage), §4.2(GamePage phase FSM),
//       docs/01 §10.2(S5 보딩패스→S6 인게임), WT-M2-08.
//
// E2E 공용 내비게이션·동기화 헬퍼. 임의 sleep 없이 expect 폴링으로만 상태 전이를 기다린다
// (WT-M2-08 제약). 게임 URL 직접 진입은 언어 게이트(HomePage 전용)를 거치지 않으므로 E2~E4는
// 여기로 바로 들어간다(locale ko-KR로 settings.lang=ko 확정 — playwright.config use.locale).

import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';

export interface GameHandles {
  cdp: CDPSession;
  promptMount: Locator;
}

/** 게임 URL로 직접 진입해 보딩패스(phase idle)까지 대기. */
export async function gotoBoarding(page: Page, mode: string, trackId: string): Promise<void> {
  await page.goto(`/play/${mode}/${trackId}`);
  await expect(page.getByTestId('boarding-pass')).toBeVisible();
}

/** 보딩패스를 탭해 카운트다운→플레이 진입, 첫 국가 프롬프트가 나타날 때까지 대기. */
export async function departAndAwaitPlaying(page: Page): Promise<Locator> {
  await page.getByTestId('boarding-card').click();
  const promptMount = page.getByTestId('prompt-mount');
  // 카운트다운(3s) 이후 첫 국가(index 0)가 제시되면 prompt-mount에 국가명이 채워진다.
  await expect(promptMount).not.toBeEmpty({ timeout: 20_000 });
  return promptMount;
}

/**
 * 게임 진입 원스톱: 보딩 → 플레이 → CDP 세션 확보. Chromium 전용(CDP IME).
 */
export async function enterGame(page: Page, mode: string, trackId: string): Promise<GameHandles> {
  await gotoBoarding(page, mode, trackId);
  const promptMount = await departAndAwaitPlaying(page);
  const cdp = await page.context().newCDPSession(page);
  await focusHiddenInput(page);
  return { cdp, promptMount };
}

/** hidden input에 포커스를 보장한다(CDP imeSetComposition은 포커스된 요소를 대상으로 한다). */
export async function focusHiddenInput(page: Page): Promise<void> {
  await page.getByTestId('hidden-typing-input').evaluate((el) => (el as HTMLInputElement).focus());
}

/** prompt-mount가 name을 표시할 때까지 대기(국가 전환 동기화). */
export async function awaitPrompt(promptMount: Locator, name: string): Promise<void> {
  await expect(promptMount).toHaveText(name);
}
