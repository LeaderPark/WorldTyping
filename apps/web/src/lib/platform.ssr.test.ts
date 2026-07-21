// 기본 환경(node) — window/navigator가 없는 SSR류 컨텍스트에서의 폴백 분기 커버.
import { describe, expect, it } from 'vitest';
import { detectPlatform } from './platform';

describe('detectPlatform (no window/navigator)', () => {
  it('falls back to desktop', () => {
    expect(detectPlatform()).toBe('desktop');
  });
});
