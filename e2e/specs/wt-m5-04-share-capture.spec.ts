// spec: docs/03 §8.3(캡처 dynamic import), docs/06 §9.1(공유 이미지), docs/07 WT-M5-04
//       [작업 특이 조정] "캡처 검증: Playwright로 blob PNG 시그니처·해상도 assert +
//       e2e/artifacts/ 저장(다크/라이트)".
//
// 남미선(south-america, 12개국)을 전부 ESC 스킵해 최단 경로로 결과 화면(finished)에 도달한다
// (대륙 모드는 스킵이 라이프를 소모하지 않는다 — docs/01 §7 표, e3-miss-skip.spec.ts와 동일
// 전제) — 캡처 검증 자체엔 정타 완주 여부가 무관하므로 IME 타이핑 없이 최소 스텝으로 도달한다.
// 데스크톱(Desktop Chrome 프로젝트 → detectPlatform()='desktop') 공유 버튼은 클립보드 write +
// <a download> 클릭이므로, 실제 브라우저 다운로드 이벤트를 가로채 PNG 시그니처·IHDR 해상도를
// 검사한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { gotoBoarding, departAndAwaitPlaying } from '../helpers/game';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(HERE, '../artifacts');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngInfo {
  width: number;
  height: number;
}

/** PNG 시그니처 검증 + IHDR 청크(폭/높이, 바이트 16~23)를 직접 파싱한다 — 이미지 라이브러리
 *  없이 "결과 카드와 일치"(해상도 > 0)를 확인하기에 충분하다. */
function parsePng(buf: Buffer): PngInfo {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

test.describe('WT-M5-04 — 결과 카드 공유 캡처(다크/라이트)', () => {
  test.beforeAll(async () => {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  });

  test('데스크톱 공유 버튼 → PNG 다운로드(시그니처/해상도 확인) + 다크/라이트 스크린샷', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', '캡처 라이브러리(html-to-image) 실측은 Chromium 기준으로 충분');

    await gotoBoarding(page, 'continent', 'south-america');
    await departAndAwaitPlaying(page);

    // 남미선 12개국 전부 스킵 → finished 전이(대륙 모드는 스킵해도 라이프 소모 없음, docs/01 §7).
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 순차 스킵이 목적(국가 전환 동기화 필요).
      await page.keyboard.press('Escape');
    }
    await expect(page.getByTestId('result-view')).toBeVisible();
    await expect(page.getByTestId('share-card-desktop')).toBeVisible();

    for (const themeName of ['dark', 'light'] as const) {
      // eslint-disable-next-line no-await-in-loop -- 다크/라이트 순차 캡처가 목적.
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
      }, themeName);

      const resultView = page.getByTestId('result-view');
      // eslint-disable-next-line no-await-in-loop
      await resultView.screenshot({
        path: path.join(ARTIFACTS_DIR, `wt-m5-04-result-${themeName}.png`),
      });

      // eslint-disable-next-line no-await-in-loop
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('result-share').click(),
      ]);
      const capturedPath = path.join(ARTIFACTS_DIR, `wt-m5-04-share-capture-${themeName}.png`);
      // eslint-disable-next-line no-await-in-loop
      await download.saveAs(capturedPath);
      // eslint-disable-next-line no-await-in-loop
      const buf = await fs.readFile(capturedPath);
      const info = parsePng(buf);
      expect(info.width, `${themeName} 캡처 width`).toBeGreaterThan(0);
      expect(info.height, `${themeName} 캡처 height`).toBeGreaterThan(0);
    }
  });
});
