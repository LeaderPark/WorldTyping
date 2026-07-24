// @vitest-environment jsdom
//
// spec: docs/00 §11-D67-⑦·D68-⑦, docs/03 §3.7·§4.5, WT-AUTH-07 acceptance("드라이버 유닛: 가짜
// 핸들 홉 시퀀스·reset·reduced-motion·hidden").
//
// 대부분의 검증은 startHomeGlobeDemo(순수 함수, React 미경유)를 "가짜 핸들"(vi.fn() 전부)로
// 직접 구동해 홉 시퀀스·16홉 reset·reduced-motion·pause/resume(hidden 대응)을 확인한다 — 실제
// GlobeMap/canvas/d3-geo/topology 없이도 드라이버 로직 전체가 결정적으로 재현된다. 마지막
// describe만 HomeGlobe 컴포넌트 자체의 배선(마운트 시 onReady→드라이버 시작, unmount→stop,
// document.hidden→pause/resume)을 GlobeMap/useGlobeIndex/bootLoader를 목킹해 검증한다.
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Country, CountryId } from '@wt/shared';
import type { GlobeMapHandle } from '../../features/map/globe/GlobeMap';
import {
  HOME_GLOBE_MAX_HOP_DELAY_MS,
  HOME_GLOBE_MIN_HOP_DELAY_MS,
  HOME_GLOBE_RESET_EVERY_HOPS,
  HomeGlobe,
  selectHomeGlobeDestinations,
  startHomeGlobeDemo,
} from './HomeGlobe';

function createFakeHandle(): GlobeMapHandle {
  return {
    setTarget: vi.fn(),
    markSolved: vi.fn(),
    markSkipped: vi.fn(),
    drawRouteSegment: vi.fn(),
    moveVehicle: vi.fn(),
    flyTo: vi.fn(),
    reset: vi.fn(),
    setJuiceLevel: vi.fn(),
    setVehicleVisible: vi.fn(),
    setWaypointLabels: vi.fn(),
    pulseCheckpointRing: vi.fn(),
    setIdleSpin: vi.fn(),
  };
}

