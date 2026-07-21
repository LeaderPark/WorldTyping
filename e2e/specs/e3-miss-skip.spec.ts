// spec: docs/03 §10.2 E3(오타/백스페이스/스킵: 고의 MISS→적색→백스페이스 회복, ESC 스킵→콤보
//       리셋+지도 빗금 / HUD 수치·aria-live)·§2.10 #7(조합 중 백스페이스 자모 단위 삭제), WT-M2-08.
//
// [구현 현황 주석] 현재 프론트(WT-M2-06) countryCommitted 배선은 스킵 국가에도 markSolved를
// 호출하고, 스킵 전용 "지도 빗금(--map-skipped)" 레이어·스킵 순간 aria-live 낭독은 아직 없다
// (docs/03 §3.3 색상표는 존재하나 미배선). WT-M2-08은 테스트 전용 작업이라 프론트를 수정하지
// 않으므로, 여기서는 구현된 동작(적색 표시·백스페이스 회복·콤보 리셋·진행 카운트 전진·첫 정답
// aria-live 토스트)을 검증하고, 미구현분은 최종 보고 escalations에 남긴다. Chromium 전용.

import { expect, test, type Locator } from '@playwright/test';
import { setComposition, typeHangul } from '../helpers/ime';
import { enterGame } from '../helpers/game';

function errorUnits(promptMount: Locator): Locator {
  return promptMount.locator('.wt-unit.is-error');
}

test.describe('E3 — 오타/백스페이스/스킵', () => {
  test('고의 MISS→적색→백스페이스 회복→ESC 스킵→콤보 리셋', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME는 Chromium 전용');
    const { cdp, promptMount } = await enterGame(page, 'continent', 'south-america');
    await expect(promptMount).toHaveText('콜롬비아');

    // 콤보 적립: 첫 국가 정타 완주 → 콤보 1(스킵 리셋을 관찰하기 위한 사전 조건).
    await typeHangul(cdp, '콜롬비아');
    await expect(promptMount).toHaveText('베네수엘라');
    // 첫 EXACT → 온보딩 자동진행 토스트(role=status aria-live=polite) 낭독(첫 방문 계정).
    await expect(page.getByTestId('onboarding-toast')).toBeVisible();
    expect(await page.getByTestId('combo-badge').textContent()).toContain('1');

    // 고의 MISS: 베네수엘라(ㅂㅔ…) 대신 "바"(ㅂㅏ) → 두 번째 자모부터 오타 → 적색(is-error).
    await setComposition(cdp, '바');
    await expect(errorUnits(promptMount).first()).toBeVisible();
    expect(await errorUnits(promptMount).count()).toBeGreaterThan(0);

    // 백스페이스 회복: 올바른 접두 "ㅂ"으로 되돌리면 오타 표시가 사라진다.
    await setComposition(cdp, 'ㅂ');
    await expect(errorUnits(promptMount)).toHaveCount(0);

    // ESC 스킵: 콤보 0 리셋 + 다음 국가(가이아나, 3/12)로 전진.
    await page.keyboard.press('Escape');
    await expect(promptMount).toHaveText('가이아나');
    await expect(page.getByTestId('combo-badge')).toHaveClass(/wt-combo--hidden/);
    // HUD/접근성 텍스트: 진행 카운트가 전진(accessible progress-count).
    await expect(page.getByTestId('progress-count')).toHaveText('3 / 12');
  });
});
