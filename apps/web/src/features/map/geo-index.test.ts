// spec: docs/03 §3.1(GeoIndex), docs/02 §7(초소국 circle·코소보·중립 feature), WT-M2-04 지시 5.
// 산출물 파일(public/data)을 직접 로드해 실데이터로 검증한다(세션 조정 3항).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import {
  __resetGeoIndexCacheForTests,
  buildGeoIndex,
  getGeoIndex,
  type GeoIndex,
  type TopologyLike,
} from './geo-index';

// public/data 산출물 로드. node/jsdom 양 환경, cwd=apps/web 또는 레포 루트 모두에서 동작하도록
// 후보 경로를 탐색한다(jsdom에서 import.meta.url이 file: 스킴이 아니라 못 쓰는 문제 회피).
function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let topo: TopologyLike;
let countries: Country[];
let index: GeoIndex;

beforeAll(() => {
  topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  countries = dataset.countries;
  index = buildGeoIndex(topo, countries);
});

describe('buildGeoIndex — 기본 구조', () => {
  it('모든 국가가 byCountry에 존재(폴리곤+circle 합)', () => {
    expect(index.byCountry.size).toBe(countries.length);
  });
  it('paths는 topojson feature 수(177)만큼', () => {
    const featureCount = topo.objects.countries.geometries.length;
    expect(index.paths.size).toBe(featureCount);
    expect(featureCount).toBe(177);
  });
  it('폴리곤 국가는 featureId·유효 d·뷰포트 내 centroid를 가진다(KR 예)', () => {
    const kr = index.byCountry.get('KR');
    expect(kr).toBeDefined();
    expect(kr?.featureId).toBe('410');
    const d = index.paths.get('410');
    expect(d && d.length).toBeGreaterThan(0);
    const [x, y] = kr!.centroid;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(960);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(500);
  });
});

describe('초소국 circle 폴백(02 §7a)', () => {
  it('circleFallback 개수 > 0', () => {
    expect(index.circleFallback.size).toBeGreaterThan(0);
  });
  it('mapFeatureId=null 국가만 circle(코소보 제외 — 수동 폴리곤 바인딩)', () => {
    for (const c of countries) {
      const isCircle = index.circleFallback.has(c.id);
      if (c.mapFeatureId === null && c.id !== 'XK') {
        expect(isCircle).toBe(true);
      }
    }
    // 대표 초소국은 반드시 circle(dot).
    for (const id of ['MC', 'SM', 'VA', 'SG', 'NR', 'TV']) {
      expect(index.circleFallback.has(id)).toBe(true);
    }
  });
  it('circle 국가는 byCountry featureId=null, circle 좌표=centroid 일치', () => {
    const mc = index.byCountry.get('MC');
    expect(mc?.featureId).toBeNull();
    expect(index.circleFallback.get('MC')).toEqual(mc?.centroid);
  });
});

describe('코소보 수동 바인딩(02 §7c, 03 §3.1) — 경로 존재', () => {
  it('XK는 circle이 아니라 폴리곤 path로 표현된다', () => {
    const xk = index.byCountry.get('XK');
    expect(xk).toBeDefined();
    expect(xk?.featureId).not.toBeNull();
    expect(index.circleFallback.has('XK')).toBe(false);
    const d = index.paths.get(xk!.featureId!);
    expect(typeof d).toBe('string');
    expect(d!.length).toBeGreaterThan(0);
  });
  it('코소보 feature 키는 중립으로 분류되지 않는다(XK에 귀속)', () => {
    const xk = index.byCountry.get('XK')!;
    expect(index.neutralFeatureIds).not.toContain(xk.featureId);
  });
});

describe('중립 feature(02 §7b)', () => {
  it('데이터셋 밖 속령은 neutral(그린란드 304 등), 어떤 국가에도 귀속되지 않음', () => {
    expect(index.neutralFeatureIds).toContain('304'); // Greenland
    const boundFeatureIds = new Set(
      [...index.byCountry.values()].map((g) => g.featureId).filter((f): f is string => f !== null),
    );
    for (const nid of index.neutralFeatureIds) {
      expect(boundFeatureIds.has(nid)).toBe(false);
    }
  });
  it('neutralFeatureIds는 정렬되어 결정적', () => {
    expect([...index.neutralFeatureIds]).toEqual([...index.neutralFeatureIds].sort());
  });
});

describe('결정성', () => {
  it('두 번 빌드해도 paths·byCountry가 동일', () => {
    const a = buildGeoIndex(topo, countries);
    const b = buildGeoIndex(topo, countries);
    expect([...a.paths.entries()]).toEqual([...b.paths.entries()]);
    expect([...a.byCountry.entries()]).toEqual([...b.byCountry.entries()]);
    expect([...a.circleFallback.entries()]).toEqual([...b.circleFallback.entries()]);
    expect([...a.neutralFeatureIds]).toEqual([...b.neutralFeatureIds]);
  });
  it('반환 객체는 동결(Object.freeze)', () => {
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.neutralFeatureIds)).toBe(true);
  });
});

describe('getGeoIndex — 모듈 스코프 캐시(docs/03 §3.1)', () => {
  it('동일 인자에 동일 참조, reset 후 새 인스턴스', () => {
    __resetGeoIndexCacheForTests();
    const a = getGeoIndex(topo, countries);
    const b = getGeoIndex(topo, countries);
    expect(a).toBe(b);
    __resetGeoIndexCacheForTests();
    const c = getGeoIndex(topo, countries);
    expect(c).not.toBe(a);
    __resetGeoIndexCacheForTests();
  });
});
