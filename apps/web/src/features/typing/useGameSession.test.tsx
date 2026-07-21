// @vitest-environment jsdom
//
// spec: docs/03 §4.4(useGameSession), §5.1(엔진 생명주기), docs/00 §11-D2. WT-M2-03.
import { cleanup, render, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { useGameSession, type UseGameSessionResult } from './useGameSession';

// bootLoader.getBootData를 픽스처 데이터셋으로 대체(부팅 fetch 없이 훅을 단위 검증).
const DATASET: Country[] = [
  mk('GH', '가나', 'africa', 3),
  mk('KR', '대한민국', 'asia', 1),
  mk('MN', '몽골', 'asia', 4),
  mk('US', '미국', 'north-america', 1),
];
function mk(id: string, nameKo: string, continent: Country['continent'], tier: number): Country {
  return {
    id, iso3: id + 'X', nameKo, nameEn: id.toLowerCase(), aliasesKo: [], aliasesEn: [],
    continent, subregion: '', difficultyTier: tier as Country['difficultyTier'],
    capitalKo: '', capitalEn: '', flagEmoji: '🏳️', population: 0, latlng: [0, 0],
    mapFeatureId: null, acceptedInputsKo: [nameKo], acceptedInputsEn: [id.toLowerCase()],
  };
}

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: DATASET },
    config: {},
    dataVersion: 'test',
  }),
}));

let captured: UseGameSessionResult | null = null;
function Cap({ mode, trackId }: { mode: Parameters<typeof useGameSession>[0]['mode']; trackId: string }) {
  captured = useGameSession({ mode, trackId });
  return null;
}

afterEach(() => {
  cleanup();
  captured = null;
});

describe('useGameSession', () => {
  it('continent: 라우트에서 데이터셋에 존재하는 국가만 걸러 엔진을 만든다(africa→GH)', () => {
    render(<Cap mode="continent" trackId="africa" />);
    const snap = captured!.engine.getSnapshot();
    expect(snap.mode).toBe('continent');
    expect(snap.countryCount).toBeGreaterThanOrEqual(1);
    expect(snap.currentCountryId).toBeNull(); // 아직 미시작
  });

  it('worldtour: ROUTE_WORLD_TOUR 기반으로 엔진을 만든다', () => {
    render(<Cap mode="worldtour" trackId="world" />);
    expect(captured!.engine.getSnapshot().mode).toBe('worldtour');
    expect(captured!.engine.getSnapshot().countryCount).toBeGreaterThanOrEqual(1);
  });

  it('tier: 해당 티어 국가를 결정적으로 뽑는다(tier 3 → GH)', () => {
    render(<Cap mode="tier" trackId="3" />);
    expect(captured!.engine.getSnapshot().countryCount).toBe(1);
  });

  it('daily: extended 제외 풀에서 결정적으로 세트를 구성한다', () => {
    render(<Cap mode="daily" trackId="today" />);
    expect(captured!.engine.getSnapshot().countryCount).toBeGreaterThanOrEqual(1);
  });

  it('start()가 카운트다운으로 전이한다', () => {
    render(<Cap mode="continent" trackId="asia" />);
    act(() => captured!.start());
    expect(captured!.engine.getSnapshot().phase).toBe('countdown');
    act(() => captured!.abort());
    expect(captured!.engine.getSnapshot().phase).toBe('aborted');
  });

  it('race는 싱글 훅에서 거부된다(멀티 전용)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Cap mode="race" trackId="x" />)).toThrow(/race/);
    spy.mockRestore();
  });
});
