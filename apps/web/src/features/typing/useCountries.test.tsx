// @vitest-environment jsdom
//
// spec: docs/03 §4.4(useCountries — byId/route), docs/00 §11-D21(티어/데일리 로컬 플레이스홀더),
//       WT-M2-06. useGameSession(WT-M2-03)이 이 훅으로 리팩터된 뒤에도 동일한 결정적 결과를
//       내는지 검증한다(순서 불일치 방지 — 엔진 배정과 ProgressLine 등 표시 계층의 단일 원천).
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { CONTINENT_ROUTES, ROUTE_WORLD_TOUR } from '@wt/data/content/routes';
import { useCountries, type UseCountriesResult } from './useCountries';

function mk(id: string, nameKo: string, continent: Country['continent'], tier: Country['difficultyTier']): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo,
    nameEn: id.toLowerCase(),
    aliasesKo: [],
    aliasesEn: [],
    continent,
    subregion: '',
    difficultyTier: tier,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '🏳️',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [nameKo],
    acceptedInputsEn: [id.toLowerCase()],
  };
}

const DATASET: Country[] = [
  mk('GH', '가나', 'africa', 3),
  mk('KR', '대한민국', 'asia', 1),
  mk('MN', '몽골', 'asia', 4),
  mk('US', '미국', 'north-america', 1),
  mk('TW', '대만', 'asia', 2), // extended — 티어/데일리 로컬 풀에서 제외
];

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: DATASET },
    config: {},
    dataVersion: 'test',
  }),
}));

let captured: UseCountriesResult | null = null;
function Cap() {
  captured = useCountries();
  return null;
}

afterEach(() => {
  cleanup();
  captured = null;
});

describe('useCountries', () => {
  it('continent: routes.ts 고정 순서를 데이터셋과 무관하게 그대로 반환한다', () => {
    render(<Cap />);
    expect(captured!.route('continent', 'asia')).toEqual(CONTINENT_ROUTES.asia);
  });

  it('알 수 없는 continent trackId는 throw한다', () => {
    render(<Cap />);
    expect(() => captured!.route('continent', 'atlantis')).toThrow(/unknown continent/);
  });

  it('worldtour: ROUTE_WORLD_TOUR 그대로', () => {
    render(<Cap />);
    expect(captured!.route('worldtour', 'world')).toEqual(ROUTE_WORLD_TOUR);
  });

  it('tier: extended(TW) 제외 + 결정적 순서(동일 trackId 재호출 시 동일 결과)', () => {
    render(<Cap />);
    const a = captured!.route('tier', '1');
    const b = captured!.route('tier', '1');
    expect(a).toEqual(b);
    expect(a).not.toContain('TW');
    expect([...a].sort()).toEqual(['KR', 'US']); // tier 1: KR, US (GH=3, MN=4, TW=2·extended 제외) — 셔플 순서 무관 집합 비교.
  });

  it('daily: extended 제외 풀에서 결정적 세트를 구성한다(오늘 날짜 고정 시드)', () => {
    render(<Cap />);
    const a = captured!.route('daily', 'today');
    const b = captured!.route('daily', 'today');
    expect(a).toEqual(b);
    expect(a).not.toContain('TW');
    expect(a.length).toBe(4); // GH,KR,MN,US(TW 제외) 전부 20 미만이라 그대로.
  });

  it('race는 멀티 전용이라 throw한다', () => {
    render(<Cap />);
    expect(() => captured!.route('race', 'x')).toThrow(/race/);
  });

  it('byId: 존재하는 id는 Country를 반환, 배정 밖 id는 throw', () => {
    render(<Cap />);
    expect(captured!.byId('KR').nameKo).toBe('대한민국');
    expect(() => captured!.byId('ZZ')).toThrow(/unknown country id/);
  });
});
