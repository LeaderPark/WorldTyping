// spec: docs/06 §4.2 (NICK_RE 전문), WT-M1-07 acceptance("NICK_RE 경계" 표)
import { describe, expect, it } from 'vitest';
import { NICK_RE, normalizeNickname } from './nickname';

describe('NICK_RE', () => {
  it('rejects a 1-character name (below minimum length 2)', () => {
    expect(NICK_RE.test('김')).toBe(false);
  });

  it('accepts a 12-character name (at the maximum length)', () => {
    expect(NICK_RE.test('kimchi123456')).toBe(true);
    expect('kimchi123456'.length).toBe(12);
  });

  it('rejects a 13-character name (over the maximum length)', () => {
    expect(NICK_RE.test('kimchi1234567')).toBe(false);
    expect('kimchi1234567'.length).toBe(13);
  });

  it('rejects a leading underscore', () => {
    expect(NICK_RE.test('_kim')).toBe(false);
  });

  it('rejects consecutive separators', () => {
    expect(NICK_RE.test('kim__lee')).toBe(false);
  });

  it('accepts a pure-Hangul nickname', () => {
    expect(NICK_RE.test('김치워리어')).toBe(true);
  });

  it('rejects a digits-only nickname (no letter present)', () => {
    expect(NICK_RE.test('1234')).toBe(false);
  });

  it('rejects a trailing hyphen', () => {
    expect(NICK_RE.test('kim-')).toBe(false);
  });

  it('accepts a single internal separator between letters', () => {
    expect(NICK_RE.test('kim-lee')).toBe(true);
  });

  it('rejects symbols outside the allowed character class', () => {
    expect(NICK_RE.test('kim!lee')).toBe(false);
  });
});

describe('normalizeNickname', () => {
  it('lowercases and NFC-normalizes for uniqueness comparison', () => {
    expect(normalizeNickname('NIMBUS_KR')).toBe('nimbus_kr');
  });

  it('does not apply leet substitution (uniqueness normalization is intentionally not aggressive)', () => {
    // '1'을 'i'로 치환하면 서로 다른 두 닉네임이 충돌 처리되어 과잉 차단이 된다.
    expect(normalizeNickname('kim1')).not.toBe(normalizeNickname('kimi'));
  });
});
