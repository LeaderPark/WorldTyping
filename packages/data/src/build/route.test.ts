// spec: docs/02 §5.2·§6, docs/00 §11-D2·D3, WT-M1-06
import { describe, expect, it } from 'vitest';
import type { Continent, Country } from '@wt/shared';
import {
  EXPECTED_ROUTE_LENGTHS,
  ROUTE_START_POINTS,
  WORLD_TOUR_FIRST_5,
  WORLD_TOUR_LENGTH,
  haversineKm,
  routeDistanceReport,
  un195ContinentIndex,
  validateContinentRoute,
  validateWorldTour,
} from './route';

function stubCountry(id: string, continent: Continent): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo: id,
    nameEn: id,
    aliasesKo: [],
    aliasesEn: [],
    continent,
    subregion: 'n/a',
    difficultyTier: 1,
    capitalKo: id,
    capitalEn: id,
    flagEmoji: '🏳️',
    population: 1,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [id],
    acceptedInputsEn: [id],
  };
}

describe('상수(§11-D2·D3)', () => {
  it('시작점 6개 대륙 전부 정의', () => {
    expect(ROUTE_START_POINTS).toEqual({
      asia: 'KR',
      europe: 'PT',
      africa: 'EG',
      'north-america': 'CA',
      'south-america': 'CO',
      oceania: 'AU',
    });
  });
  it('세계일주 첫 5개국·길이', () => {
    expect(WORLD_TOUR_FIRST_5).toEqual(['KR', 'JP', 'US', 'CA', 'MX']);
    expect(WORLD_TOUR_LENGTH).toBe(50);
  });
  it('대륙별 기대 길이 합 195', () => {
    expect(Object.values(EXPECTED_ROUTE_LENGTHS).reduce((a, b) => a + b, 0)).toBe(195);
  });
});

describe('un195ContinentIndex', () => {
  it('un195 만 포함하고 extended 는 제외', () => {
    const countries = [stubCountry('KR', 'asia'), stubCountry('TW', 'asia')];
    const idx = un195ContinentIndex(countries, new Set(['KR']));
    expect(idx.get('KR')).toBe('asia');
    expect(idx.has('TW')).toBe(false);
  });
});

describe('validateContinentRoute', () => {
  const byContinent = new Set(['KR', 'JP', 'CN']);
  const extended = new Set(['TW']);

  it('정상 노선은 통과', () => {
    expect(() => validateContinentRoute('asia', ['KR', 'JP', 'CN'], byContinent, extended)).not.toThrow();
  });

  it('중복이면 throw', () => {
    expect(() => validateContinentRoute('asia', ['KR', 'JP', 'JP'], byContinent, extended)).toThrow(/중복/);
  });

  it('extended 포함 시 throw(§11-D1)', () => {
    const byContinentWithTw = new Set(['KR', 'JP', 'TW']);
    expect(() => validateContinentRoute('asia', ['KR', 'JP', 'TW'], byContinentWithTw, extended)).toThrow(/extended/);
  });

  it('집합 불일치(누락) 시 throw', () => {
    expect(() => validateContinentRoute('asia', ['KR', 'JP'], byContinent, extended)).toThrow(/집합 불일치/);
  });

  it('집합 불일치(초과) 시 throw', () => {
    const smallSet = new Set(['KR', 'JP']);
    expect(() => validateContinentRoute('asia', ['KR', 'JP', 'CN'], smallSet, extended)).toThrow(/집합 불일치/);
  });

  it('시작점 불일치 시 throw(§11-D3)', () => {
    expect(() => validateContinentRoute('asia', ['JP', 'KR', 'CN'], byContinent, extended)).toThrow(/시작점/);
  });
});

