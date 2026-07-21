// spec: docs/03 §10.2 E2(IME 정밀)·§2.10 #3(조합 중 EXACT — compositionend 미대기)·
//       #4(확정 직후 0ms 다음 국가 첫 타 유실 없음 — epoch 가드), WT-M2-08.
//
// [명명된 예시와 실제 검증 대상] 스펙은 "가나"(도깨비불 간→가나)·"몽골"(마지막 ㄹ 확정)을
// 예시로 든다. 두 국가는 대륙 노선에서 초반에 나오지 않으므로(가나=아프리카 15번째, 몽골=아시아
// 5번째), (1) typeHangul의 조합 스텝 생성기가 이 예시들의 중간 상태를 실제로 거쳐가는지는 순수
// 헬퍼 단위로 직접 검증하고, (2) 동일 메커니즘의 인게임 검증은 남미선 index 0 "콜롬비아"로 한다.
// 콜롬비아는 "콜롬비"+ㅇ→"콜롬빙"→+ㅏ→"콜롬비아"로, 스펙의 간→가나와 정확히 같은 도깨비불
// (speculative 받침→모음 시 이월)을 거친다. Chromium 전용(CDP IME).

import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { composeSteps, setComposition, toJamoSeq, typeHangul } from '../helpers/ime';
import { enterGame } from '../helpers/game';

async function comboText(page: Page): Promise<string> {
  return (await page.getByTestId('combo-badge').textContent()) ?? '';
}

async function errorUnitCount(promptMount: Locator): Promise<number> {
  return promptMount.evaluate(
    (el) => el.querySelectorAll('.wt-unit.is-error').length,
  );
}

test.describe('E2 — IME 정밀', () => {
  test('조합 스텝 생성기가 스펙 예시(간→가나, 몽골 마지막 ㄹ)의 중간 상태를 거친다', () => {
    // §2.10 #1 "가나" 도깨비불: ㄱ→가→간→가나(받침 ㄴ이 다음 음절 초성으로 이월).
    expect(composeSteps([...toJamoSeq('가나')])).toEqual(['ㄱ', '가', '간', '가나']);
    // §2.10 #3 "몽골": 마지막 ㄹ 입력 순간 "몽골"이 완성된다(그 직전은 "몽고").
    const mongol = composeSteps([...toJamoSeq('몽골')]);
    expect(mongol.at(-1)).toBe('몽골');
    expect(mongol.at(-2)).toBe('몽고');
  });

  test('E2a 도깨비불: 오타 카운트 0 (콜롬비아, error class 미출현)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    // 프롬프트 채색: "콜"까지 입력 시 첫 음절이 done(정타), error 없음.
    await setComposition(cdp, '콜');
    await expect(promptMount.locator('.wt-unit').first()).toHaveAttribute('data-state', 'done');
    expect(await errorUnitCount(promptMount)).toBe(0);

    // 나머지를 마저 입력해 완주 → 다음 국가로 자동 전환.
    await typeHangul(cdp, '콜롬비아');
    await expect(promptMount).toHaveText('베네수엘라');

    // 오타 0의 결정적 증거: 확정 시 콤보 +1(오타가 하나라도 있었으면 확정 시점 콤보 0 — GDD §6.1).
    expect(await comboText(page)).toContain('1');
    await expect(page.getByTestId('combo-badge')).not.toHaveClass(/wt-combo--hidden/);
  });

  test('E2b 조합 중 EXACT 자동 확정(compositionend 미대기)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    // typeHangul은 insertText/compositionend를 전혀 보내지 않는다(조합 중 imeSetComposition만).
    // 그럼에도 마지막 자모로 목표가 완성되는 순간 컨트롤러가 스스로 확정 → 다음 국가가 나타난다.
    const t0 = Date.now();
    await typeHangul(cdp, '콜롬비아');
    await expect(promptMount).toHaveText('베네수엘라');
    const dtMs = Date.now() - t0;
    // compositionend 없이 확정됨을 확인. (타이밍은 CDP 왕복·폴링 포함 값이라 기능 검증 위주.)
    console.log(`[E2b] 확정→다음 국가 프롬프트까지 ${dtMs}ms (compositionend 미전송)`);
    expect(dtMs).toBeLessThan(5_000);
  });

  test('E2c 확정 직후 0ms 다음 국가 첫 타 유실 없음(epoch 가드)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount }: { cdp: CDPSession; promptMount: Locator } = await enterGame(
      page,
      'continent',
      'south-america',
    );
    await expect(promptMount).toHaveText('콜롬비아');

    await typeHangul(cdp, '콜롬비아');
    await expect(promptMount).toHaveText('베네수엘라');
    // 확정 직후(다음 국가 제시 즉시) 첫 타를 지연 0으로 발사 — 지연 도착 유령 compositionend가
    // 첫 타를 오염/유실시키지 않아야 한다(§2.10 #4).
    await typeHangul(cdp, '베네수엘라', { firstDelayMs: 0 });
    await expect(promptMount).toHaveText('가이아나');

    // 두 국가 연속으로 오타 없이 확정 → 콤보 2. 첫 타가 유실됐다면 조합이 어긋나 여기 도달 못 함.
    expect(await comboText(page)).toContain('2');
  });
});
