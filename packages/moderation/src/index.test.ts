// spec: WT-M1-07 — 배럴 export 스모크 테스트. 상세 케이스는 filter.test.ts/nickname.test.ts.
import { describe, expect, it } from 'vitest';
import { NICK_RE, isNicknameAllowed, filterChat } from './index';

describe('@wt/moderation barrel', () => {
  it('exposes NICK_RE, isNicknameAllowed, filterChat', () => {
    expect(NICK_RE.test('김치워리어')).toBe(true);
    expect(isNicknameAllowed('김치워리어')).toBe(true);
    expect(filterChat('안녕').blocked).toBe(false);
  });
});
