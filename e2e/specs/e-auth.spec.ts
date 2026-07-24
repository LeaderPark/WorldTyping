// spec: docs/00 §11-D68(계정 로그인 하이브리드 — 랭킹=로그인 전용·멀티=로그인 필수·설정 오버레이
//       폐기·Footer 노출 규칙), WT-AUTH-02~07(게이팅·크롬·로비·랭킹·Footer·홈지구본), WT-AUTH-08.
//
// WT-AUTH 밀스톤이 도입한 로그인/크롬/게이팅/Footer 계약을 E2E로 검증한다. 로그인 "상태"는
// helpers/auth.ts가 /auth/dev 응답을 localStorage에 주입해 만든다(프로덕션 빌드라 LoginModal의
// dev 폴백 버튼이 렌더되지 않으므로 UI 클릭으로 로그인 "완료"는 재현 불가 — auth.ts 상단 주석).
// 로그인 모달의 열림/사유/닫힘 자체는 UI로 검증한다.
//
// [멀티 로그인 게이트는 이 빌드에서 검증 불가 — 최종 보고 escalations] pnpm e2e webServer 빌드는
// VITE_WS_BASE(mock WS 직결)를 심는다. 그러면 LobbyPage.e2eBypass=Boolean(import.meta.env.VITE_WS_BASE)
// =true, RoomPage의 wsBase 분기도 로그인 게이트를 건너뛴다(둘 다 빌드 상수로 정적 폴딩). 그래서
// "로비 방 만들기 → LoginModal" 같은 멀티 게이트는 이 단일 빌드에서 트리거되지 않는다(E6/E7이
// mock으로 도는 것과 동일 이유). 대신 동일한 전역 LoginModal을 랭킹 CTA·AuthChip 경로로 검증한다.

import { expect, test, type Page } from '@playwright/test';
import { gotoBoarding, departAndAwaitPlaying } from '../helpers/game';
import { reserveSessionSlot } from '../helpers/session-budget';
import { loginAs } from '../helpers/auth';

/** 신규 컨텍스트는 wt:lang 미설정 → 언어 게이트(포커스 트랩 모달)가 뜬다. 헤더(topbar·theme-toggle)는
 *  게이트 배경(inert)에 있어 조작 불가하므로 먼저 닫는다. E1 스펙과 동일한 dismiss 방식. */
async function dismissLangGate(page: Page): Promise<void> {
  const gate = page.getByTestId('language-gate');
  await expect(gate).toBeVisible();
  await page.getByTestId('lang-ko').click();
  await expect(gate).toBeHidden();
}

/** 대륙(남미선) 보딩 → 플레이 → 12개국 전부 ESC 스킵 → 결과 화면(finished). 대륙 모드는 스킵이
 *  라이프를 소모하지 않고(docs/01 §7) 스킵은 practice 강등이 아니므로(engine: practice=bulk/blur/
 *  devtools만), 비로그인이면 결과 제출이 idle로 남아 result-login-cta가 뜬다(e10 S7·wt-m5-04와 동일 경로). */
async function skipToResult(page: Page): Promise<void> {
  await gotoBoarding(page, 'continent', 'south-america');
  await departAndAwaitPlaying(page);
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 순차 스킵(국가 전환 동기화 목적).
    await page.keyboard.press('Escape');
  }
  await expect(page.getByTestId('result-view')).toBeVisible({ timeout: 15_000 });
}

