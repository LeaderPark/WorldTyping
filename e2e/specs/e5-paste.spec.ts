// spec: docs/03 §10.2 E5(붙여넣기 부정: clipboard로 정답 삽입 → bulkInsert 차단 + "연습 기록"
//       라벨), §2.4(BULK_INSERT_MAX_ADDED — 스냅샷 added>8 자모 강등 신호), docs/07 WT-M5-05
//       구현 세부 지시("e5 붙여넣기 스펙 … clipboard 정답 삽입 → bulkInsert 차단 + '연습 기록'
//       라벨").
//
// [실제 네이티브 paste 경로를 쓰는 이유] packages/engine/src/input-controller.ts의 방어 코드는
// beforeinput의 inputType==='insertFromPaste'를 검사한다(§2.7). 이 inputType은 브라우저가 진짜
// 붙여넣기(신뢰된 이벤트)를 처리할 때만 채워진다 — page.evaluate로 합성 ClipboardEvent를
// dispatchEvent하면 isTrusted:false라 브라우저의 네이티브 붙여넣기 기본 동작(따라서 beforeinput
// insertFromPaste 발생) 자체가 트리거되지 않는다. 그래서 이 스펙은 실제
// navigator.clipboard.writeText + 신뢰된 Ctrl+V 키 입력(Playwright CDP 경유라 isTrusted:true)으로
// 진짜 붙여넣기 파이프라인을 재현한다. Chromium에서만 클립보드 권한 부여·재현이 안정적이라
// Chromium 전용(§10.2 E1/E3와 동일 방침 — webkit/firefox 프로젝트는 어차피 testMatch로 이 파일을
// 실행하지 않는다, e2e/playwright.config.ts IME_SPECS 참조).
import { expect, test } from '@playwright/test';
import { enterGame, focusHiddenInput } from '../helpers/game';
import { seedSharedDeviceId } from '../helpers/identity';

test.describe('E5 — 붙여넣기 부정', () => {
  test('clipboard 정답 붙여넣기 → 입력 미반영(차단) + 완주 후 "연습 기록" 라벨', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Clipboard 권한 재현은 Chromium 전용');

    // 세션 예산(helpers/identity.ts) — E5/E8/E9가 고정 deviceId를 공유해 서버의 시간당 신규 pid
    // 상한(20/IP) 소모를 아낀다.
    await seedSharedDeviceId(page);
    const { promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    // 페이지가 이미 떠 있어야 오리진이 확정되므로 enterGame 이후에 권한을 부여한다.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
    await page.evaluate((text) => navigator.clipboard.writeText(text), '콜롬비아');
    await focusHiddenInput(page);
    await page.keyboard.press('Control+V');

    // 차단 확인: beforeinput(insertFromPaste)이 preventDefault되어 hidden input의 실제 value에
    // 붙여넣은 텍스트가 전혀 반영되지 않는다 — 자동 완주(EXACT)도 일어나지 않는다.
    await expect(page.getByTestId('hidden-typing-input')).toHaveValue('');
    await expect(promptMount).toHaveText('콜롬비아');

    // 나머지는 ESC 스킵으로 완주(12개국 전부 미해결 — degrade('bulk')가 이미 걸렸는지만 본다).
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Escape');
    }
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });

    // session.ts degrade('bulk') → practice=true → useRunSubmit이 네트워크 없이 즉시 practice
    // 라벨을 표시한다(docs/06 §3.1, ResultView.tsx verdict==='practice').
    await expect(page.getByTestId('result-verdict-label')).toHaveText('연습 기록');
  });
});