describe('validateWorldTour', () => {
  const continentOf = new Map<string, Continent>([
    ['KR', 'asia'], ['JP', 'asia'], ['US', 'north-america'], ['CA', 'north-america'], ['MX', 'north-america'],
    ['CO', 'south-america'], ['AU', 'oceania'], ['PT', 'europe'], ['EG', 'africa'],
  ]);
  const extended = new Set(['TW']);

  // 6대륙 커버리지(CO=south-america, AU=oceania, PT=europe, EG=africa)를 한 번씩 넣고,
  // 나머지는 continentOf 에 없는 합성 id(europe로 매핑)로 50개를 채운다.
  const COVERAGE = ['CO', 'AU', 'PT', 'EG'];
  function fillTo50(head: string[]): string[] {
    const filler = Array.from({ length: 50 - head.length - COVERAGE.length }, (_, i) => `X${i}`);
    return [...head, ...COVERAGE, ...filler];
  }
  function withFillerContinents(route: string[]): Map<string, Continent> {
    const idx = new Map(continentOf);
    for (const id of route) if (!idx.has(id)) idx.set(id, 'europe');
    return idx;
  }

  it('길이 50이 아니면 throw', () => {
    expect(() => validateWorldTour(['KR', 'JP', 'US', 'CA', 'MX'], continentOf, extended)).toThrow(/길이/);
  });

  it('중복 있으면 throw', () => {
    const route = ['KR', 'JP', 'US', 'CA', 'MX', 'KR', ...Array.from({ length: 44 }, (_, i) => `X${i}`)];
    const idx = new Map(continentOf);
    for (let i = 0; i < 44; i++) idx.set(`X${i}`, 'europe');
    expect(() => validateWorldTour(route, idx, extended)).toThrow(/중복/);
  });

  it('extended 포함 시 throw', () => {
    const route = ['KR', 'JP', 'US', 'CA', 'MX', 'TW', ...Array.from({ length: 44 }, (_, i) => `X${i}`)];
    const idx = new Map(continentOf);
    idx.set('TW', 'asia');
    for (let i = 0; i < 44; i++) idx.set(`X${i}`, 'europe');
    expect(() => validateWorldTour(route, idx, extended)).toThrow(/extended/);
  });

  it('un195에 없는 국가면 throw', () => {
    const route = ['KR', 'JP', 'US', 'CA', 'MX', 'ZZ', ...Array.from({ length: 44 }, (_, i) => `X${i}`)];
    const idx = new Map(continentOf);
    for (let i = 0; i < 44; i++) idx.set(`X${i}`, 'europe');
    expect(() => validateWorldTour(route, idx, extended)).toThrow(/un195에 없다/);
  });

  it('6대륙 미포함 시 throw', () => {
    const route = ['KR', 'JP', ...Array.from({ length: 48 }, (_, i) => `X${i}`)];
    const idx = new Map<string, Continent>([['KR', 'asia'], ['JP', 'asia']]);
    for (let i = 0; i < 48; i++) idx.set(`X${i}`, 'asia');
    expect(() => validateWorldTour(route, idx, extended)).toThrow(/6대륙/);
  });

  it('첫 5개국 불일치 시 throw(§11-D2)', () => {
    const route = fillTo50(['JP', 'KR', 'US', 'CA', 'MX']);
    const idx = withFillerContinents(route);
    expect(() => validateWorldTour(route, idx, extended)).toThrow(/첫 5개국/);
  });

  it('전부 만족하는 노선은 통과', () => {
    const route = fillTo50(['KR', 'JP', 'US', 'CA', 'MX']);
    const idx = withFillerContinents(route);
    expect(() => validateWorldTour(route, idx, extended)).not.toThrow();
  });
});

describe('haversineKm', () => {
  it('같은 지점이면 0', () => {
    expect(haversineKm([37, 127], [37, 127])).toBeCloseTo(0, 6);
  });
  it('서울-도쿄 거리가 대략 1100~1200km', () => {
    const km = haversineKm([37, 127.5], [36, 138]);
    expect(km).toBeGreaterThan(900);
    expect(km).toBeLessThan(1300);
  });
});

describe('routeDistanceReport', () => {
  const latlngById = new Map<string, [number, number]>([
    ['KR', [37, 127.5]],
    ['JP', [36, 138]],
    ['CN', [35, 105]],
  ]);

  it('총 거리 + 최장 점프 상위 N개를 리턴(assert 아님, 리뷰용)', () => {
    const report = routeDistanceReport(['KR', 'JP', 'CN'], latlngById, 5);
    expect(report.totalKm).toBeGreaterThan(0);
    expect(report.longestJumps.length).toBe(2);
    expect(report.longestJumps[0]!.km).toBeGreaterThanOrEqual(report.longestJumps[1]!.km);
  });

  it('latlng 없는 국가면 throw', () => {
    expect(() => routeDistanceReport(['KR', 'ZZ'], latlngById)).toThrow(/latlng 없음/);
  });
});
