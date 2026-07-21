// spec: docs/02 §5.1 (대륙 배정 규칙), docs/00 §11-D3, WT-M1-05
import { describe, expect, it } from 'vitest';
import { assignContinent, EXPECTED_CONTINENT_COUNTS } from './continent';

describe('assignContinent — region 매핑', () => {
  it('기본 region 매핑', () => {
    expect(assignContinent('KR', 'Asia', 'Eastern Asia')).toBe('asia');
    expect(assignContinent('DE', 'Europe', 'Western Europe')).toBe('europe');
    expect(assignContinent('EG', 'Africa', 'Northern Africa')).toBe('africa');
    expect(assignContinent('AU', 'Oceania', 'Australia and New Zealand')).toBe('oceania');
  });

  it('Americas 는 subregion 으로 남/북 분리', () => {
    expect(assignContinent('BR', 'Americas', 'South America')).toBe('south-america');
    expect(assignContinent('US', 'Americas', 'North America')).toBe('north-america');
    expect(assignContinent('CU', 'Americas', 'Caribbean')).toBe('north-america');
    expect(assignContinent('GT', 'Americas', 'Central America')).toBe('north-america');
  });

  it('명시 override 가 region 규칙보다 우선(§5.1)', () => {
    expect(assignContinent('RU', 'Europe', 'Eastern Europe')).toBe('europe');
    expect(assignContinent('TR', 'Asia', 'Western Asia')).toBe('asia');
    expect(assignContinent('CY', 'Asia', 'Western Asia')).toBe('europe');
    expect(assignContinent('GE', 'Asia', 'Western Asia')).toBe('asia');
    expect(assignContinent('AM', 'Asia', 'Western Asia')).toBe('asia');
    expect(assignContinent('AZ', 'Asia', 'Western Asia')).toBe('asia');
    expect(assignContinent('TL', 'Asia', 'South-Eastern Asia')).toBe('asia');
    expect(assignContinent('EH', 'Africa', 'Northern Africa')).toBe('africa');
  });

  it('알 수 없는 region 은 throw(누락을 조용히 넘기지 않는다)', () => {
    expect(() => assignContinent('ZZ', 'Antarctica', 'n/a')).toThrow(/unknown region/);
  });

  it('기대 카운트 합이 un195(195)', () => {
    const sum = Object.values(EXPECTED_CONTINENT_COUNTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(195);
    expect(EXPECTED_CONTINENT_COUNTS).toEqual({
      asia: 47,
      europe: 45,
      africa: 54,
      'north-america': 23,
      'south-america': 12,
      oceania: 14,
    });
  });
});
