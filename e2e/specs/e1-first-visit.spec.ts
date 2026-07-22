// spec: docs/03 §10.2 E1(첫 방문 여정: 랜딩→언어 선택→남미선 완주 / 3클릭 내 인게임 도달,
//       12개국 IME 완주, 결과 등급·점수, R 리트라이 2초 내 재개), WT-M2-08.
//
// 한글 IME 재현(CDP)은 Chromium 전용 — WebKit/Firefox에서는 전체 스킵(config에 프로젝트만 정의).

import { expect, test, type Page } from '@playwright/test';
import { typeHangul } from '../helpers/ime';
import { awaitPrompt } from '../helpers/game';
import { reserveSessionSlot } from '../helpers/session-budget';

// docs/02 routes.ts ROUTE_SOUTH_AMERICA(12개국, 시작점 CO) — countries.json의 nameKo(§11-D22 canonical).
const SOUTH_AMERICA_KO = [
  '콜롬비아', '베네수엘라', '가이아나', '수리남', '브라질', '파라과이',
  '우루과이', '아르헨티나', '칠레', '볼리비아', '페루', '에콰도르',
];

async function landingToSouthAmerica(page: Page): Promise<void> {
  // WT-M3-08 후속: 이 페이지 로드가 bootLoader의 자동 POST /session을 유발한다 — 스위트 전체의
  // 세션 부트스트랩 총량이 서버 레이트리밋을 넘지 않도록 자기 페이싱한다(session-budget.ts).
  await reserveSessionSlot();
  await page.goto('/');
  // S2 언어 게이트(첫 방문, localStorage 'wt:lang' 부재) → 한국어 선택.
  await expect(page.getByTestId('language-gate')).toBeVisible();
  await page.getByTestId('lang-ko').click();
  // 3클릭: 싱글 → 대륙 → 남미선.
  await page.getByTestId('home-card-single').click();
  await page.getByTestId('mode-card-continent').click();
  await page.getByTestId('track-item-continent-south-america').click();
  await expect(page.getByTestId('boarding-pass')).toBeVisible();
}

test.describe('E1 — 첫 방문 여정', () => {
  test('랜딩→언어 선택→남미선 12개국 IME 완주→결과→R 리트라이 재개', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME 재현은 Chromium 전용(§10.2)');

    await landingToSouthAmerica(page);

    // 보딩패스 탭 → 카운트다운 → 플레이(첫 국가 제시).
    await page.getByTestId('boarding-card').click();
    const promptMount = page.getByTestId('prompt-mount');
    await expect(promptMount).toHaveText(SOUTH_AMERICA_KO[0]!, { timeout: 20_000 });

    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('hidden-typing-input').evaluate((el) => (el as HTMLInputElement).focus());

    // 12개국을 두벌식 IME로 순서대로 완주. 각 국가 제시를 expect 폴링으로 동기화(임의 sleep 없음).
    // 국가별로 다른 고정 딜레이를 뽑아 쓴다(docs/06 §3.4 봇 시그니처 회피 + §3.3-(c) 물리 한계
    // ms_i ≥ L_i×35ms + CPM 캡 회피). typeHangul 기본 30ms 그대로면 (1) 국가 내 등간격이라
    // stdev/mean이 봇 임계(0.12) 밑으로 떨어지고 (2) 자모당 35ms 물리 하한보다 빨라 서버가
    // 정당하게 rejected 처리한다 — WT-M3-06에서 실측 발견, 버그 아님(사람은 이렇게 등간격으로
    // 못 친다). 국가마다 60~140ms 범위에서 다르게 골라 회당 등간격이되 판 전체로는 리듬 변주가
    // 생기게 한다.
    for (let i = 0; i < SOUTH_AMERICA_KO.length; i++) {
      const name = SOUTH_AMERICA_KO[i]!;
      const delayMs = 60 + Math.floor(Math.random() * 80);
      await awaitPrompt(promptMount, name);
      if (i === 0) {
        // 첫 정답(EXACT) 시 온보딩 자동진행 토스트(role=status aria-live) 1회 — 첫 방문 계정.
        await typeHangul(cdp, name, { delayMs });
        await expect(page.getByTestId('onboarding-toast')).toBeVisible();
      } else {
        await typeHangul(cdp, name, { delayMs });
      }
    }

    // S7 결과: 등급(S/A/B/C/D) + 점수 카드 표시.
    const result = page.getByTestId('result-view');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('result-grade')).toHaveText(/[SABCD]/);
    await expect(page.getByTestId('result-card')).toBeVisible();

    // WT-M3-06: 결과 제출(POST /runs/submit)이 정착되면 순위(valid/flagged) 또는 verdict 라벨
    // (practice/rejected/queued)이 뜬다 — 어느 쪽이든 "제출 배선이 실제로 동작했다"의 증거다.
    const rankOrVerdict = page.locator('[data-testid="result-rank"], [data-testid="result-verdict-label"]');
    await expect(rankOrVerdict.first()).toBeVisible({ timeout: 15_000 });

    // 랭킹(/rank) → 남미선 보드에서 방금 제출한 내 기록을 확인. 같은 브라우저 컨텍스트의 새 탭을
    // 써서(동일 세션/쿠키 공유) 원래 결과 화면(GamePage 세션 로컬 state)을 건드리지 않는다 —
    // 뒤로가기로 돌아가면 GamePage가 idle(보딩패스)로 새로 마운트돼 result-view가 사라진다
    // (세션 phase가 URL이 아니라 컴포넌트 로컬 state라 브라우저 히스토리로 복원되지 않는다).
    const rankPage = await page.context().newPage();
    await rankPage.goto('/rank');
    await expect(rankPage.getByTestId('rank-page')).toBeVisible();
    await rankPage.getByTestId('rank-filter-mode').selectOption('continent:south-america');
    const myRow = rankPage.locator('.wt-rank-table__row--me');
    const myPinned = rankPage.getByTestId('rank-my-row-pinned');
    await expect(myRow.or(myPinned).first()).toBeVisible({ timeout: 15_000 });
    await rankPage.close();

    // R 리트라이 → 2초 내 카운트다운 재개(RETRY_COUNTDOWN_MS=1500 → 곧바로 game-view 복귀).
    await page.keyboard.press('r');
    await expect(page.getByTestId('game-view')).toBeVisible({ timeout: 2_000 });
    await expect(result).toBeHidden();
  });
});
