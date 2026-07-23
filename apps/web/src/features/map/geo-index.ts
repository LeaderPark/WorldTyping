// spec: docs/03 §3.1(데이터 흐름·사전 계산·GeoIndex 인터페이스), docs/02 §7(mapFeatureId 바인딩·
//       초소국 circle·코소보 특례·중립 feature), docs/00 §11-D19(경로), WT-M2-04
//
// 기준 뷰포트 960×500에서 geoNaturalEarth1().fitSize + geoPath로 전 폴리곤의 d 문자열을 1회
// 계산해 Object.freeze 한다. 이후 지도는 어떤 리사이즈에도 path를 재계산하지 않는다 —
// SVG viewBox 고정 + CSS 크기로 벡터 스케일(반응형 공짜, docs/03 §3.1).
//
// 코소보(§3.1 "코소보 수동 바인딩 … 02 §7 규칙 그대로 구현"): world-atlas의 Kosovo geometry는
// numeric id가 없어 M1 빌드(pipeline.test.ts 계약)에서 XK.mapFeatureId=null로 남는다. 렌더 계층이
// properties.name==='Kosovo' feature를 XK에 수동 바인딩해 폴리곤으로 표시한다(02 §7c). → escalation 참조.

import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Country, CountryId, Continent } from '@wt/shared';
import { buildCountryFeatureBinding, featureKeyOf, type GeoFeature } from './feature-binding';

/** 기준 뷰포트(고정). 리사이즈는 SVG viewBox 스케일로만 흡수한다(path 재계산 금지). */
export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 500;
/** 초소국 circle 폴백 반경(px, viewBox 좌표계). docs/02 §7a. */
export const CIRCLE_RADIUS = 4;

/** projected 좌표계(viewBox 960×500) 기준 국가 도형 메타. */
export interface CountryGeo {
  /** paths Map 키. 폴리곤이면 존재, circle 폴백이면 null. */
  featureId: string | null;
  /** projected 중심점 [x, y]. */
  centroid: [number, number];
  /** projected bounds [[x0,y0],[x1,y1]]. circle 폴백은 반경 박스. */
  bounds: [[number, number], [number, number]];
  /** 타깃 펄스 색 결정용(setTarget이 --continent-{continent} 참조). docs §3.1 인터페이스 확장. */
  continent: Continent;
}

/** docs/03 §3.1 GeoIndex. 모듈 스코프 캐시로 동결 저장한다. */
export interface GeoIndex {
  /** featureId → SVG path d 문자열(사전 계산·동결). */
  paths: ReadonlyMap<string, string>;
  /** CountryId → projected 도형 메타(폴리곤·circle 공통, 카메라 bounds 산출용). */
  byCountry: ReadonlyMap<CountryId, CountryGeo>;
  /** 우리 데이터셋 밖 feature(속령·미승인 등). 중립 회색, 인터랙션 없음(02 §7b). */
  neutralFeatureIds: readonly string[];
  /** mapFeatureId=null 초소국의 projected 점 좌표(02 §7a). 이 국가들만 dots 레이어에 circle. */
  circleFallback: ReadonlyMap<CountryId, [number, number]>;
}

/** topojson 최소 형태(런타임 파싱 산물). 전체 스키마 대신 소비 필드만 좁게 기술한다. */
export interface TopologyLike {
  objects: {
    countries: {
      geometries: Array<{ id?: string | number; properties?: { name?: string } | null }>;
    };
  };
  [k: string]: unknown;
}

/**
 * docs/03 §3.1: 기준 뷰포트에서 전 폴리곤 d를 1회 계산해 GeoIndex로 동결한다.
 * @param topology world-atlas countries-110m.json 파싱 결과
 * @param countries countries.json 의 countries 배열(mapFeatureId·latlng·continent 사용)
 */
