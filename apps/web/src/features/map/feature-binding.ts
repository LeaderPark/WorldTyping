// spec: docs/02 §7(mapFeatureId 바인딩·코소보 특례·중립 feature), docs/03 §3.1(feature 키),
//       docs/00 §11-D67(지구본 무대와 평면 지도가 동일 바인딩 규칙을 공유), WT-DC-08.
//
// geo-index.ts(평면 WorldMap)와 globe/globe-index.ts(지구본 GlobeMap)가 topojson feature ↔
// CountryId 바인딩 규칙(featureKeyOf + 코소보 수동 폴리곤 바인딩, 02 §7)을 **한 벌만** 갖도록
// 추출한 순수 헬퍼다. DOM/d3 의존 없음(문자열 키 + Map)이라 node 환경에서 부작용 없이 import된다.
// 리팩터 불변식: geo-index의 기존 동작을 바이트 단위로 보존한다(원래 인라인 로직을 그대로 옮김).

import type { Country, CountryId } from '@wt/shared';

/** topojson feature 최소 형태(소비 필드만). geo-index/globe-index 공통. */
export interface GeoFeature {
  id?: string | number;
  properties?: { name?: string } | null;
  [k: string]: unknown;
}

/** feature.id 또는 (id 부재 시) name 기반 안정적 합성 키. 무-id feature 간 키 충돌 방지. */
export function featureKeyOf(f: GeoFeature, index: number): string {
  if (f.id !== undefined && f.id !== null && f.id !== '') return String(f.id);
  const name = f.properties?.name;
  return name ? `x:${name}` : `x:__${index}`;
}

/**
 * featureKey → CountryId 바인딩 맵을 만든다. mapFeatureId 직접 바인딩 + 코소보 수동 바인딩
 * (02 §7c: XK는 numeric id가 없어 properties.name==='Kosovo' feature에 수동 연결)을 포함한다.
 * 평면(geo-index)·지구본(globe-index) 양쪽이 이 한 함수를 재사용해 바인딩 규칙을 일원화한다(D67).
 */
export function buildCountryFeatureBinding(
  featureByKey: ReadonlyMap<string, GeoFeature>,
  countries: readonly Country[],
): Map<string, CountryId> {
  const countryByFeatureKey = new Map<string, CountryId>();
  for (const c of countries) {
    if (c.mapFeatureId !== null) countryByFeatureKey.set(c.mapFeatureId, c.id);
  }
  // 코소보 수동 바인딩(02 §7c). XK가 미바인딩(null)이고 Kosovo feature가 있으면 폴리곤 연결.
  const xk = countries.find((c) => c.id === 'XK');
  if (xk && xk.mapFeatureId === null) {
    const kosovoEntry = [...featureByKey.entries()].find(([, f]) => f.properties?.name === 'Kosovo');
    if (kosovoEntry) countryByFeatureKey.set(kosovoEntry[0], 'XK');
  }
  return countryByFeatureKey;
}
