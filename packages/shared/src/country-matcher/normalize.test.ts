// spec: docs/02 §3.2 (정규화), WT-M1-01 지시 3-e
import { describe, expect, it } from 'vitest';
import { normalizeEn, normalizeKo } from './normalize';

describe('normalizeEn', () => {
  // WT-M1-01 3-e 필수 케이스
  it('strips diacritics, apostrophes and spaces (Côte d\'Ivoire)', () => {
    expect(normalizeEn("Côte d'Ivoire")).toBe('cotedivoire');
  });
  it('lowercases and removes spaces (United States)', () => {
    expect(normalizeEn('United States')).toBe('unitedstates');
  });
  it('removes the full punctuation class . - ’ ` , ( )', () => {
    expect(normalizeEn("St. Kitts-Nevis (test) `x` ’y’,")).toBe('stkittsnevistestxy');
  });
  it('collapses combined diacritics via NFD (São Tomé)', () => {
    expect(normalizeEn('São Tomé')).toBe('saotome');
  });
  it('is idempotent', () => {
    const once = normalizeEn("Côte d'Ivoire");
    expect(normalizeEn(once)).toBe(once);
  });
  it('returns empty string for whitespace-only input', () => {
    expect(normalizeEn('   ')).toBe('');
  });
});

describe('normalizeKo', () => {
  // WT-M1-01 3-e 필수 케이스
  it('removes spaces (파푸아 뉴기니)', () => {
    expect(normalizeKo('파푸아 뉴기니')).toBe('파푸아뉴기니');
  });
  it('removes the middle dot(·), commas, dots, hyphens and parens', () => {
    expect(normalizeKo('보스니아·헤르체고비나 (test), 끝.')).toBe('보스니아헤르체고비나test끝');
  });
  it('leaves plain hangul untouched and is idempotent', () => {
    expect(normalizeKo('대한민국')).toBe('대한민국');
    expect(normalizeKo(normalizeKo('대 한'))).toBe('대한');
  });
});
