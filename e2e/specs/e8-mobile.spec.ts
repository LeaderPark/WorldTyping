// spec: docs/03 §10.2 E8(모바일 뷰포트 Pixel 7 에뮬레이션: 보딩패스 탭→키보드 유지→완주 /
//       visualViewport 레이아웃, 스킵 버튼, hidden input 포커스 유지), §7.1(useLayoutMode — 폭
//       기반 모드 판정 + visualViewport CSS 변수), §7.2(모바일 입력 — 첫 포커스는 반드시 제스처
//       핸들러 안에서 동기 focus, pointerdown 재포커스, 스킵은 화면 우하단 고정 버튼),
//       docs/07 WT-M5-05.
//
// 이 스펙만 test.use()로 프로젝트 기본(Desktop Chrome) 대신 Pixel 7 프리셋(hasTouch·isMobile·
// 좁은 뷰포트)을 오버라이드한다(tooling/scripts/capture-mobile-keyboard-screenshot.mjs와 동일
// 토폴로지). CDP 한글 조합 재현은 Chromium 전용이라 그대로 Chromium에서만 실행한다(§10.2 E1/E3
// 방침 — webkit/firefox 프로젝트는 어차피 testMatch로 이 파일을 실행하지 않는다).
import { devices, expect, test } from '@playwright/test';
import { typeHangul } from '../helpers/ime';
import { gotoBoarding } from '../helpers/game';
import { seedSharedDeviceId } from '../helpers/identity';

const PIXEL_7 = devices['Pixel 7']!;

test.use({ ...PIXEL_7, locale: 'ko-KR' });

test.describe('E8 — 모바일 뷰포트(Pixel 7)', () => {
  test('보딩패스 탭→키보드 유지→visualViewport 레이아웃→스킵 버튼→완주', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'CDP IME 재현은 Chromium 전용');

    // 세션 예산(helpers/identity.ts) — E5/E8/E9가 고정 deviceId를 공유해 서버의 시간당 신규 pid
    // 상한(20/IP) 소모를 아낀다.
    await seedSharedDeviceId(page);
    await gotoBoarding(page, 'continent', 'south-america');

    // §7.2 "첫 포커스는 반드시 사용자 제스처 핸들러 안에서(iOS 제약)" — 실제 터치 탭(.tap())으로
    // depart()의 동기 focusInput()이 유발되는지 확인한다.
    await page.getByTestId('boarding-card').tap();
    const promptMount = page.getByTestId('prompt-mount');
    await expect(promptMount).toHaveText('콜롬비아', { timeout: 20_000 });
    await expect(page.getByTestId('hidden-typing-input')).toBeFocused();

    // §7.1: layoutMode는 뷰포트 폭(innerWidth) 기반 — Pixel 7(412 CSS px) < 640 → 'mobile'.
    // 모바일 전용 고정 스킵 버튼(§7.2 "ESC 없음, 화면 우하단 고정 버튼")이 playing phase에 노출.
    await expect(page.getByTestId('mobile-skip-button')).toBeVisible();

    // CDP IME로 첫 국가를 실제로 타이핑 — "키보드 유지" 상태에서 입력 파이프라인이 살아있음을
    // 증명(hidden input이 포커스를 잃었다면 imeSetComposition이 반영되지 않아 이 assert가 실패).
    const cdp = await page.context().newCDPSession(page);
    await typeHangul(cdp, '콜롬비아');
    await expect(promptMount).toHaveText('베네수엘라');

    // 포커스 유지 계약(§2.7 말미, HiddenTypingInput.tsx pointerdown 캡처): 화면의 비상호작용
    // 영역(HUD 바)을 탭해도 hidden input 포커스가 유지된다.
    await page.getByTestId('hud-bar').tap();
    await expect(page.getByTestId('hidden-typing-input')).toBeFocused();

    // 소프트 키보드 등가 뷰포트 축소(§7.1) → --vv-height/--vv-offset-top CSS 변수 갱신 확인
    // (useLayoutMode.ts가 window resize를 구독). 모드는 이미 'mobile'로 고정(폭은 불변).
    const fullHeight = PIXEL_7.viewport!.height;
    const withKeyboardHeight = Math.round(fullHeight * 0.58); // ~42% 키보드 점유 근사(§7.1).
    await page.setViewportSize({ width: PIXEL_7.viewport!.width, height: withKeyboardHeight });
    await page.waitForFunction(
      (expected) =>
        document.documentElement.style.getPropertyValue('--vv-height') === `${expected}px`,
      withKeyboardHeight,
      { timeout: 5_000 },
    );

    // 나머지 11개국은 모바일 고정 스킵 버튼으로 완주(ESC 키가 아니라 실제 탭 경로 —
    // GameView.tsx requestSkip 배선이 useTypingEngine.requestSkip과 동일 경로임을 확인).
    for (let i = 0; i < 11; i++) {
      await page.getByTestId('mobile-skip-button').tap();
    }
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('result-grade')).toHaveText(/[SABCD]/);
  });
});
