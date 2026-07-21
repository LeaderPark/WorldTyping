// spec: docs/02 §5.2(순서 규칙)·§6(세계일주 계약), docs/00 §11-D2·D3, WT-M1-06
//
// content/routes.ts(노선 콘텐츠 상수)를 검증하는 순수 로직. routes.test.ts(단위 테스트)와
// tooling/scripts/build-data.ts(Step 7-d, 빌드 게이트)가 이 모듈을 공유해 "테스트와 빌드가
// 같은 검증 로직을 쓴다"는 계약을 지킨다(중복 구현 금지).

import type { Continent, Country, CountryId } from '@wt/shared';

/** §11-D3 확정 시작점. */
export const ROUTE_START_POINTS: Record<Continent, CountryId> = {
  asia: 'KR',
  europe: 'PT',
  africa: 'EG',
  'north-america': 'CA',
  'south-america': 'CO',
  oceania: 'AU',
};

/** §11-D2 확정: 세계일주 50개국의 첫 5개국. */
export const WORLD_TOUR_FIRST_5: CountryId[] = ['KR', 'JP', 'US', 'CA', 'MX'];

export const WORLD_TOUR_LENGTH = 50;

/** un195 기준 대륙별 기대 국가 수(§11-D3). continent.ts 의 EXPECTED_CONTINENT_COUNTS 와 동일한 원천. */
export const EXPECTED_ROUTE_LENGTHS: Record<Continent, number> = {
  asia: 47,
  europe: 45,
  africa: 54,
  'north-america': 23,
  'south-america': 12,
  oceania: 14,
};

/** id → 대륙(un195 전용). extended(TW/XK/EH)는 포함하지 않는다(§11-D1). */
export function un195ContinentIndex(countries: Country[], un195: ReadonlySet<string>): Map<CountryId, Continent> {
  const idx = new Map<CountryId, Continent>();
  for (const c of countries) if (un195.has(c.id)) idx.set(c.id, c.continent);
  return idx;
}

/**
 * 대륙 노선 하나를 검증한다: ①중복 없음 ②extended 세트 미포함 ③집합이 해당 대륙 un195
 * 국가와 정확히 일치(따라서 길이도 자동 일치, §11-D3) ④시작점이 §11-D3과 일치.
 * 실패 시 throw(조용히 넘기지 않는다).
 */
export function validateContinentRoute(continent: Continent, route: CountryId[], byContinent: ReadonlySet<CountryId>, extended: ReadonlySet<string>): void {
  const seen = new Set<CountryId>();
  for (const id of route) {
    if (seen.has(id)) throw new Error(`ROUTE_${continent}: 중복 국가 "${id}" (docs/02 §5.2 규칙4)`);
    seen.add(id);
    if (extended.has(id)) throw new Error(`ROUTE_${continent}: extended 국가 "${id}"는 어떤 노선에도 넣을 수 없다(§11-D1)`);
  }

  const missing = [...byContinent].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !byContinent.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `ROUTE_${continent}: un195 집합 불일치 — missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} (docs/02 §5.1 continent 배정과 대조)`,
    );
  }

  const expectedStart = ROUTE_START_POINTS[continent];
  if (route[0] !== expectedStart) {
    throw new Error(`ROUTE_${continent}: 시작점이 "${route[0]}", 기대값 "${expectedStart}" (§11-D3)`);
  }
  // 참고: missing/extra 가 둘 다 0 + 중복 없음이면 route.length === byContinent.size(대륙별
  // un195 카운트, §11-D3 확정치)는 집합 동치의 필연적 귀결이라 별도 길이 assert는 불필요(불가능한
  // 분기를 만들지 않는다). 호출부(routes.test.ts)가 실제 47/45/54/23/12/14 숫자를 직접 assert한다.
}

/**
 * 세계일주(ROUTE_WORLD_TOUR)를 검증한다: ①50개 ②중복 없음 ③전부 un195(extended 미포함)
 * ④6대륙 전부 1회 이상 포함 ⑤첫 5개 = KR,JP,US,CA,MX(§11-D2).
 */
export function validateWorldTour(
  route: CountryId[],
  continentOf: ReadonlyMap<CountryId, Continent>,
  extended: ReadonlySet<string>,
): void {
  if (route.length !== WORLD_TOUR_LENGTH) {
    throw new Error(`ROUTE_WORLD_TOUR: 길이 ${route.length}, 기대값 ${WORLD_TOUR_LENGTH}(§11-D2)`);
  }

  const seen = new Set<CountryId>();
  const continentsCovered = new Set<Continent>();
  for (const id of route) {
    if (seen.has(id)) throw new Error(`ROUTE_WORLD_TOUR: 중복 국가 "${id}"`);
    seen.add(id);
    if (extended.has(id)) throw new Error(`ROUTE_WORLD_TOUR: extended 국가 "${id}"는 출제 제외(§11-D1)`);
    const continent = continentOf.get(id);
    if (!continent) throw new Error(`ROUTE_WORLD_TOUR: "${id}"는 un195에 없다(§10 content-sets.json 대조)`);
    continentsCovered.add(continent);
  }

  const allContinents: Continent[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];
  const missingContinents = allContinents.filter((c) => !continentsCovered.has(c));
  if (missingContinents.length > 0) {
    throw new Error(`ROUTE_WORLD_TOUR: 6대륙 전부 포함해야 하나 누락 — ${JSON.stringify(missingContinents)} (docs/02 §6)`);
  }

  const first5 = route.slice(0, 5);
  if (JSON.stringify(first5) !== JSON.stringify(WORLD_TOUR_FIRST_5)) {
    throw new Error(`ROUTE_WORLD_TOUR: 첫 5개국 ${JSON.stringify(first5)}, 기대값 ${JSON.stringify(WORLD_TOUR_FIRST_5)}(§11-D2)`);
  }
}

/** 위경도 haversine 거리(km). 지리적 자연스러움 리뷰용 — assert 아님(§5.2 리뷰 로그). */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface RouteDistanceReport {
  totalKm: number;
  longestJumps: { from: CountryId; to: CountryId; km: number }[];
}

/** 인접 수도 쌍 haversine 거리 합 + 최장 점프 상위 N개(기본 5). 리뷰 로그 전용 — assert 아님. */
export function routeDistanceReport(route: CountryId[], latlngById: ReadonlyMap<CountryId, [number, number]>, topN = 5): RouteDistanceReport {
  const jumps: { from: CountryId; to: CountryId; km: number }[] = [];
  let totalKm = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i]!;
    const to = route[i + 1]!;
    const a = latlngById.get(from);
    const b = latlngById.get(to);
    if (!a || !b) throw new Error(`routeDistanceReport: "${from}" 또는 "${to}"의 latlng 없음`);
    const km = haversineKm(a, b);
    totalKm += km;
    jumps.push({ from, to, km });
  }
  jumps.sort((x, y) => y.km - x.km);
  return { totalKm, longestJumps: jumps.slice(0, topN) };
}
