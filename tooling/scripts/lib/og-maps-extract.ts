// spec: docs/06 §9.1(대륙 지도 SVG path 사전 추출 — 런타임 topojson 파싱 금지), docs/03 §3.1
//       (기준 뷰포트 960×500 geoNaturalEarth1 fitSize Sphere — OG는 게임과 동일 투영을 재사용해
//       완성 노선 노드가 지도와 정렬되게 한다), WT-M6-02
//
// build-data.ts가 호출하는 순수 추출기. world-atlas 토폴로지 + countries 데이터를 받아, OG 렌더가
// 런타임에 그대로 쓸 수 있는 대륙별 단순 SVG path + 국가 중심점 사전을 계산한다. 좌표는 전부
// geo-index.ts와 동일한 960×500 projected 좌표계다(같은 투영 → 노드/노선이 지도와 정렬).
//
// 결정성: 입력(토폴로지·countries)이 고정이면 출력도 고정. path 좌표는 소수 1자리로 반올림해
// 산출물 크기를 줄인다(반올림은 결정적).

import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Country, CountryId, Continent } from '@wt/shared';

/** geo-index.ts MAP_WIDTH/MAP_HEIGHT와 반드시 동일. */
const MAP_WIDTH = 960;
const MAP_HEIGHT = 500;

export interface OgMaps {
  /** geo-index.ts와 동일 투영·뷰포트임을 산출물에 명시(소비자 검증용). */
  viewBox: [number, number];
  /** 대륙별 국가 폴리곤 d 문자열(un195 한정). worldtour/tier/daily는 6개를 합쳐 세계 실루엣으로 쓴다. */
  continents: Record<Continent, string>;
  /** 대륙별 bounding box [x0,y0,x1,y1](projected). 대륙 모드 OG의 viewBox 크롭에 쓴다. */
  continentBounds: Record<Continent, [number, number, number, number]>;
  /** CountryId → projected 중심점 [x,y]. 완성 노선 노드 좌표(초소국 circle 폴백 포함). */
  centroids: Record<CountryId, [number, number]>;
}

interface GeoFeature {
  id?: string | number;
  properties?: { name?: string } | null;
  [k: string]: unknown;
}

interface TopologyLike {
  objects: { countries: { geometries: Array<{ id?: string | number; properties?: { name?: string } | null }> } };
  [k: string]: unknown;
}

function featureKeyOf(f: GeoFeature, index: number): string {
  if (f.id !== undefined && f.id !== null && f.id !== '') return String(f.id);
  const name = f.properties?.name;
  return name ? `x:${name}` : `x:__${index}`;
}

const CONTINENTS: Continent[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];

/** d3-geo path의 과도한 소수 자릿수를 1자리로 반올림(산출물 크기 축소, 결정적). */
function roundPath(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (m) => {
    const n = Number(m);
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  });
}

export function buildOgMaps(topology: TopologyLike, countries: readonly Country[]): OgMaps {
  const fc = feature(topology as never, topology.objects.countries as never) as unknown as {
    features: GeoFeature[];
  };
  const features = fc.features;

  const projection = geoNaturalEarth1().fitSize([MAP_WIDTH, MAP_HEIGHT], { type: 'Sphere' });
  const pathGen = geoPath(projection);

  const featureByKey = new Map<string, GeoFeature>();
  features.forEach((f, i) => featureByKey.set(featureKeyOf(f, i), f));

  // CountryId → featureKey (mapFeatureId 바인딩 + 코소보 특례, geo-index.ts와 동일).
  const keyByCountry = new Map<CountryId, string>();
  for (const c of countries) {
    if (c.mapFeatureId !== null && featureByKey.has(c.mapFeatureId)) keyByCountry.set(c.id, c.mapFeatureId);
  }
  const xk = countries.find((c) => c.id === 'XK');
  if (xk && !keyByCountry.has('XK')) {
    const kosovo = [...featureByKey.entries()].find(([, f]) => f.properties?.name === 'Kosovo');
    if (kosovo) keyByCountry.set('XK', kosovo[0]);
  }

  const centroids: Record<CountryId, [number, number]> = {};
  const round1 = (n: number): number => Math.round(n * 10) / 10;

  for (const c of countries) {
    const key = keyByCountry.get(c.id);
    const f = key !== undefined ? featureByKey.get(key) : undefined;
    if (f) {
      const [cx, cy] = pathGen.centroid(f as never);
      centroids[c.id] = [round1(cx), round1(cy)];
    } else {
      // circle 폴백: latlng[위도,경도] → projection([경도,위도]).
      const [lat, lng] = c.latlng;
      const p = projection([lng, lat]);
      centroids[c.id] = [round1(p ? p[0] : MAP_WIDTH / 2), round1(p ? p[1] : MAP_HEIGHT / 2)];
    }
  }

  const continentsOut = {} as Record<Continent, string>;
  const continentBounds = {} as Record<Continent, [number, number, number, number]>;
  for (const cont of CONTINENTS) {
    const ds: string[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of countries) {
      if (c.continent !== cont) continue;
      const key = keyByCountry.get(c.id);
      const f = key !== undefined ? featureByKey.get(key) : undefined;
      if (!f) continue; // 초소국(circle)은 폴리곤 없음 — 노드로만 표시.
      const d = pathGen(f as never);
      if (!d) continue;
      ds.push(roundPath(d));
      const b = pathGen.bounds(f as never);
      x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]);
      x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]);
    }
    continentsOut[cont] = ds.join(' ');
    continentBounds[cont] = Number.isFinite(x0)
      ? [round1(x0), round1(y0), round1(x1), round1(y1)]
      : [0, 0, MAP_WIDTH, MAP_HEIGHT];
  }

  return {
    viewBox: [MAP_WIDTH, MAP_HEIGHT],
    continents: continentsOut,
    continentBounds,
    centroids,
  };
}
