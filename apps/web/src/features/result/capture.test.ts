// @vitest-environment jsdom
//
// spec: docs/03 §8.3(캡처 dynamic import), WT-M5-04, WT-UI-06(캡처 라이트 강제)
import { afterEach, describe, expect, it, vi } from 'vitest';

const toBlobMock = vi.fn();
vi.mock('html-to-image', () => ({
  toBlob: (...args: unknown[]) => toBlobMock(...args),
}));

import { captureResultCardPng } from './capture';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('captureResultCardPng', () => {
  it('html-to-image.toBlob을 pixelRatio=2 기본값으로 호출하고 blob을 그대로 반환한다', async () => {
    const fakeBlob = new Blob(['x'], { type: 'image/png' });
    toBlobMock.mockResolvedValue(fakeBlob);
    const node = document.createElement('div');

    const blob = await captureResultCardPng(node);

    expect(toBlobMock).toHaveBeenCalledWith(node, { pixelRatio: 2 });
    expect(blob).toBe(fakeBlob);
  });

  it('pixelRatio를 지정하면 그대로 전달한다', async () => {
    toBlobMock.mockResolvedValue(new Blob());
    const node = document.createElement('div');

    await captureResultCardPng(node, { pixelRatio: 3 });

    expect(toBlobMock).toHaveBeenCalledWith(node, { pixelRatio: 3 });
  });

  it('toBlob이 null을 반환하면 에러를 던진다', async () => {
    toBlobMock.mockResolvedValue(null);
    const node = document.createElement('div');

    await expect(captureResultCardPng(node)).rejects.toThrow(/toBlob/);
  });

  // ── WT-UI-06: 캡처 산출 이미지를 라이트 카드로 정합 ──────────────────────────
  describe('캡처 중 라이트 테마 강제', () => {
    it('다크 테마일 때 캡처 동안 data-theme을 light로 전환했다가 복원한다', async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      let themeDuringCapture: string | null = null;
      toBlobMock.mockImplementation(async () => {
        themeDuringCapture = document.documentElement.getAttribute('data-theme');
        return new Blob(['x'], { type: 'image/png' });
      });
      const node = document.createElement('div');

      await captureResultCardPng(node);

      expect(themeDuringCapture).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('라이트 테마(미설정 포함)일 때는 data-theme을 건드리지 않는다', async () => {
      toBlobMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
      const node = document.createElement('div');

      await captureResultCardPng(node);

      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    });

    it('toBlob이 실패해도 원래 테마로 복원한다', async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      toBlobMock.mockRejectedValue(new Error('capture failed'));
      const node = document.createElement('div');

      await expect(captureResultCardPng(node)).rejects.toThrow('capture failed');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });
});
