// spec: docs/00 §11-D69(프롬프트 자모 슬롯·일치/불일치 색)·D70(입력 버퍼 소유권·재삽입 처리),
//       docs/03 §2.5(EXACT 플러시)·§2.10 #4(확정 직후 첫 타 유실 없음), WT-DC-09.
//
// WT-DC-09 입력 재작업의 관측 가능한 계약을 인게임에서 검증한다(단위 수준 재삽입/기저붕괴 기전은
// packages/engine/input-controller.test.ts vitest가 담당 — CDP엔 실 IME 자모 재삽입이 없으므로).
// (i) 조합 중 EXACT 자동 확정 직후 hidden input 버퍼가 비고 다음 국가 글리프가 전원 pending.
// (ii) 조합 중 ESC 스킵이 남긴 잔여를 다음 국가 setCountry가 권위적으로 비운다(유령 miss 없음).
// (iii) ko 자모 채움 행(.wt-jamo[data-fill]) + 일치=var(--text)/불일치=#ef4444 색.
// 남미선 index 0 "콜롬비아"→"베네수엘라"로 e2/e3와 동일 경로. Chromium 전용(CDP IME).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { setComposition, typeHangul } from '../helpers/ime';
import { enterGame } from '../helpers/game';

/** hidden input의 현재 value(버퍼 잔여 검증용). */
function hiddenInput(page: Page): Locator {
  return page.getByTestId('hidden-typing-input');
}

test.describe('E9b — 입력 재작업(D69 자모 슬롯 · D70 버퍼 소유권)', () => {
  test('(i) 조합 중 EXACT 직후 입력 버퍼가 비고 다음 국가 글리프가 전원 pending·오류 0', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    await typeHangul(cdp, '콜롬비아'); // 조합 중 EXACT 자동 확정 → 다음 국가로 전환
    await expect(promptMount).toHaveText('베네수엘라');

    // §2.5 flush + D70 재삽입 방어: 확정 직후 버퍼는 비어 있다.
    await expect(hiddenInput(page)).toHaveValue('');
    // 새 국가 글리프: 오류(is-error) 0 + 전원 pending(잔여 에코 없음).
    await expect(promptMount.locator('.wt-unit.is-error')).toHaveCount(0);
    const states = await promptMount.evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>('.wt-unit')).map((u) => u.dataset.state ?? null),
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === 'pending')).toBe(true);
  });

  test('(ii) 조합 중 ESC 스킵 후 다음 국가는 빈 버퍼·에코 잔여 없음·유령 miss 없음', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    // 조합 중 'ㅂ'(콜롬비아와 어긋나는 자모) 입력 후 ESC 스킵.
    await setComposition(cdp, 'ㅂ');
    await page.keyboard.press('Escape');
    await expect(promptMount).toHaveText('베네수엘라'); // 다음 국가로 전진

    // D70 권위적 클리어: 버퍼가 비고, 새 국가 글리프에 잔여 에코/오류가 없다(유령 miss 없음).
    await expect(hiddenInput(page)).toHaveValue('');
    await expect(promptMount.locator('.wt-unit.is-error')).toHaveCount(0);
    const echoed = await promptMount.evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>('.wt-unit')).map((u) => u.textContent ?? ''),
    );
    expect(echoed.every((t) => t === '')).toBe(true); // 에코 글리프 전부 빈 문자(잔여 없음)
    await expect(promptMount).not.toHaveClass(/wt-prompt--shake/); // 셰이크(유령 miss) 부재
  });

  test('(iii) ko 자모 슬롯 채움 + 일치=var(--text)/불일치=#ef4444 색', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');
    const firstSlot = promptMount.locator('.wt-slot').first();

    // '코'(ㅋㅗ) = '콜'(ㅋㅗㄹ)의 접두 2자모 → 첫 슬롯 자모 match 2 + empty 1.
    await setComposition(cdp, '코');
    await expect(firstSlot.locator('.wt-jamo[data-fill="match"]')).toHaveCount(2);
    await expect(firstSlot.locator('.wt-jamo[data-fill="empty"]')).toHaveCount(1);

    // '코' 글리프는 done. done 색 == var(--text)(테마 자동, 원색 아님).
    await expect(firstSlot.locator('.wt-unit')).toHaveAttribute('data-state', 'done');
    const done = await promptMount.evaluate((mount) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      mount.appendChild(probe);
      const textRgb = getComputedStyle(probe).color;
      probe.remove();
      const glyph = mount.querySelector<HTMLElement>('.wt-unit[data-state="done"]')!;
      return { textRgb, doneRgb: getComputedStyle(glyph).color };
    });
    expect(done.doneRgb).toBe(done.textRgb); // 일치색 = var(--text)

    // 오입력 '콥'(ㅋㅗㅂ) — ㅂ이 '콜'의 ㄹ과 불일치 → 첫 슬롯 error 자모 1 + 글리프 is-error(#ef4444).
    await setComposition(cdp, '콥');
    await expect(firstSlot.locator('.wt-jamo[data-fill="error"]')).toHaveCount(1);
    await expect(promptMount.locator('.wt-unit.is-error')).toHaveCount(1);
    const errRgb = await promptMount.evaluate(
      (mount) => getComputedStyle(mount.querySelector<HTMLElement>('.wt-unit.is-error')!).color,
    );
    expect(errRgb).toBe('rgb(239, 68, 68)'); // #ef4444
  });
});