const continentOf = (): 'asia' => 'asia';
const DESTS: CountryId[] = ['KR', 'JP', 'CN'];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startHomeGlobeDemo — 홉 시퀀스', () => {
  it('reducedMotion=true면 idle spin도 홉도 전혀 발생하지 않는다', () => {
    const handle = createFakeHandle();
    startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, reducedMotion: true, random: () => 0.9 });
    vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 20);
    expect(handle.setIdleSpin).not.toHaveBeenCalled();
    expect(handle.moveVehicle).not.toHaveBeenCalled();
    expect(handle.drawRouteSegment).not.toHaveBeenCalled();
    expect(handle.markSolved).not.toHaveBeenCalled();
  });

  it('destinations가 비어있으면 idle spin은 켜지되(reducedMotion=false) 홉은 없다', () => {
    const handle = createFakeHandle();
    startHomeGlobeDemo({ handle, destinations: [], continentOf, random: () => 0.9 });
    expect(handle.setIdleSpin).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 20);
    expect(handle.moveVehicle).not.toHaveBeenCalled();
    expect(handle.drawRouteSegment).not.toHaveBeenCalled();
    expect(handle.markSolved).not.toHaveBeenCalled();
    expect(handle.reset).not.toHaveBeenCalled();
  });

  it('첫 홉: moveVehicle(id,id,{durationMs:0})만 호출(노선 없음)', () => {
    const handle = createFakeHandle();
    // floor(0.9*3)=2 → destinations[2]='CN', exclude=null이라 즉시 채택.
    startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, random: () => 0.9 });
    expect(handle.setIdleSpin).toHaveBeenCalledWith(true);
    vi.advanceTimersToNextTimer(); // 정확히 1홉만 발화(지연 길이와 무관, sinon 타이머 큐 순서대로).
    expect(handle.moveVehicle).toHaveBeenCalledWith('CN', 'CN', { durationMs: 0 });
    expect(handle.drawRouteSegment).not.toHaveBeenCalled();
    expect(handle.markSolved).not.toHaveBeenCalled();
  });

  it('두 번째 홉부터: drawRouteSegment→markSolved→moveVehicle 순서로 호출', () => {
    const handle = createFakeHandle();
    startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, random: () => 0.9 });
    vi.advanceTimersToNextTimer(); // 1st hop(스냅)
    vi.advanceTimersToNextTimer(); // 2nd hop(노선 등장)
    expect(handle.drawRouteSegment).toHaveBeenCalledTimes(1);
    expect(handle.markSolved).toHaveBeenCalledTimes(1);
    expect(handle.moveVehicle).toHaveBeenCalledTimes(2);
    // 위에서 이미 호출 횟수를 단정했으므로(1·1·2회) 아래 인덱스는 항상 존재한다 — 논-널 단언은
    // noUncheckedIndexedAccess 형식 가드일 뿐.
    const drawOrder = (handle.drawRouteSegment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const solvedOrder = (handle.markSolved as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const moveOrder = (handle.moveVehicle as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!; // 2번째 호출
    expect(drawOrder).toBeLessThan(solvedOrder);
    expect(solvedOrder).toBeLessThan(moveOrder);
    expect(handle.markSolved).toHaveBeenCalledWith('CN', 'var(--continent-asia)');
  });

  it('같은 목적지를 연속으로 고르지 않으려 재시도한다(가능한 경우)', () => {
    const handle = createFakeHandle();
    // 0.9,0.1 교대 → floor(0.9*2)=1('JP'), floor(0.1*2)=0('KR') — KR/JP 두 목적지만 둔다.
    const values = [0.1, 0.9, 0.1, 0.9, 0.1];
    let i = 0;
    const random = () => values[Math.min(i++, values.length - 1)]!; // 인덱스는 항상 범위 내.
    startHomeGlobeDemo({ handle, destinations: ['KR', 'JP'], continentOf, random });
    vi.advanceTimersToNextTimer(); // 1st: JP
    expect(handle.moveVehicle).toHaveBeenLastCalledWith('JP', 'JP', { durationMs: 0 });
    vi.advanceTimersToNextTimer(); // 2nd: JP→KR(재시도로 KR 선택)
    expect(handle.moveVehicle).toHaveBeenLastCalledWith('JP', 'KR');
  });

  it('~16홉마다 reset() 후 카운터가 재시작된다', () => {
    const handle = createFakeHandle();
    startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, random: () => 0.9 });
    for (let hop = 0; hop < HOME_GLOBE_RESET_EVERY_HOPS; hop++) vi.advanceTimersToNextTimer();
    expect(handle.moveVehicle).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS);
    expect(handle.drawRouteSegment).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS - 1);
    expect(handle.markSolved).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS - 1);
    expect(handle.reset).toHaveBeenCalledTimes(1);

    // reset 후 다음 홉(17번째)은 다시 "첫 홉" 모양(스냅만, 노선/markSolved 카운트 불변).
    vi.advanceTimersToNextTimer();
    expect(handle.moveVehicle).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS + 1);
    expect(handle.drawRouteSegment).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS - 1);
    expect(handle.markSolved).toHaveBeenCalledTimes(HOME_GLOBE_RESET_EVERY_HOPS - 1);
    expect(handle.reset).toHaveBeenCalledTimes(1);
  });
});

describe('startHomeGlobeDemo — pause/resume(document.hidden 대응)·stop', () => {
  it('pause()는 예정된 홉 타이머를 취소하고 resume()이 재개한다', () => {
    const handle = createFakeHandle();
    const controller = startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, random: () => 0.9 });
    controller.pause();
    vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 5);
    expect(handle.moveVehicle).not.toHaveBeenCalled();

    controller.resume();
    vi.advanceTimersToNextTimer();
    expect(handle.moveVehicle).toHaveBeenCalledTimes(1);
  });

  it('stop() 이후에는 resume()을 호출해도 다시 움직이지 않는다', () => {
    const handle = createFakeHandle();
    const controller = startHomeGlobeDemo({ handle, destinations: DESTS, continentOf, random: () => 0.9 });
    vi.advanceTimersToNextTimer();
    expect(handle.moveVehicle).toHaveBeenCalledTimes(1);

    controller.stop();
    vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 10);
    expect(handle.moveVehicle).toHaveBeenCalledTimes(1);

    controller.resume(); // stop 이후 방어적 no-op.
    vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 10);
    expect(handle.moveVehicle).toHaveBeenCalledTimes(1);
  });

  it('최소/최대 홉 간격이 8±3초로 산출된다', () => {
    expect(HOME_GLOBE_MIN_HOP_DELAY_MS).toBe(5_000);
    expect(HOME_GLOBE_MAX_HOP_DELAY_MS).toBe(11_000);
  });
});

function mkCountry(id: string, tier: Country['difficultyTier']): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo: id,
    nameEn: id,
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: tier,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '🏳️',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [id],
    acceptedInputsEn: [id.toLowerCase()],
  };
}

