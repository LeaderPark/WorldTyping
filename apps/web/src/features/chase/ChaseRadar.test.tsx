// @vitest-environment jsdom
//
// spec: docs/09 §7.5·§8.3·§8.10, docs/09a §2·§4, docs/00 §11-D115-B, WT-CH-DEV-4 acceptance
// ("레이더 블립 좌표(bearing·스케일)·이벤트 갱신·reduced 정지·aria 요약").
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine } from '@wt/engine';
import type { CompiledChaseGraph, Country, CountryId } from '@wt/shared';
import { bearingDeg } from '../map/globe/globe-hop';
import '../../app/providers'; // i18next 전역 초기화(사이드이펙트) — CandidateCallouts.test.tsx와 동일
import { ChaseRadar, RADAR_MAX_KM, RADAR_R, RADAR_SIZE, radarPoint, radarRadius } from './ChaseRadar';

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn' | 'latlng'>): Country {
  return {
    iso3: 'XXX', aliasesKo: [], aliasesEn: [], continent: 'asia', subregion: '',
    difficultyTier: 2, capitalKo: '', capitalEn: '', flagEmoji: '🏳️', population: 0,
    mapFeatureId: null, acceptedInputsKo: [p.nameKo], acceptedInputsEn: [p.nameEn],
    ...p,
  };
}
// latlng는 [위도, 경도](countries.json 규약) — 컴포넌트가 [경도,위도]로 뒤집어 bearingDeg에 넘긴다.
const KR = mk({ id: 'KR', nameKo: '대한민국', nameEn: 'korea', latlng: [37, 127.5] });
const JP = mk({ id: 'JP', nameKo: '일본', nameEn: 'japan', latlng: [36, 138] }); // KR 기준 동쪽
const MN = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia', latlng: [46, 105] }); // KR 기준 북서
const US = mk({ id: 'US', nameKo: '미국', nameEn: 'usa', latlng: [38, -97] });
const ALL = [KR, JP, MN, US];

const KM: Record<string, number> = {
  'JP|KR': 1160, 'KR|MN': 2000, 'JP|MN': 3000, 'KR|US': 10_000, 'JP|US': 10_100, 'MN|US': 9_800,
};
const IDS: CountryId[] = ['KR', 'JP', 'MN', 'US'];
const GRAPH = {
  ids: IDS,
  index: (id: CountryId) => IDS.indexOf(id),
  has: (id: CountryId) => IDS.includes(id),
  dist: (a: CountryId, b: CountryId) => (a === b ? 0 : (KM[[a, b].sort().join('|')] ?? 0)),
  outNeighbors: () => [],
  undirectedNeighbors: () => [],
  homeEligible: () => true,
  homeEligibleIds: () => IDS,
} as unknown as CompiledChaseGraph;

