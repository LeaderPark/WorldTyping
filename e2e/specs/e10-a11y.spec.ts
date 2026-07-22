// spec: docs/03 §10.2 E10(전 페이지 wcag2aa 위반 0 — @axe-core/playwright), §7.3(접근성 표),
//       docs/01 §11.2·§11.3, WT-M5-02.
//
// 각 화면에서 axe-core를 wcag2a+wcag2aa 태그로만 실행한다(작업 지시 원문 "wcag2aa 위반 0" —
// wcag21aa 등 상위 버전 규칙은 이 acceptance의 범위가 아니다).
//
// [세션 예산 — 중요] 이 스위트의 각 `test()`는 격리된 브라우저 컨텍스트를 새로 받고,
// 최초 `page.goto()`는 bootLoader의 POST /session 부트스트랩을 유발한다(session-budget.ts
// 주석 참조 — session 스코프는 per-ip 고정 윈도라 전체 스위트가 공유한다). 화면 간 이동은
// 가능한 한 클라이언트 사이드 <Link> 클릭/`page.goBack()`로 체인해 테스트당 정확히 1회의
// 풀 네비게이션(=세션 부트스트랩 1회)만 쓰도록 최소화했다 — 화면 수만큼 테스트를 쪼개
// 하드 리로드를 반복하면(초안에서 실측) E4처럼 뒤따르는 무관한 스펙까지 레이트리밋 여유를
// 깎아 먹는다.
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoBoarding, departAndAwaitPlaying } from '../helpers/game';
import { reserveSessionSlot } from '../helpers/session-budget';

const WCAG_TAGS = ['wcag2a', 'wcag2aa'];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
}

function describeViolations(results: Awaited<ReturnType<typeof scan>>): string {
  return results.violations
    .map((v) => `[${v.id}] ${v.help} (${v.nodes.length} node(s)): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
    .join('\n');
}

async function assertNoViolations(page: Page, label: string): Promise<void> {
  const results = await scan(page);
  expect(results.violations, `${label}\n${describeViolations(results)}`).toEqual([]);
}

test.describe('E10 — 접근성(wcag2a/wcag2aa, 전 페이지)', () => {
  test('S1 게이트 → 홈 → S3/S4/S8/S9/S13(passport) → S12 설정 모달 (단일 세션, 클라 내비게이션 체인)', async ({
    page,
  }) => {
    await reserveSessionSlot();
    await page.goto('/');
    await expect(page.getByTestId('language-gate')).toBeVisible();

    // 게이트가 열리면 첫 포커스 가능 요소(ko 버튼)로 자동 포커스(포커스 트랩, §7.3) + 키보드
    // 온리로 Tab→en 버튼 순회 가능함을 확인한다.
    await expect(page.getByTestId('lang-ko')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('lang-en')).toBeFocused();

    await assertNoViolations(page, 'S2 언어 게이트');

    await page.getByTestId('lang-ko').click();
    await expect(page.getByTestId('language-gate')).toBeHidden();
    await assertNoViolations(page, 'S1 홈');

    // S3 모드 선택 (클라 내비게이션 — 새 세션 없음).
    await page.getByTestId('home-card-single').click();
    await expect(page.getByTestId('mode-select-page')).toBeVisible();
    await assertNoViolations(page, 'S3 모드 선택');

    // S4 노선 선택.
    await page.getByTestId('mode-card-continent').click();
    await expect(page.getByTestId('track-select-page')).toBeVisible();
    await assertNoViolations(page, 'S4 노선 선택');

    // 홈으로 돌아가(클라 히스토리) S8 랭킹으로.
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('home-page')).toBeVisible();
    await page.getByTestId('home-nav-rank').click();
    await expect(page.getByTestId('rank-page')).toBeVisible();
    await assertNoViolations(page, 'S8 랭킹');

    // 홈으로 돌아가 S9 멀티 로비로.
    await page.goBack();
    await expect(page.getByTestId('home-page')).toBeVisible();
    await page.getByTestId('home-card-multi').click();
    await expect(page.getByTestId('lobby-page')).toBeVisible();
    await assertNoViolations(page, 'S9 멀티 로비');

    // 홈으로 돌아가 S13 여권으로.
    await page.goBack();
    await expect(page.getByTestId('home-page')).toBeVisible();
    await page.getByTestId('home-nav-passport').click();
    await assertNoViolations(page, 'S13 여권');

    // 홈으로 돌아가 S12 설정 모달(포커스 트랩 + inert 배경 + ESC 닫기 + 트리거 복귀).
    await page.goBack();
    await expect(page.getByTestId('home-page')).toBeVisible();
    const settingsLink = page.getByTestId('home-nav-settings');
    await settingsLink.click();
    await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible();

    // 배경 서브트리(다이얼로그의 조상을 거슬러 올라간 각 레벨의 형제들)가 inert 처리됐는지 —
    // inert는 자손까지 상속되므로 home-card-single이 직접 그 속성을 갖지는 않지만, 조상 중
    // 하나는 inert여야 한다(포커스 트랩 계약, §7.3).
    await expect(page.locator('[inert] [data-testid="home-card-single"]')).toHaveCount(1);

    await assertNoViolations(page, 'S12 설정 모달');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-close')).toBeHidden();
    await expect(settingsLink).toBeFocused();
  });

  test('S5 보딩패스 / S6 인게임 / S7 결과 (ESC 스킵 완주, 단일 세션)', async ({ page }) => {
    await gotoBoarding(page, 'continent', 'south-america');
    await assertNoViolations(page, 'S5 보딩패스');

    const promptMount = await departAndAwaitPlaying(page);
    await page.getByTestId('hidden-typing-input').evaluate((el) => (el as HTMLInputElement).focus());
    await assertNoViolations(page, 'S6 인게임');

    // 국가 전환 aria-live 낭독(§7.3) — 스킵 1회로 최소 1번은 갱신됨을 확인.
    await expect(promptMount).not.toBeEmpty();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('progress-count')).toHaveText('2 / 12');
    await expect(page.getByTestId('game-country-announce')).not.toBeEmpty();

    // progressbar role/값(§7.3).
    await expect(page.getByTestId('progress-line')).toHaveAttribute('role', 'progressbar');
    await expect(page.getByTestId('progress-line')).toHaveAttribute('aria-valuenow', '2');

    // 나머지 11개국 전부 ESC 스킵 → 결과 화면.
    for (let i = 0; i < 11; i++) {
      await page.keyboard.press('Escape');
    }
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });
    // 결과 assertive 낭독(§7.3) 1회.
    await expect(page.getByTestId('result-announce')).not.toBeEmpty();

    await assertNoViolations(page, 'S7 결과');
  });

  test('S13 개인정보처리방침 (직접 URL — UI에 링크 없음, 단일 세션)', async ({ page }) => {
    await reserveSessionSlot();
    await page.goto('/privacy');
    await assertNoViolations(page, 'S13 개인정보처리방침');
  });
});
