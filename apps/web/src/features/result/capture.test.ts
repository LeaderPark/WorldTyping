// @vitest-environment jsdom
//
// spec: docs/03 §8.3(캡처 dynamic import), WT-M5-04
import { describe, expect, it, vi } from 'vitest';

const toBlobMock = vi.fn();
vi.mock('html-to-image', () => ({
  toBlob: (...args: unknown[]) => toBlobMock(...args),
}));

import { captureResultCardPng } from './capture';

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
});
