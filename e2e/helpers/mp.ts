// spec: docs/03 §10.2(E6/E7), docs/05 §6.2(공평한 출발)·§7.2(재접속), WT-M4-06
//
// E6/E7 멀티 스펙 공용 헬퍼. mock-do-server(VITE_WS_BASE로 클라가 직결)를 상대로 실 UI를 구동한다.
// 세션 유발 경로(page.goto → bootLoader 자동 POST /session)는 반드시 reserveSessionSlot()을 거친다
// (E6/E7는 멀티 WS를 mock으로 우회하므로 세션이 실패해도 무해하지만, 스위트 전체의 서버
// 레이트리밋 예산을 정직하게 공유하기 위함 — session-budget.ts).

import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { reserveSessionSlot } from './session-budget';
import { typeHangul } from './ime';

/** mock DEFAULT_SET(['MN','TH'])의 한글 표시명. 세트 순서와 일치해야 한다. */
export const RACE_SET_NAMES = ['몽골', '태국'] as const;

/** 방으로 딥링크 진입 → 대기실 노출까지. (VITE_WS_BASE 빌드에선 RoomPage가 REST 없이 mock 직결.) */
export async function enterRoom(page: Page, code: string): Promise<void> {
  await reserveSessionSlot();
  await page.goto(`/multi/${code}`);
  await expect(page.getByTestId('waiting-room')).toBeVisible({ timeout: 20_000 });
}

/** 레디 토글(누르면 ready=true). */
export async function readyUp(page: Page): Promise<void> {
  await page.getByTestId('waiting-ready-toggle').click();
}

/** 레이스 진입(playing)까지 대기 후 프롬프트 마운트를 반환한다. prompt-mount는 엔진 playing 전이
 *  시점(showCountry(0))에만 채워지므로(currentIndex=-1 during countdown), 이 텍스트 도달 = playing. */
export async function awaitRacePrompt(page: Page, firstName: string): Promise<Locator> {
  await focusRaceInput(page);
  const pm = page.getByTestId('prompt-mount');
  await expect(pm).toHaveText(firstName, { timeout: 20_000 });
  return pm;
}

/** race의 hidden-typing-input에 포커스(CDP imeSetComposition 대상 보장). */
export async function focusRaceInput(page: Page): Promise<void> {
  await page.getByTestId('hidden-typing-input').evaluate((el) => (el as HTMLInputElement).focus());
}

/** 한 국가를 타이핑해 완주(EXACT). nextName이 있으면 다음 국가 전환을, 없으면 개인 결승 대기 화면을 기다린다. */
export async function typeCountry(
  cdp: CDPSession,
  page: Page,
  name: string,
  nextName: string | null,
): Promise<void> {
  await focusRaceInput(page);
  await typeHangul(cdp, name);
  const pm = page.getByTestId('prompt-mount');
  if (nextName) await expect(pm).toHaveText(nextName, { timeout: 15_000 });
}

/** 방의 유일한 사람 플레이어 id(봇 제외). mock은 인-프로세스라 직접 조회한다. */
export function humanPlayerId(room: { players: { playerId: string; isBot: boolean }[] } | undefined): string {
  const p = room?.players.find((pl) => !pl.isBot);
  if (!p) throw new Error('mp.humanPlayerId: no human player in room');
  return p.playerId;
}
