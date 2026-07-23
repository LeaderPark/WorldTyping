// spec: docs/03 §3.1·§3.7(지구본 여정 무대, 00 §11-D67), docs/02 §7(바인딩·중립 feature·코소보),
//       WT-DC-08.
//
// 지구본(GlobeMap)은 매 프레임 projection.rotate로 폴리곤을 재투영하므로 사전 계산된 d 문자열
// (geo-index의 paths)이 아니라 원본 GeoJSON feature가 필요하다. 이 인덱스는 topology를 1회
// FeatureCollection으로 변환하고, feature↔CountryId 바인딩(feature-binding, geo-index와 공유)
// + 앵커([경도,위도] — countries.json latlng 역순) + 대륙 맵을 동결 저장한다. 모듈 스코프 캐시.

import { feature } from 'topojson-client';
import type { Continent, Country, CountryId } from '@wt/shared';
import { buildCountryFeatureBinding, featureKeyOf, type GeoFeature } from '../feature-binding';
import type { TopologyLike } from '../geo-index';

/** docs/03 §3.7 GlobeIndex. 전 feature(재투영 렌더) + 국가별 feature/앵커/대륙 + 중립 feature. */
export interface GlobeIndex {
  /** 전 topojson feature(재투영 렌더용 원본 GeoJSON). */
  features: readonly GeoFeature[];
  /** CountryId → 해당 feature(solved/skipped/target 채색용). 코소보 수동 바인딩 포함. 초소국은 부재. */
  featureByCountry: ReadonlyMap<CountryId, GeoFeature>;
  /** CountryId → [경도, 위도] 앵커(카메라 회전·오버레이 투영·아크 끝점). latlng[위도,경도] 역순. */
  anchor: ReadonlyMap<CountryId, [number, number]>;
  /** CountryId → 대륙(대륙색 결정). */
  continent: ReadonlyMap<CountryId, Continent>;
  /** 어떤 국가에도 바인딩되지 않은 feature(속령·미승인 — 중립 회색, 02 §7b). */
  neutralFeatures: readonly GeoFeature[];
}

/**
 * topology + countries → GlobeIndex. 바인딩·코소보 규칙은 feature-binding(평면 geo-index와 공유).
 */
export function buildGlobeIndex(
  topology: TopologyLike,
  countries: readonly Country[],
): GlobeIndex {
  // topojson.feature: GeometryCollection → FeatureCollection.
  const fc = feature(
    topology as never,
    topology.objects.countries as never,
  ) as unknown as { features: GeoFeature[] };
  const features = fc.features;

  const featureByKey = new Map<string, GeoFeature>();
  features.forEach((f, i) => {
    featureByKey.set(featureKeyOf(f, i), f);
  });

  const countryByFeatureKey = buildCountryFeatureBinding(featureByKey, countries);
  // CountryId → featureKey 역인덱스(코소보 수동 바인딩 포함).
  const keyByCountry = new Map<CountryId, string>();
  for (const [key, id] of countryByFeatureKey) keyByCountry.set(id, key);

  const featureByCountry = new Map<CountryId, GeoFeature>();
  const anchor = new Map<CountryId, [number, number]>();
  const continent = new Map<CountryId, Continent>();
  for (const c of countries) {
    const key = keyByCountry.get(c.id);
    const f = key !== undefined ? featureByKey.get(key) : undefined;
    if (f) featureByCountry.set(c.id, f);
    // 앵커: latlng[위도,경도] → [경도,위도](d3-geo projection 입력 규약).
    const [lat, lng] = c.latlng;
    anchor.set(c.id, [lng, lat]);
    continent.set(c.id, c.continent);
  }

  // 중립 feature: 어떤 국가에도 귀속되지 않은 키(features 삽입 순서 유지 → 결정적).
  const neutralFeatures: GeoFeature[] = [];
  featureByKey.forEach((f, key) => {
    if (!countryByFeatureKey.has(key)) neutralFeatures.push(f);
  });

  return Object.freeze({
    features,
    featureByCountry,
    anchor,
    continent,
    neutralFeatures,
  }) satisfies GlobeIndex;
}

// ── 모듈 스코프 캐시(geo-index와 동일 패턴) ───────────────────────────────────
let cached: GlobeIndex | null = null;

/** 부팅 시 1회 구축·동결. 이후 동일 참조 반환. */
export function getGlobeIndex(topology: TopologyLike, countries: readonly Country[]): GlobeIndex {
  if (!cached) cached = buildGlobeIndex(topology, countries);
  return cached;
}

/** 테스트 전용: 모듈 캐시 리셋. */
export function __resetGlobeIndexCacheForTests(): void {
  cached = null;
}