export function buildGeoIndex(topology: TopologyLike, countries: readonly Country[]): GeoIndex {
  // topojson.feature: GeometryCollection → FeatureCollection.
  const fc = feature(
    topology as never,
    topology.objects.countries as never,
  ) as unknown as { features: GeoFeature[] };
  const features = fc.features;

  const projection = geoNaturalEarth1().fitSize([MAP_WIDTH, MAP_HEIGHT], { type: 'Sphere' });
  const pathGen = geoPath(projection);

  // featureKey → { d, feature } (사전 계산). 무-id feature도 합성 키로 고유하게 보존.
  const paths = new Map<string, string>();
  const featureByKey = new Map<string, GeoFeature>();
  features.forEach((f, i) => {
    const key = featureKeyOf(f, i);
    const d = pathGen(f as never) ?? '';
    paths.set(key, d);
    featureByKey.set(key, f);
  });

  // mapFeatureId → CountryId (폴리곤 바인딩) + 코소보 수동 바인딩(02 §7c). feature-binding.ts로
  // 추출해 지구본(globe-index)과 규칙을 공유한다(D67) — 동작은 기존 인라인과 동일.
  const countryByFeatureKey = buildCountryFeatureBinding(featureByKey, countries);

  // CountryId → featureKey 역인덱스(코소보 수동 바인딩 포함). O(n) 조회용.
  const keyByCountry = new Map<CountryId, string>();
  for (const [key, id] of countryByFeatureKey) keyByCountry.set(id, key);

  const byCountry = new Map<CountryId, CountryGeo>();
  const circleFallback = new Map<CountryId, [number, number]>();

  for (const c of countries) {
    const boundKey = keyByCountry.get(c.id) ?? null;
    const boundFeature = boundKey !== null ? featureByKey.get(boundKey) : undefined;

    if (boundKey !== null && boundFeature) {
      const [cx, cy] = pathGen.centroid(boundFeature as never);
      const b = pathGen.bounds(boundFeature as never);
      byCountry.set(c.id, {
        featureId: boundKey,
        centroid: [cx, cy],
        bounds: [
          [b[0][0], b[0][1]],
          [b[1][0], b[1][1]],
        ],
        continent: c.continent,
      });
    } else {
      // circle 폴백: latlng[위도,경도] → projection([경도,위도]). docs/02 §7a.
      const [lat, lng] = c.latlng;
      const p = projection([lng, lat]);
      const cx = p ? p[0] : MAP_WIDTH / 2;
      const cy = p ? p[1] : MAP_HEIGHT / 2;
      circleFallback.set(c.id, [cx, cy]);
      byCountry.set(c.id, {
        featureId: null,
        centroid: [cx, cy],
        bounds: [
          [cx - CIRCLE_RADIUS, cy - CIRCLE_RADIUS],
          [cx + CIRCLE_RADIUS, cy + CIRCLE_RADIUS],
        ],
        continent: c.continent,
      });
    }
  }

  // 중립 feature: paths 에 있으나 어떤 국가에도 바인딩되지 않은 키(속령·미승인 등, 02 §7b).
  const neutralFeatureIds: string[] = [];
  for (const key of paths.keys()) {
    if (!countryByFeatureKey.has(key)) neutralFeatureIds.push(key);
  }
  neutralFeatureIds.sort(); // 결정적 순서.

  return Object.freeze({
    paths,
    byCountry,
    neutralFeatureIds: Object.freeze(neutralFeatureIds),
    circleFallback,
  }) satisfies GeoIndex;
}

// ── 모듈 스코프 캐시(docs/03 §3.1 "모듈 스코프 캐시, Object.freeze") ────────────────
let cached: GeoIndex | null = null;

/** 부팅 시 1회 구축·동결. 이후 동일 참조 반환(WorldMap 마운트마다 재계산 방지). */
export function getGeoIndex(topology: TopologyLike, countries: readonly Country[]): GeoIndex {
  if (!cached) cached = buildGeoIndex(topology, countries);
  return cached;
}

/** 테스트 전용: 모듈 캐시 리셋. */
export function __resetGeoIndexCacheForTests(): void {
  cached = null;
}
