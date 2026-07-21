// spec: docs/02 §8 (국기 이모지 산술), WT-M1-05
import { describe, expect, it } from 'vitest';
import { flagEmoji } from './flag';

describe('flagEmoji — 리저널 인디케이터 산술', () => {
  it('샘플 국가 이모지', () => {
    expect(flagEmoji('KR')).toBe('🇰🇷');
    expect(flagEmoji('US')).toBe('🇺🇸');
    expect(flagEmoji('JP')).toBe('🇯🇵');
    expect(flagEmoji('BR')).toBe('🇧🇷');
  });
  it('2코드포인트(리저널 인디케이터)로 구성', () => {
    expect([...flagEmoji('KR')].length).toBe(2);
    expect(flagEmoji('KR').codePointAt(0)).toBe(0x1f1f0); // 🇰
  });
  it('형식 위반은 throw', () => {
    expect(() => flagEmoji('kr')).toThrow(/2 uppercase/);
    expect(() => flagEmoji('KOR')).toThrow(/2 uppercase/);
    expect(() => flagEmoji('K')).toThrow(/2 uppercase/);
  });
});