test.describe('E-AUTH — 로그인/크롬/게이팅/Footer (WT-AUTH)', () => {
  test('설정 오버레이 폐기 — ?modal=settings 무동작 + 기어=테마 토글', async ({ page }) => {
    // §11-D68-⑥: SettingsOverlay와 ?modal=settings 배선을 전면 삭제. 딥링크로 들어와도 설정
    // 다이얼로그가 뜨지 않고 홈이 정상 렌더된다.
    await reserveSessionSlot();
    await page.goto('/?modal=settings');
    await dismissLangGate(page);

    await expect(page.getByTestId('home-page')).toBeVisible();
    // 설정 다이얼로그·기어 딥링크·기어 링크 전부 무동작/부재.
    await expect(page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
    await expect(page.getByTestId('home-nav-settings')).toHaveCount(0);
    await expect(page.getByTestId('login-modal')).toHaveCount(0);
    // 기어 자리는 테마 토글로 대체됐다(§11-D68-⑥).
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
  });

  test('테마 토글 왕복 + 새로고침 지속(기어=라이트/다크 토글)', async ({ page }) => {
    await reserveSessionSlot();
    await page.goto('/');
    await dismissLangGate(page);

    const toggle = page.getByTestId('theme-toggle');
    const html = page.locator('html');

    // 초기 상태(D57 라이트 기본이지만 하드코딩하지 않고 실제 값을 읽어 왕복을 검증).
    const initialPressed = await toggle.getAttribute('aria-pressed');
    const initialDark = initialPressed === 'true';
    await expect(html).toHaveAttribute('data-theme', initialDark ? 'dark' : 'light');

    // 토글 1회 → aria-pressed와 <html data-theme>가 함께 반전.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(!initialDark));
    await expect(html).toHaveAttribute('data-theme', initialDark ? 'light' : 'dark');

    // 새로고침 후에도 유지(§8.1 FOUC 원시 키 지속). wt:lang는 위 dismiss로 이미 저장됐으므로
    // reload 후 언어 게이트는 다시 뜨지 않는다 — 게이트 dismiss 없이 곧장 홈이 렌더된다.
    await reserveSessionSlot();
    await page.reload();
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByTestId('language-gate')).toHaveCount(0);
    await expect(html).toHaveAttribute('data-theme', initialDark ? 'light' : 'dark');
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', String(!initialDark));

    // 다시 토글 → 원상 복귀(왕복).
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', initialDark ? 'dark' : 'light');
  });

  test('랭킹 게이팅 — 비로그인 결과는 로그인 CTA(등재/순위 없음) → 클릭 시 랭킹 로그인 모달', async ({
    page,
  }) => {
    // §11-D68-①: 비로그인(게스트) 제출은 랭킹 미도달 → useRunSubmit idle → ResultView가 CTA를 그린다.
    await skipToResult(page);

    const cta = page.getByTestId('result-login-cta');
    await expect(cta).toBeVisible();
    // 게이팅 상태이므로 등재/순위/검토 라벨은 아직 없다.
    await expect(page.getByTestId('result-registered')).toHaveCount(0);
    await expect(page.getByTestId('result-rank')).toHaveCount(0);
    await expect(page.getByTestId('result-verdict-label')).toHaveCount(0);

    // CTA → 전역 로그인 모달(reason=ranking).
    await cta.click();
    const modal = page.getByTestId('login-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('login-reason')).toHaveAttribute('data-reason', 'ranking');

    // 취소로 닫힘(모달 언마운트).
    await page.getByTestId('login-cancel').click();
    await expect(modal).toHaveCount(0);
  });

  test('랭킹 게이팅 — 로그인 상태 결과는 CTA 없이 제출 상태를 표시', async ({ page }) => {
    // 첫 네비게이션 이전 계정 주입 → 로그인 상태로 부팅. useRunSubmit이 즉시 제출을 시도하므로
    // result-login-cta는 절대 뜨지 않고(제출 보류 idle이 아님) 제출 상태 라벨/등재 문구 중 하나가 뜬다.
    await loginAs(page, 'auth-result-in');
    await skipToResult(page);

    await expect(page.getByTestId('result-login-cta')).toHaveCount(0);
    const status = page.locator(
      '[data-testid="result-registered"], [data-testid="result-verdict-label"], [data-testid="result-rank"]',
    );
    await expect(status.first()).toBeVisible({ timeout: 15_000 });
  });

  test('AuthChip 비로그인 — 로그인 버튼 → 로그인 모달(general) → 취소', async ({ page }) => {
    await reserveSessionSlot();
    await page.goto('/');
    await dismissLangGate(page);

    await expect(page.getByTestId('topbar-login')).toBeVisible();
    await expect(page.getByTestId('topbar-profile')).toHaveCount(0);

    await page.getByTestId('topbar-login').click();
    await expect(page.getByTestId('login-modal')).toBeVisible();
    await expect(page.getByTestId('login-reason')).toHaveAttribute('data-reason', 'general');

    await page.getByTestId('login-cancel').click();
    await expect(page.getByTestId('login-modal')).toHaveCount(0);
  });

  test('AuthChip 로그인 — 프로필 칩 + 로그아웃 메뉴', async ({ page }) => {
    await loginAs(page, 'auth-chip-in', 'Chip Tester');
    await reserveSessionSlot();
    await page.goto('/');
    await dismissLangGate(page);

    // 로그인 상태 → 프로필 칩 노출, 로그인 버튼 부재.
    const profile = page.getByTestId('topbar-profile');
    await expect(profile).toBeVisible();
    await expect(page.getByTestId('topbar-login')).toHaveCount(0);

    // 칩 클릭 → 드롭다운 로그아웃 → 다시 비로그인(로그인 버튼 복귀).
    await profile.click();
    const logout = page.getByTestId('topbar-logout');
    await expect(logout).toBeVisible();
    await logout.click();
    await expect(page.getByTestId('topbar-login')).toBeVisible();
  });

  test('Footer — 브라우징 화면 노출·법적 모달(URL 불변·포커스 복귀)·인게임 미노출', async ({ page }) => {
    // §11-D74: Footer는 실제 게임 플레이(인게임 /play/:mode/:trackId + 멀티 레이스/대기실
    // /multi/:code)에서만 숨고, 그 외(홈·모드/트랙선택·로비·rank·passport·daily·법적·404)엔 노출.
    // §11-D72: 개인정보/약관/지원은 라우트 이동 없이(URL·히스토리 불변) 현재 화면 위 제자리 딤
    // 스크림 모달로 열린다.
    await reserveSessionSlot();
    await page.goto('/');
    await dismissLangGate(page);

    const footer = page.getByTestId('site-footer');
    await expect(footer).toBeVisible();
    await expect(page.getByTestId('footer-link-privacy')).toBeVisible();
    await expect(page.getByTestId('footer-link-terms')).toBeVisible();
    await expect(page.getByTestId('footer-link-support')).toBeVisible();

    const homeUrl = page.url();

    // 개인정보 → 제자리 모달(라우트 이동 없음). ko 게이트 통과 상태라 활성 언어 본문(ko)이 뜬다.
    await page.getByTestId('footer-link-privacy').click();
    await expect(page.getByTestId('legal-modal')).toBeVisible();
    await expect(page.getByTestId('privacy-body-ko')).toBeVisible();
    expect(page.url()).toBe(homeUrl); // URL·히스토리 불변(§11-D72).

    // 닫기 버튼 → 모달 사라지고 여전히 홈(라우트 불변).
    await page.getByTestId('legal-modal-close').click();
    await expect(page.getByTestId('legal-modal')).toHaveCount(0);
    await expect(page.getByTestId('home-page')).toBeVisible();
    expect(page.url()).toBe(homeUrl);

    // 약관 → 모달 → ESC → 모달 닫히고 포커스가 트리거(footer-link-terms)로 복귀(useModalA11y 계약).
    await page.getByTestId('footer-link-terms').click();
    await expect(page.getByTestId('legal-modal')).toBeVisible();
    await expect(page.getByTestId('terms-body-ko')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('legal-modal')).toHaveCount(0);
    await expect(page.getByTestId('footer-link-terms')).toBeFocused();

    // 인게임 진입 → Footer 미노출(브라우징 화면 아님).
    await gotoBoarding(page, 'continent', 'south-america');
    await expect(page.getByTestId('site-footer')).toHaveCount(0);
  });
});
