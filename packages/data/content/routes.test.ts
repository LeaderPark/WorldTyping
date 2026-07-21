// spec: docs/02 §5.2(순서 규칙)·§5.3·§5.4·§5.5·§6, docs/00 §11-D1·D2·D3, WT-M1-06
//
// 노선 콘텐츠 검증: ①대륙 un195 집합과 정확히 일치 ②중복 없음 ③명시된 시작점
// ④세계일주 50개·중복 없음·6대륙 포함·첫 5개 KR,JP,US,CA,MX. 로직은 ../src/build/route.ts를
// build-data.ts Step 7-d와 공유한다(동일 검증 로직 계약).
import { describe, expect, it } from 'vitest';
import type { Continent, CountryId } from '@wt/shared';
import contentSets from '../overrides/content-sets.json';
import { buildDataset } from '../src/build/pipeline';
import {
  routeDistanceReport,
  un195ContinentIndex,
  validateContinentRoute,
  validateWorldTour,
} from '../src/build/route';
import {
  CONTINENT_ROUTES,
  ROUTE_AFRICA,
  ROUTE_ASIA,
  ROUTE_EUROPE,
  ROUTE_NORTH_AMERICA,
  ROUTE_OCEANIA,
  ROUTE_SOUTH_AMERICA,
  ROUTE_WORLD_TOUR,
} from './routes';

const { dataset } = buildDataset();
const un195 = new Set<string>(contentSets.un195);
const extended = new Set<string>(contentSets.extended);
const continentOf = un195ContinentIndex(dataset.countries, un195);
const latlngById = new Map<CountryId, [number, number]>(dataset.countries.map((c) => [c.id, c.latlng]));

const byContinent: Record<Continent, Set<CountryId>> = {
  asia: new Set(), europe: new Set(), africa: new Set(),
  'north-america': new Set(), 'south-america': new Set(), oceania: new Set(),
};
for (const [id, continent] of continentOf) byContinent[continent].add(id);

describe('대륙 노선 — un195 집합 일치·중복 없음·시작점(§11-D3)', () => {
  const cases: [Continent, CountryId[], number][] = [
    ['asia', ROUTE_ASIA, 47],
    ['europe', ROUTE_EUROPE, 45],
    ['africa', ROUTE_AFRICA, 54],
    ['north-america', ROUTE_NORTH_AMERICA, 23],
    ['south-america', ROUTE_SOUTH_AMERICA, 12],
    ['oceania', ROUTE_OCEANIA, 14],
  ];

  it.each(cases)('%s: 길이 %i, 집합 일치, 중복 없음, 시작점 확정', (continent, route, expectedLength) => {
    expect(route.length).toBe(expectedLength);
    expect(() => validateContinentRoute(continent, route, byContinent[continent], extended)).not.toThrow();
  });

  it('CONTINENT_ROUTES 가 6개 배열 전부를 정확히 참조', () => {
    expect(CONTINENT_ROUTES.asia).toBe(ROUTE_ASIA);
    expect(CONTINENT_ROUTES.europe).toBe(ROUTE_EUROPE);
    expect(CONTINENT_ROUTES.africa).toBe(ROUTE_AFRICA);
    expect(CONTINENT_ROUTES['north-america']).toBe(ROUTE_NORTH_AMERICA);
    expect(CONTINENT_ROUTES['south-america']).toBe(ROUTE_SOUTH_AMERICA);
    expect(CONTINENT_ROUTES.oceania).toBe(ROUTE_OCEANIA);
  });

  it('대륙 노선 6개 합 = un195 195', () => {
    const total = ROUTE_ASIA.length + ROUTE_EUROPE.length + ROUTE_AFRICA.length +
      ROUTE_NORTH_AMERICA.length + ROUTE_SOUTH_AMERICA.length + ROUTE_OCEANIA.length;
    expect(total).toBe(195);
  });

  it('어떤 노선에도 extended(TW/XK/EH) 없음(§11-D1)', () => {
    const all = [...ROUTE_ASIA, ...ROUTE_EUROPE, ...ROUTE_AFRICA, ...ROUTE_NORTH_AMERICA, ...ROUTE_SOUTH_AMERICA, ...ROUTE_OCEANIA];
    for (const id of all) expect(extended.has(id)).toBe(false);
  });
});

describe('세계일주(ROUTE_WORLD_TOUR) — 50개국(§11-D2)', () => {
  it('길이 50, 중복 없음, 6대륙 포함, 첫 5개 = KR,JP,US,CA,MX', () => {
    expect(ROUTE_WORLD_TOUR.length).toBe(50);
    expect(() => validateWorldTour(ROUTE_WORLD_TOUR, continentOf, extended)).not.toThrow();
    expect(ROUTE_WORLD_TOUR.slice(0, 5)).toEqual(['KR', 'JP', 'US', 'CA', 'MX']);
  });

  it('마지막 국가는 CN(실크로드 귀환 종착, 종착 연출은 CN→서울)', () => {
    expect(ROUTE_WORLD_TOUR.at(-1)).toBe('CN');
  });
});

describe('지리적 자연스러움 리뷰 로그(assert 아님 — §5.2)', () => {
  const routes: [string, CountryId[]][] = [
    ['ASIA', ROUTE_ASIA],
    ['EUROPE', ROUTE_EUROPE],
    ['AFRICA', ROUTE_AFRICA],
    ['NORTH_AMERICA', ROUTE_NORTH_AMERICA],
    ['SOUTH_AMERICA', ROUTE_SOUTH_AMERICA],
    ['OCEANIA', ROUTE_OCEANIA],
    ['WORLD_TOUR', ROUTE_WORLD_TOUR],
  ];

  it('인접쌍 수도 간 haversine 거리 합·최장 점프 상위 5개를 로그로 출력', () => {
    for (const [name, route] of routes) {
      const report = routeDistanceReport(route, latlngById, 5);
      console.log(`\n[routes review] ROUTE_${name} — 총 이동거리 ${Math.round(report.totalKm).toLocaleString()}km`);
      for (const jump of report.longestJumps) {
        console.log(`  ${jump.from} -> ${jump.to}: ${Math.round(jump.km).toLocaleString()}km`);
      }
      expect(report.totalKm).toBeGreaterThan(0);
    }
  });
});
