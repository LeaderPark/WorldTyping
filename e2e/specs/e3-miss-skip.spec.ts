// spec: docs/03 §10.2 E3(오타/백스페이스/스킵: 고의 MISS→적색→백스페이스 회복, ESC 스킵→콤보
//       리셋+지도 빗금 / HUD 수치·aria-live)·§2.10 #7(조합 중 백스페이스 자모 단위 삭제),
//       §3.2(WorldMapHandle.markSkipped)·§3.3(--map-skipped 색상표), WT-M2-08 / WT-M2-09.
//
// [구현 현황 주석] WT-M2-09가 스킵 국가를 markSolved 대신 markSkipped(skipped 레이어 +
// .wt-map__skipped, --map-skipped 회색)로 배선했다 — 아래 테스트가 ESC 스킵 후 해당 국가가
// solved가 아닌 skipped 레이어에 나타나는지 검증한다(docs/03 §3.3 빗금 상태 복원). 스킵 순간
// aria-live 낭독은 여전히 프론트 미배선이라 검증 대상이 아니며 최종 보고 escalations에 남긴다.
// Chromium 전용(CDP IME).

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

    // 지도 빗금(docs/03 §10.2 E3): 스킵된 베네수엘라(VE)는 solved가 아니라 skipped 레이어에
    // .wt-map__skipped(--map-skipped 회색)로 나타난다. 반대로 앞서 정타 완주한 콜롬비아(CO)는
    // solved 레이어에 남아 있어(스킵과 명확히 구분) 스킵 분기가 실제로 작동함을 증명한다.
    await expect(page.locator('.wt-map [data-layer="skipped"] [data-country="VE"]')).toHaveCount(1);
    await expect(page.locator('.wt-map [data-layer="skipped"] .wt-map__skipped')).toHaveCount(1);
    await expect(page.locator('.wt-map [data-layer="solved"] [data-country="VE"]')).toHaveCount(0);
    await expect(page.locator('.wt-map [data-layer="solved"] [data-country="CO"]')).toHaveCount(1);
  });
});
