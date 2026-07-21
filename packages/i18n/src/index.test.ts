// spec: WT-M1-07 — 배럴 export 스모크 테스트. 키 집합 동일성은 keys.test.ts가 전담한다.
import { describe, expect, it } from 'vitest';
import { catalogs, isI18nKey } from './index';

describe('@wt/i18n barrel', () => {
  it('exposes ko/en catalogs', () => {
    expect(catalogs.ko['app.title']).toBe('TypeTrip');
    expect(catalogs.en['app.title']).toBe('TypeTrip');
  });

  it('isI18nKey recognizes known and rejects unknown keys', () => {
    expect(isI18nKey('menu.single')).toBe(true);
    expect(isI18nKey('menu.does-not-exist')).toBe(false);
  });
});
