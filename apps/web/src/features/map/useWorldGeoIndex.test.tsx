// @vitest-environment jsdom
//
// spec: docs/03 §3.1(GeoIndex)·§4.4(훅 배치), WT-M2-06. topology fetch가 끝나면 GeoIndex를
// 노출하고, 실패해도(지도는 juice 배경일 뿐이므로) null로 안전하게 남는지 검증한다.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { __resetTopologyCacheForTests } from './topology-loader';
import { useWorldGeoIndex } from './useWorldGeoIndex';
import type { GeoIndex } from './geo-index';

const COUNTRY: Country = {
  id: 'KR',
  iso3: 'KOR',
  nameKo: '대한민국',
  nameEn: 'South Korea',
  aliasesKo: [],
  aliasesEn: [],
  continent: 'asia',
  subregion: '',
  difficultyTier: 1,
  capitalKo: '',
  capitalEn: '',
  flagEmoji: '🏳️',
  population: 0,
  latlng: [37, 127],
  mapFeatureId: null,
  acceptedInputsKo: ['대한민국'],
  acceptedInputsEn: ['south korea'],
};

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: [COUNTRY] },
    config: { mapUrl: '/data/countries-110m.json' },
    dataVersion: 'test',
  }),
}));

let captured: GeoIndex | null | undefined;
function Cap() {
  captured = useWorldGeoIndex();
  return null;
}

afterEach(() => {
  cleanup();
  captured = undefined;
  __resetTopologyCacheForTests();
  vi.unstubAllGlobals();
});

describe('useWorldGeoIndex', () => {
  it('topology fetch 성공 시 GeoIndex를 노출한다', async () => {
    const topology = {
      type: 'Topology',
      arcs: [],
      objects: { countries: { type: 'GeometryCollection', geometries: [] } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topology) }),
    );

    render(<Cap />);
    expect(captured).toBeNull(); // 첫 렌더는 로딩 중(null).
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured?.byCountry.get('KR')).toBeDefined();
  });

  it('fetch 실패 시 null로 남는다(지도는 juice 배경일 뿐 — 게임 진행에 무관)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    render(<Cap />);
    // 실패해도 예외를 던지지 않고 그냥 null 상태를 유지한다.
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toBeNull();
  });
});
