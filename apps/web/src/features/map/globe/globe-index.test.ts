// spec: docs/03 §3.7(GlobeIndex, 00 §11-D67), docs/02 §7(코소보·초소국·중립 feature), WT-DC-08.
// 산출물(public/data)을 직접 로드해 실데이터로 검증한다(geo-index.test.ts와 동일 패턴).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import type { TopologyLike } from '../geo-index';
import {
  __resetGlobeIndexCacheForTests,
  buildGlobeIndex,
  getGlobeIndex,
  type GlobeIndex,
} from './globe-index';

function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let topo: TopologyLike;
let countries: Country[];
let index: GlobeIndex;

beforeAll(() => {
  topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  countries = dataset.countries;
  index = buildGlobeIndex(topo, countries);
});

describe('buildGlobeIndex — 기본 구조', () => {
  it('features는 topojson feature 수(177)', () => {
    expect(index.features).toHaveLength(topo.objects.countries.geometries.length);
    expect(index.features).toHaveLength(177);
  });
  it('anchor·continent는 전 국가에 존재', () => {
    expect(index.anchor.size).toBe(countries.length);
    expect(index.continent.size).toBe(countries.length);
  });
  it('폴리곤 국가는 featureByCountry에 feature를 가진다(KR)', () => {
    const kr = index.featureByCountry.get('KR');
    expect(kr).toBeDefined();
    expect(kr?.properties?.name ?? kr?.id).toBeDefined();
    expect(index.continent.get('KR')).toBe('asia');
  });
});

describe('anchor = latlng 역순([위도,경도] → [경도,위도])', () => {
  it('전 국가 anchor가 latlng를 뒤집은 값', () => {
    for (const c of countries) {
      const a = index.anchor.get(c.id);
      expect(a).toBeDefined();
      expect(a![0]).toBe(c.latlng[1]); // 경도
      expect(a![1]).toBe(c.latlng[0]); // 위도
    }
  });
});

describe('코소보 수동 바인딩(02 §7c)', () => {
  it('XK는 featureByCountry에 폴리곤으로 바인딩된다', () => {
    const xk = index.featureByCountry.get('XK');
    expect(xk).toBeDefined();
    expect(xk?.properties?.name).toBe('Kosovo');
  });
});

describe('초소국(mapFeatureId=null) — 폴리곤 없음·앵커만', () => {
  it('MC/SM/VA 등은 featureByCountry 부재, anchor는 존재', () => {
    for (const id of ['MC', 'SM', 'VA', 'NR', 'TV']) {
      expect(index.featureByCountry.has(id)).toBe(false);
      expect(index.anchor.has(id)).toBe(true);
    }
  });
});

describe('중립 feature(02 §7b)', () => {
  it('어떤 국가에도 귀속되지 않은 feature가 존재하고, featureByCountry와 겹치지 않는다', () => {
    expect(index.neutralFeatures.length).toBeGreaterThan(0);
    const bound = new Set(index.featureByCountry.values());
    for (const f of index.neutralFeatures) {
      expect(bound.has(f)).toBe(false);
    }
  });
});

describe('결정성·동결', () => {
  it('두 번 빌드해도 anchor·continent·featureByCountry 키가 동일', () => {
    const a = buildGlobeIndex(topo, countries);
    const b = buildGlobeIndex(topo, countries);
    expect([...a.anchor.entries()]).toEqual([...b.anchor.entries()]);
    expect([...a.continent.entries()]).toEqual([...b.continent.entries()]);
    expect([...a.featureByCountry.keys()]).toEqual([...b.featureByCountry.keys()]);
    expect(a.neutralFeatures.length).toBe(b.neutralFeatures.length);
  });
  it('반환 객체는 동결(Object.freeze)', () => {
    expect(Object.isFrozen(index)).toBe(true);
  });
});

describe('getGlobeIndex — 모듈 스코프 캐시', () => {
  it('동일 인자에 동일 참조, reset 후 새 인스턴스', () => {
    __resetGlobeIndexCacheForTests();
    const a = getGlobeIndex(topo, countries);
    const b = getGlobeIndex(topo, countries);
    expect(a).toBe(b);
    __resetGlobeIndexCacheForTests();
    const c = getGlobeIndex(topo, countries);
    expect(c).not.toBe(a);
    __resetGlobeIndexCacheForTests();
  });
});
