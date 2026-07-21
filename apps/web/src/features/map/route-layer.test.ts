// spec: docs/03 §3.5(quadratic Bézier·12% 법선 오프셋·날짜변경선 2-패스·합성 path), WT-M2-04 지시 5.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import { buildGeoIndex, type TopologyLike } from './geo-index';
import {
  compositeRoutePath,
  needsAntimeridianWrap,
  quadraticBezierPath,
  routeSegmentPaths,
} from './route-layer';

function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

describe('needsAntimeridianWrap — 리터럴 좌표', () => {
  it('x 거리가 뷰포트 절반(480) 초과면 true', () => {
    // FJ centroid ≈ [911,303], TO ≈ [22,312] (실측). |889| > 480.
    expect(needsAntimeridianWrap([911, 303], [22, 312])).toBe(true);
  });
  it('인접 유럽처럼 가까우면 false', () => {
    // FR ≈ [470,120], DE ≈ [504,93]. |34| < 480.
    expect(needsAntimeridianWrap([470, 120], [504, 93])).toBe(false);
  });
  it('정확히 절반이면 false(초과만 true)', () => {
    expect(needsAntimeridianWrap([0, 0], [480, 0])).toBe(false);
    expect(needsAntimeridianWrap([0, 0], [481, 0])).toBe(true);
  });
});

describe('needsAntimeridianWrap — 실 GeoIndex centroid(FJ→TO true, FR→DE false)', () => {
  const topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  const index = buildGeoIndex(topo, dataset.countries);
  const c = (id: string) => index.byCountry.get(id)!.centroid;

  it('FJ→TO는 날짜변경선 래핑', () => {
    expect(needsAntimeridianWrap(c('FJ'), c('TO'))).toBe(true);
  });
  it('FR→DE는 래핑 아님', () => {
    expect(needsAntimeridianWrap(c('FR'), c('DE'))).toBe(false);
  });
});

describe('quadraticBezierPath', () => {
  it('M...Q... 형태(제어점 = 중점 법선 12% 오프셋)', () => {
    const d = quadraticBezierPath([0, 0], [100, 0]);
    expect(d).toMatch(/^M0 0 Q/);
    // 수평 세그먼트의 제어점은 y로 12% 오프셋(len=100 → 12).
    expect(d).toContain('Q50 12 100 0');
  });
  it('길이 0(동일 점)은 M만', () => {
    expect(quadraticBezierPath([5, 5], [5, 5])).toBe('M5 5');
  });
});

describe('routeSegmentPaths', () => {
  it('비래핑은 1개 세그먼트', () => {
    const segs = routeSegmentPaths([100, 100], [300, 200]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatch(/^M100 100 Q/);
  });
  it('날짜변경선 래핑(동진: 오른쪽→왼쪽)은 2-패스', () => {
    const segs = routeSegmentPaths([911, 303], [22, 312]);
    expect(segs).toHaveLength(2);
    // 1패스는 from에서 시작해 오른쪽 밖(>960)으로, 2패스는 왼쪽 밖(<0)에서 to로.
    expect(segs[0]).toMatch(/^M911 303 Q/);
    expect(segs[0]).toContain('1008'); // 960 + OVERSHOOT(48)
    expect(segs[1]).toContain('-48'); // -OVERSHOOT
    expect(segs[1]).toMatch(/22 312$/);
  });
  it('날짜변경선 래핑(서진: 왼쪽→오른쪽)도 2-패스', () => {
    const segs = routeSegmentPaths([22, 312], [911, 303]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toContain('-48'); // 왼쪽 밖으로 exit
    expect(segs[1]).toContain('1008'); // 오른쪽 밖에서 재진입
  });
});

describe('compositeRoutePath', () => {
  it('연속 방문점을 이어붙인 합성 path', () => {
    const d = compositeRoutePath([
      [0, 0],
      [100, 0],
      [200, 50],
    ]);
    // 2개 세그먼트(비래핑) → 2개의 M...Q...
    expect(d.match(/M/g)).toHaveLength(2);
  });
  it('점 1개 이하면 빈 문자열', () => {
    expect(compositeRoutePath([])).toBe('');
    expect(compositeRoutePath([[0, 0]])).toBe('');
  });
});
