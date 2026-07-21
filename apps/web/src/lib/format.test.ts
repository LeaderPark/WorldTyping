import { describe, expect, it } from 'vitest';
import { formatCpm, formatMMSS, formatPercent, formatSeconds } from './format';

describe('formatMMSS', () => {
  it('formats whole minutes/seconds', () => {
    expect(formatMMSS(125_000)).toBe('2:05');
    expect(formatMMSS(0)).toBe('0:00');
    expect(formatMMSS(59_000)).toBe('0:59');
    expect(formatMMSS(600_000)).toBe('10:00');
  });

  it('guards negative/NaN input to 0:00', () => {
    expect(formatMMSS(-500)).toBe('0:00');
    expect(formatMMSS(NaN)).toBe('0:00');
  });
});

describe('formatSeconds', () => {
  it('rounds to the requested decimal digits', () => {
    expect(formatSeconds(4_100)).toBe(4.1);
    expect(formatSeconds(4_100, 0)).toBe(4);
    expect(formatSeconds(0)).toBe(0);
  });

  it('guards negative/NaN input to 0', () => {
    expect(formatSeconds(-1)).toBe(0);
    expect(formatSeconds(NaN)).toBe(0);
  });
});

describe('formatPercent', () => {
  it('converts 0..1 ratio to 0..100 integer', () => {
    expect(formatPercent(0.956)).toBe(96);
    expect(formatPercent(1)).toBe(100);
    expect(formatPercent(0)).toBe(0);
  });

  it('clamps out-of-range ratios', () => {
    expect(formatPercent(1.5)).toBe(100);
    expect(formatPercent(-0.2)).toBe(0);
    expect(formatPercent(NaN)).toBe(0);
  });
});

describe('formatCpm', () => {
  it('rounds and floors at zero', () => {
    expect(formatCpm(450.6)).toBe(451);
    expect(formatCpm(-10)).toBe(0);
    expect(formatCpm(NaN)).toBe(0);
  });
});