function mockEngine(player: CountryId | null = 'KR', carriedCount = 0) {
  const listeners = new Set<(e: ChaseEngineEvent) => void>();
  const snapshot = { player, carriedCount };
  const engine = {
    subscribe: (f: (e: ChaseEngineEvent) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    getSnapshot: () => snapshot,
  } as unknown as ChaseSessionEngine;
  return {
    engine,
    setSnapshot: (over: Partial<typeof snapshot>) => Object.assign(snapshot, over),
    emit: (e: ChaseEngineEvent) => act(() => listeners.forEach((l) => l(e))),
  };
}

function renderRadar(engine: ChaseSessionEngine, reduced = false) {
  return render(
    <ChaseRadar engine={engine} graph={GRAPH} countries={ALL} homeId="KR" reduced={reduced} />,
  );
}

/** 현재국이 정해진 상태(= 홉 1회 완료 + candidatesShown)를 만든다. */
function arriveAt(emit: (e: ChaseEngineEvent) => void, to: CountryId): void {
  emit({ type: 'hopCommitted', hopIndex: 0, from: 'KR', to, ms: 400, errors: 0 });
  emit({ type: 'candidatesShown', hopIndex: 1, candidates: [] });
}

afterEach(cleanup);

describe('ChaseRadar — 스케일·좌표 수학(순수 함수)', () => {
  it('radarRadius: 0km는 중심, 최대 거리 이상은 최외곽 링에 클램프, 단조 증가', () => {
    expect(radarRadius(0)).toBe(0);
    expect(radarRadius(-5)).toBe(0);
    expect(radarRadius(RADAR_MAX_KM)).toBeCloseTo(RADAR_R, 6);
    expect(radarRadius(RADAR_MAX_KM * 3)).toBeCloseTo(RADAR_R, 6);
    expect(radarRadius(1000)).toBeLessThan(radarRadius(5000));
    expect(radarRadius(5000)).toBeLessThan(radarRadius(15_000));
  });

  it('radarRadius: 로그 스케일이라 근거리 해상도가 선형보다 높다', () => {
    const linear = (km: number): number => (km / RADAR_MAX_KM) * RADAR_R;
    expect(radarRadius(2000)).toBeGreaterThan(linear(2000));
  });

  it('radarPoint: 북쪽 고정 — 0°는 위(−y), 90°는 오른쪽, 180°는 아래', () => {
    const c = RADAR_SIZE / 2;
    const north = radarPoint(0, 5000);
    expect(north.x).toBeCloseTo(c, 6);
    expect(north.y).toBeLessThan(c);
    const east = radarPoint(90, 5000);
    expect(east.x).toBeGreaterThan(c);
    expect(east.y).toBeCloseTo(c, 6);
    const south = radarPoint(180, 5000);
    expect(south.y).toBeGreaterThan(c);
  });
});

describe('ChaseRadar — 블립 배치(bearing × 거리)', () => {
  it('금 블립이 bearingDeg·dist로 계산한 좌표에 찍힌다(링 등급별 반경)', () => {
    const { engine, emit } = mockEngine('KR');
    renderRadar(engine);
    emit({ type: 'goldSpawned', at: 'JP', ring: 'far' });

    const blip = screen.getByTestId('chase-radar').querySelector('[data-radar-blip="gold"]')!;
    const expected = radarPoint(bearingDeg([127.5, 37], [138, 36]), 1160);
    expect(Number(blip.getAttribute('cx'))).toBeCloseTo(expected.x, 1);
    expect(Number(blip.getAttribute('cy'))).toBeCloseTo(expected.y, 1);
    expect(blip.getAttribute('data-gold-ring')).toBe('far');
    // 동쪽 국가 → 중심보다 오른쪽.
    expect(Number(blip.getAttribute('cx'))).toBeGreaterThan(RADAR_SIZE / 2);
  });

  it('경찰 블립은 종류별 실루엣 + 근접(≤3,000km) 시에만 data-near=true', () => {
    const { engine, emit } = mockEngine('KR');
    renderRadar(engine);
    emit({
      type: 'policeUpdated',
      units: [
        { id: 1, kind: 'chaser', at: 'JP' }, // 1,160km → 근접
        { id: 2, kind: 'heli', at: 'US' }, // 10,000km → 원거리
      ],
      movedUnitId: null,
    });

    const police = screen.getByTestId('chase-radar').querySelectorAll('[data-radar-blip="police"]');
    expect(police).toHaveLength(2);
    expect(police[0]!.getAttribute('data-police-kind')).toBe('chaser');
    expect(police[0]!.getAttribute('data-near')).toBe('true');
    expect(police[1]!.getAttribute('data-police-kind')).toBe('heli');
    expect(police[1]!.getAttribute('data-near')).toBe('false');
  });

  it('현재국이 홈이면 홈 블립을 그리지 않고, 떠나면 다시 그린다', () => {
    const { engine, emit, setSnapshot } = mockEngine('KR');
    renderRadar(engine);
    // 초기 model.player는 null이라 어떤 블립도 없다 → 홈 도착 상태를 먼저 만든다.
    setSnapshot({ player: 'KR' });
    arriveAt(emit, 'KR');
    expect(screen.getByTestId('chase-radar').querySelector('[data-radar-blip="home"]')).toBeNull();

    setSnapshot({ player: 'MN' });
    arriveAt(emit, 'MN');
    const home = screen.getByTestId('chase-radar').querySelector('[data-radar-blip="home"]');
    expect(home).not.toBeNull();
    expect(home!.getAttribute('data-country')).toBe('KR');
  });
});

describe('ChaseRadar — 이벤트 갱신(신규 엔진 이벤트 0)', () => {
  it('goldSpawned/goldPicked로 금 블립이 증감한다', () => {
    const { engine, emit } = mockEngine('KR');
    renderRadar(engine);
    const golds = (): number =>
      screen.getByTestId('chase-radar').querySelectorAll('[data-radar-blip="gold"]').length;

    emit({ type: 'goldSpawned', at: 'JP', ring: 'near' });
    emit({ type: 'goldSpawned', at: 'MN', ring: 'mid' });
    expect(golds()).toBe(2);

    emit({ type: 'goldPicked', at: 'JP', ring: 'near' });
    expect(golds()).toBe(1);
  });

  it('hopCommitted로 현재국이 바뀌면 같은 대상의 블립 좌표가 재계산된다', () => {
    const { engine, emit, setSnapshot } = mockEngine('KR');
    renderRadar(engine);
    emit({ type: 'goldSpawned', at: 'US', ring: 'far' });
    const before = screen
      .getByTestId('chase-radar')
      .querySelector('[data-radar-blip="gold"]')!
      .getAttribute('cx');

    setSnapshot({ player: 'MN' });
    arriveAt(emit, 'MN');
    const after = screen
      .getByTestId('chase-radar')
      .querySelector('[data-radar-blip="gold"]')!
      .getAttribute('cx');
    expect(after).not.toBe(before);
  });

  it('배송 중(carried>0)이면 data-delivering=true로 홈을 강조한다', () => {
    const { engine, emit, setSnapshot } = mockEngine('MN');
    renderRadar(engine);
    setSnapshot({ player: 'MN', carriedCount: 2 });
    emit({ type: 'goldPicked', at: 'MN', ring: 'mid' });
    expect(screen.getByTestId('chase-radar')).toHaveAttribute('data-delivering', 'true');

    setSnapshot({ carriedCount: 0 });
    emit({ type: 'delivered', count: 2, payout: 1400, starsAfter: 1 });
    expect(screen.getByTestId('chase-radar')).toHaveAttribute('data-delivering', 'false');
  });
});

describe('ChaseRadar — ★상승 스윕(§11-D111 ②-b 동기)', () => {
  it('wantedChanged up에 스윕 클래스가 붙고 down에는 붙지 않는다', () => {
    const { engine, emit } = mockEngine('KR');
    renderRadar(engine);
    const sweep = screen.getByTestId('chase-radar-sweep');
    expect(sweep.getAttribute('class')).not.toContain('is-sweeping');

    emit({ type: 'wantedChanged', stars: 1, direction: 'up' });
    expect(sweep.getAttribute('class')).toContain('is-sweeping');

    sweep.classList.remove('is-sweeping');
    emit({ type: 'wantedChanged', stars: 1, direction: 'down' });
    expect(sweep.getAttribute('class')).not.toContain('is-sweeping');
  });

  it('reduced=true면 스윕을 재생하지 않는다(§11 강등표)', () => {
    const { engine, emit } = mockEngine('KR');
    renderRadar(engine, true);
    emit({ type: 'wantedChanged', stars: 2, direction: 'up' });
    expect(screen.getByTestId('chase-radar-sweep').getAttribute('class')).not.toContain('is-sweeping');
  });
});

describe('ChaseRadar — a11y(§8.10)', () => {
  it('role=img + 금/경찰/홈 요약 aria-label(i18n 키 기반)', () => {
    const { engine, emit, setSnapshot } = mockEngine('KR');
    renderRadar(engine);
    setSnapshot({ player: 'MN' });
    arriveAt(emit, 'MN');
    emit({ type: 'goldSpawned', at: 'JP', ring: 'near' });
    emit({ type: 'policeUpdated', units: [{ id: 1, kind: 'chaser', at: 'US' }], movedUnitId: null });

    const svg = screen.getByTestId('chase-radar-svg');
    expect(svg).toHaveAttribute('role', 'img');
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).not.toBe('');
    expect(label).not.toBe('chase.radar.summary'); // 키가 아니라 번역된 문장
    expect(label).toContain('1'); // 금 1곳
    expect(label).toContain('2000'); // 홈(KR)까지 2,000km
  });
});
