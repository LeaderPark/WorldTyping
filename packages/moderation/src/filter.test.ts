// spec: docs/06 §4.2 (필터 파이프라인), WT-M1-07 acceptance
import { describe, expect, it } from 'vitest';
import { buildMatchChannels, evaluateText, filterChat, isNicknameAllowed } from './filter';

describe('leet + jamo-decomposition bypass detection (docs/06 §4.2 examples)', () => {
  it('blocks "ㅅ1ㅂ" (leet-numeral-as-separator bypass of a jamo-shorthand badword)', () => {
    expect(evaluateText('ㅅ1ㅂ').blocked).toBe(true);
    expect(filterChat('ㅅ1ㅂ').blocked).toBe(true);
  });

  it('blocks "시-발" (separator-inserted bypass of a full-syllable badword)', () => {
    expect(evaluateText('시-발').blocked).toBe(true);
    expect(filterChat('시-발').blocked).toBe(true);
  });

  it('blocks the plain form and common variants of a seeded ko badword', () => {
    expect(evaluateText('시발').blocked).toBe(true);
    expect(evaluateText('씨발').blocked).toBe(true);
    expect(evaluateText('개새끼').blocked).toBe(true);
  });

  it('does not flag ordinary Korean text', () => {
    expect(evaluateText('안녕하세요').blocked).toBe(false);
    expect(evaluateText('김치워리어').blocked).toBe(false);
  });
});

describe('en allowlist (Scunthorpe problem)', () => {
  it('allows "assassin" despite containing the badword substring "ass"', () => {
    expect(evaluateText('assassin').blocked).toBe(false);
    expect(isNicknameAllowed('assassin')).toBe(true);
  });

  it('still blocks a bare en badword not covered by the allowlist', () => {
    expect(evaluateText('fuck').blocked).toBe(true);
  });

  it('blocks a leet-obfuscated en badword ("sh1t" -> "shit")', () => {
    expect(evaluateText('sh1t').blocked).toBe(true);
  });
});

describe('reserved word prefixes (docs/06 §4.2 / docs/04 §10.2)', () => {
  it.each(['admin', 'ADMIN2', 'administrator', 'system_ops', '운영자123', 'GUEST_4821', 'guest_x'])(
    '"%s" is blocked as a reserved prefix',
    (name) => {
      expect(evaluateText(name).reason === 'reserved' || evaluateText(name).blocked).toBe(true);
    },
  );

  it('does not over-block a name that merely contains, but does not start with, a reserved word', () => {
    // "관리자" 프리픽스가 아니라 뒤에 오는 경우까지 막지는 않는다(프리픽스 규칙 = startsWith).
    expect(evaluateText('김관리자').reason).not.toBe('reserved');
  });
});

describe('isNicknameAllowed', () => {
  it('allows a clean nickname', () => {
    expect(isNicknameAllowed('김치워리어')).toBe(true);
    expect(isNicknameAllowed('NIMBUS_KR')).toBe(true);
  });

  it('rejects a nickname containing a badword', () => {
    expect(isNicknameAllowed('시발러버')).toBe(false);
  });
});

describe('filterChat masking', () => {
  it('masks the matched span and leaves clean text untouched', () => {
    const clean = filterChat('오늘 날씨 좋다');
    expect(clean.blocked).toBe(false);
    expect(clean.masked).toBe('오늘 날씨 좋다');

    const dirty = filterChat('fuck you');
    expect(dirty.blocked).toBe(true);
    expect(dirty.masked).not.toBe('fuck you');
    expect(dirty.masked).toContain('*');
  });
});

describe('buildMatchChannels', () => {
  it('drops separators and whitespace from both channels', () => {
    const { full } = buildMatchChannels('a_b-c d');
    expect(full).toBe('abcd');
  });

  it('keeps only Hangul jamo in the ko channel, dropping interposed Latin/digits', () => {
    const { ko } = buildMatchChannels('ㅅ1ㅂ');
    expect(ko).toBe('ㅅㅂ');
  });

  it('applies the leet substitution table before jamo/word matching', () => {
    const { full } = buildMatchChannels('sh1t');
    expect(full).toBe('shit');
  });
});