describe('selectHomeGlobeDestinations', () => {
  it('difficultyTier 1·2만 남기고 3 이상은 제외한다', () => {
    const countries = [mkCountry('KR', 1), mkCountry('US', 2), mkCountry('BR', 3), mkCountry('EG', 5)];
    expect(selectHomeGlobeDestinations(countries)).toEqual(['KR', 'US']);
  });

  it('빈 배열 입력이면 빈 배열을 반환한다', () => {
    expect(selectHomeGlobeDestinations([])).toEqual([]);
  });
});

// ── 컴포넌트 배선(HomeGlobe.tsx) ────────────────────────────────────────────
// GlobeMap/useGlobeIndex/bootLoader를 목킹해 마운트→onReady→드라이버 시작, unmount→stop,
// document.hidden→pause/resume, prefers-reduced-motion→미기동을 실제 컴포넌트 트리로 검증한다.
const mockHandle = createFakeHandle();

let mockGlobeIndexValue: { continent: Map<CountryId, string> } | null = {
  continent: new Map([
    ['KR', 'asia'],
    ['JP', 'asia'],
    ['CN', 'asia'],
  ]),
};

const mockCountries: Country[] = [mkCountry('KR', 1), mkCountry('JP', 2), mkCountry('CN', 4)];

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: mockCountries },
    config: {
      schemaVersion: 2,
      dataUrl: '/data/countries.json',
      mapUrl: '/data/countries-110m.json',
      grades: { S: 450, A: 340, B: 230, C: 120 },
      timeLimit: { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 },
      anticheat: { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 },
      featureFlags: {},
    },
    dataVersion: 'test',
  }),
}));

vi.mock('../../features/map/globe/useGlobeIndex', () => ({
  useGlobeIndex: () => mockGlobeIndexValue,
}));

vi.mock('../../features/map/globe/GlobeMap', () => ({
  GlobeMap: (props: { onReady?: (h: GlobeMapHandle) => void }) => {
    useEffect(() => {
      props.onReady?.(mockHandle);
    }, []);
    return null;
  },
}));

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('HomeGlobe(컴포넌트) — 배선', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobeIndexValue = {
      continent: new Map([
        ['KR', 'asia'],
        ['JP', 'asia'],
        ['CN', 'asia'],
      ]),
    };
  });

  it('index 로딩 전에는 home-globe-loading placeholder를 렌더한다(throw 없음)', () => {
    mockGlobeIndexValue = null;
    render(<HomeGlobe />);
    expect(screen.getByTestId('home-globe')).toBeInTheDocument();
    expect(screen.getByTestId('home-globe-loading')).toBeInTheDocument();
  });

  it('마운트 시 idle spin을 켜고 홉 데모를 시작한다', () => {
    render(<HomeGlobe />);
    expect(mockHandle.setIdleSpin).toHaveBeenCalledWith(true);
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS);
    });
    expect(mockHandle.moveVehicle).toHaveBeenCalled();
  });

  it('prefers-reduced-motion이면 idle spin도 홉도 시작하지 않는다', () => {
    stubMatchMedia(true);
    render(<HomeGlobe />);
    expect(mockHandle.setIdleSpin).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 5);
    });
    expect(mockHandle.moveVehicle).not.toHaveBeenCalled();
  });

  it('unmount 시 더 이상 홉이 발생하지 않는다', () => {
    const { unmount } = render(<HomeGlobe />);
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS);
    });
    const before = (mockHandle.moveVehicle as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(before).toBeGreaterThan(0);
    unmount();
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 10);
    });
    expect((mockHandle.moveVehicle as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('document.hidden 동안 홉이 멈추고 복귀 시 재개한다', () => {
    render(<HomeGlobe />);
    setDocumentHidden(true);
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS * 5);
    });
    expect(mockHandle.moveVehicle).not.toHaveBeenCalled();

    setDocumentHidden(false);
    // 실제 컴포넌트 배선은 Math.random()(주입 불가)을 쓰므로 다음 홉 지연은 [5000,11000)ms 중
    // 하나 — 정확한 호출 횟수 대신 "재개 후 최소 1회는 다시 움직인다"만 검증한다(카운트 단정은
    // 드물게 두 홉이 연이어 발화할 수 있어 결정론적이지 않다).
    act(() => {
      vi.advanceTimersByTime(HOME_GLOBE_MAX_HOP_DELAY_MS);
    });
    expect(mockHandle.moveVehicle).toHaveBeenCalled();
  });
});
