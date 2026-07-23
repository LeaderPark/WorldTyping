// spec: docs/03 §3.4(computeCamera 산식·K_MAX=8·패딩·중심 정렬), WT-M2-04 지시 5.
import { describe, expect, it } from 'vitest';
import type { Continent, CountryId } from '@wt/shared';
import {
  K_MAX,
  LEG_DURATION_MS,
  LEG_PADDING,
  WORLD_CAMERA,
  cameraTransform,
  computeCamera,
  computeLegCamera,
} from './camera';
import type { CountryGeo, GeoIndex } from './geo-index';

/** 합성 GeoIndex — computeCamera는 byCountry.bounds만 소비한다. */
function mkIndex(
  entries: Array<[CountryId, [[number, number], [number, number]]]>,
): GeoIndex {
  const byCountry = new Map<CountryId, CountryGeo>();
  for (const [id, bounds] of entries) {
    const cx = (bounds[0][0] + bounds[1][0]) / 2;
    const cy = (bounds[0][1] + bounds[1][1]) / 2;
    byCountry.set(id, {
      featureId: id,
      centroid: [cx, cy],
      bounds,
      continent: 'asia' as Continent,
    });
  }
  return {
    paths: new Map(),
    byCountry,
    neutralFeatureIds: [],
    circleFallback: new Map(),
  };
}

describe('computeCamera', () => {
  it('빈 집합/미존재 id → 월드 고정 폴백', () => {
    const idx = mkIndex([['A', [[100, 100], [200, 200]]]]);
    expect(computeCamera(idx, [])).toEqual(WORLD_CAMERA);
    expect(computeCamera(idx, ['ZZ'])).toEqual(WORLD_CAMERA);
  });

  it('중심 정렬: 스케일 후 bounds 중심이 viewBox 중앙(480,250)으로', () => {
    const idx = mkIndex([['A', [[200, 100], [600, 300]]]]);
    const cam = computeCamera(idx, ['A']);
    const cx = (200 + 600) / 2;
    const cy = (100 + 300) / 2;
    expect(cam.x).toBeCloseTo(480 - cam.k * cx, 6);
    expect(cam.y).toBeCloseTo(250 - cam.k * cy, 6);
  });

  it('K_MAX=8 상한: 아주 작은 bounds는 8로 클램프', () => {
    const idx = mkIndex([['A', [[479, 249], [481, 251]]]]); // 2×2
    const cam = computeCamera(idx, ['A']);
    expect(cam.k).toBe(K_MAX);
    expect(cam.k).toBe(8);
  });

  it('영차원 bounds(단일 점)도 NaN 없이 K_MAX', () => {
    const idx = mkIndex([['A', [[480, 250], [480, 250]]]]);
    const cam = computeCamera(idx, ['A']);
    expect(cam.k).toBe(K_MAX);
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
  });

  it('패딩 반영: 패딩이 클수록 k가 작아진다(여백 증가)', () => {
    // 큰 bounds라 두 패딩 모두 k<8 → 패딩이 스케일에 실제 반영된다.
    const idx = mkIndex([['A', [[0, 0], [400, 200]]]]);
    const tight = computeCamera(idx, ['A'], 40);
    const loose = computeCamera(idx, ['A'], 120);
    expect(loose.k).toBeLessThan(tight.k);
    expect(tight.k).toBeLessThan(8);
  });

  it('여러 국가 bounds 합집합을 프레임에 맞춘다', () => {
    const idx = mkIndex([
      ['A', [[0, 0], [100, 100]]],
      ['B', [[800, 400], [900, 480]]],
    ]);
    const cam = computeCamera(idx, ['A', 'B'], 40);
    const bw = 900 - 0;
    const bh = 480 - 0;
    const expectedK = Math.min((960 - 80) / bw, (500 - 80) / bh, 8);
    expect(cam.k).toBeCloseTo(expectedK, 6);
  });
});

describe('cameraTransform', () => {
  it('translate+scale 문자열', () => {
    expect(cameraTransform({ x: 10, y: 20, k: 2 })).toBe('translate(10 20) scale(2)');
    expect(cameraTransform(WORLD_CAMERA)).toBe('translate(0 0) scale(1)');
  });
});

describe('computeLegCamera(§11-D63) — 현 구간 추적 + 날짜변경선 월드 폴백', () => {
  it('비-래핑 leg는 computeCamera와 동일 결과', () => {
    const idx = mkIndex([
      ['A', [[100, 100], [180, 180]]],
      ['B', [[200, 120], [260, 200]]],
    ]);
    const leg = computeLegCamera(idx, ['A', 'B'], LEG_PADDING);
    const plain = computeCamera(idx, ['A', 'B'], LEG_PADDING);
    expect(leg).toEqual(plain);
  });

  it('leg centroid x 폭이 뷰포트 절반(480) 초과면 월드 고정 폴백', () => {
    // A centroid x≈50, B centroid x≈900 → 폭 850 > 480 → 월드 폴백.
    const idx = mkIndex([
      ['A', [[0, 100], [100, 200]]],
      ['B', [[850, 100], [950, 200]]],
    ]);
    expect(computeLegCamera(idx, ['A', 'B'])).toEqual(WORLD_CAMERA);
  });

  it('빈/미존재 집합은 월드 고정', () => {
    const idx = mkIndex([['A', [[100, 100], [200, 200]]]]);
    expect(computeLegCamera(idx, [])).toEqual(WORLD_CAMERA);
    expect(computeLegCamera(idx, ['ZZ'])).toEqual(WORLD_CAMERA);
  });

  it('LEG 프리셋 상수 노출(padding 70·duration 600)', () => {
    expect(LEG_PADDING).toBe(70);
    expect(LEG_DURATION_MS).toBe(600);
  });
});
