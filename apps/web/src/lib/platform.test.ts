// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from './platform';

describe('detectPlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'ontouchstart', { value: undefined, configurable: true });
    delete (window as unknown as Record<string, unknown>).ontouchstart;
  });

  it('returns desktop when there is no touch support', () => {
    expect(detectPlatform()).toBe('desktop');
  });

  it('returns mobile when touch + coarse pointer + narrow viewport all hold', () => {
    (window as unknown as Record<string, unknown>).ontouchstart = null;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('coarse'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });

    expect(detectPlatform()).toBe('mobile');
  });

  it('stays desktop when viewport is wide even with touch+coarse', () => {
    (window as unknown as Record<string, unknown>).ontouchstart = null;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('coarse'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });

    expect(detectPlatform()).toBe('desktop');
  });
});
