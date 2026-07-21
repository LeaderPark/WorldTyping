import { describe, expect, it } from 'vitest';
import { kstDate, kstIsoWeek } from './kst';

describe('kstDate', () => {
  it('KST 자정 직전/직후 UTC 시각이 서로 다른 날짜로 갈린다', () => {
    // 2026-07-21 14:59:59 UTC = 2026-07-21 23:59:59 KST
    expect(kstDate(Date.parse('2026-07-21T14:59:59Z'))).toBe('2026-07-21');
    // 2026-07-21 15:00:00 UTC = 2026-07-22 00:00:00 KST
    expect(kstDate(Date.parse('2026-07-21T15:00:00Z'))).toBe('2026-07-22');
  });
});

describe('kstIsoWeek', () => {
  it('연 경계를 걸친 주(2025-12-29~2026-01-04)는 전부 2026-W01', () => {
    expect(kstIsoWeek(Date.parse('2025-12-29T00:00:00+09:00'))).toBe('2026-W01');
    expect(kstIsoWeek(Date.parse('2026-01-04T23:00:00+09:00'))).toBe('2026-W01');
  });

  it('2026-01-05(월)은 2026-W02로 넘어간다', () => {
    expect(kstIsoWeek(Date.parse('2026-01-05T00:00:00+09:00'))).toBe('2026-W02');
  });
});
