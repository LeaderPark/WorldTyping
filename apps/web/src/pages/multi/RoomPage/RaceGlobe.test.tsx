// @vitest-environment jsdom
//
// spec: docs/01 §8.2·§10.2(S11), docs/03 §3.7·§4.2(지도 배선)·§4.5(리렌더 0)·§7.3, docs/05 §8-2
// (progress-tick), WT-RACE-GLOBE acceptance.
//
// GlobeMap/useGlobeIndex/globe-race를 목킹해 "배선"만 검증한다(HomeGlobe.test.tsx와 동일 관례):
// 실제 지구본/canvas/d3-geo 없이도 엔진 이벤트→코어 핸들, opponents 스토어→오버레이 핸들의
// 호출 시퀀스가 결정적으로 재현된다. 판정/네트워크/프로토콜은 이 파일의 관심사가 아니다.
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CountryId } from '@wt/shared';
import type { EngineEvent } from '@wt/engine';
import type { GlobeMapHandle } from '../../../features/map/globe/GlobeMap';
import { useMultiplayerStore, type RoomPlayer } from '../../../stores/multiplayer';
import { RaceGlobe, racePlaneColor, racePlanePosIndex, type RaceGlobeEngine } from './RaceGlobe';

const IDS: CountryId[] = ['KR', 'JP', 'CN', 'TH', 'VN'];

function mockHandleFactory() {
  return {
    // GlobeMapHandle(코어 위임분)
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
    // GlobeRaceHandle(오버레이)
    setRoster: vi.fn(),
    snapPlane: vi.fn(),
    movePlane: vi.fn(),
    removePlane: vi.fn(),
    clearRace: vi.fn(),
  };
}

const mocks = vi.hoisted(() => ({
  handle: null as ReturnType<typeof mockHandleFactory> | null,
  index: null as { continent: Map<string, string> } | null,
  createCalls: [] as Array<{ container: HTMLElement }>,
}));

vi.mock('../../../features/map/globe/useGlobeIndex', () => ({
  useGlobeIndex: () => mocks.index,
}));

vi.mock('../../../features/map/globe/GlobeMap', () => ({
  GlobeMap: (props: { onReady?: (h: GlobeMapHandle) => void }) => {
    useEffect(() => {
      props.onReady?.({} as GlobeMapHandle);
    }, []);
    return <div data-testid="globe-map-stub" />;
  },
}));

vi.mock('../../../features/map/globe/globe-race', () => ({
  createGlobeRaceHandle: (deps: { container: HTMLElement }) => {
    mocks.createCalls.push({ container: deps.container });
    return mocks.handle;
  },
}));

function player(id: string): RoomPlayer {
  return {
    playerId: id,
    nickname: id,
    passportCover: 'basic-green',
    bestPi: null,
    isHost: false,
    isBot: false,
    ready: true,
    connState: 'connected',
  };
}

/** 엔진 대역 — subscribe로 받은 리스너에 이벤트를 직접 밀어 넣는다. */
function fakeEngine(currentIndex = 0): RaceGlobeEngine & { emit(e: EngineEvent): void } {
  const listeners = new Set<(e: EngineEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ currentIndex }),
    emit(e) {
      for (const l of listeners) l(e);
    },
  };
}

function shown(index: number): EngineEvent {
  return { type: 'countryShown', index, id: IDS[index] as CountryId, timeLimitMs: null };
}
function committed(index: number, skipped = false): EngineEvent {
  return {
    type: 'countryCommitted',
    index,
    id: IDS[index] as CountryId,
    ms: 1000,
    errors: 0,
    skipped,
    combo: 1,
  };
}

beforeEach(() => {
  mocks.handle = mockHandleFactory();
  mocks.index = { continent: new Map([['JP', 'asia']]) };
  mocks.createCalls = [];
  useMultiplayerStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('순수 헬퍼', () => {
  it('racePlanePosIndex: idx(완주 수) → 기체 위치(직전 완주국, 하한 0·상한 total-1)', () => {
    expect(racePlanePosIndex(0, 5)).toBe(0);
    expect(racePlanePosIndex(1, 5)).toBe(0);
    expect(racePlanePosIndex(3, 5)).toBe(2);
    expect(racePlanePosIndex(99, 5)).toBe(4);
    expect(racePlanePosIndex(2, 0)).toBe(0);
  });

  it('racePlaneColor: 기존 등급색 토큰만 순환 배정한다(신규 토큰 없음)', () => {
    const colors = [0, 1, 2, 3, 4, 5].map(racePlaneColor);
    for (const c of colors) expect(c).toMatch(/^var\(--grade-[sabcd]\)$/);
    expect(colors[5]).toBe(colors[0]); // 5종 순환
  });
});

describe('마운트 스모크', () => {
  it('race-globe 컨테이너를 aria-hidden 장식 계층으로 렌더한다', () => {
    render(<RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion={false} />);
    const el = screen.getByTestId('race-globe');
    expect(el).toBeInTheDocument();
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('globe-map-stub')).toBeInTheDocument();
  });

  it('geoIndex 미도착이면 GlobeMap을 마운트하지 않는다(throw 없음)', () => {
    mocks.index = null;
    render(<RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion={false} />);
    expect(screen.getByTestId('race-globe')).toBeInTheDocument();
    expect(screen.queryByTestId('globe-map-stub')).toBeNull();
    expect(mocks.createCalls).toHaveLength(0);
  });

  it('onReady에서 오버레이 핸들을 GlobeMap 컨테이너(.wt-race-globe)에 붙인다', () => {
    render(<RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion={false} />);
    expect(mocks.createCalls).toHaveLength(1);
    expect(mocks.createCalls[0]!.container.className).toBe('wt-race-globe');
  });

  it('언마운트 시 clearRace로 오버레이 프레임을 해제한다', () => {
    const { unmount } = render(
      <RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion={false} />,
    );
    unmount();
    expect(mocks.handle!.clearRace).toHaveBeenCalled();
  });
});

describe('내 비행기 배선(엔진 이벤트 → 코어 핸들)', () => {
  it('countryShown(0): 타깃 지정 + 출발국 스냅 배치', () => {
    const engine = fakeEngine();
    render(<RaceGlobe countryIds={IDS} engine={engine} opponents={[]} reducedMotion={false} />);
    mocks.handle!.setTarget.mockClear();
    mocks.handle!.moveVehicle.mockClear();

    act(() => engine.emit(shown(0)));
    expect(mocks.handle!.setTarget).toHaveBeenCalledWith('KR');
    expect(mocks.handle!.moveVehicle).toHaveBeenCalledWith('KR', 'KR', { durationMs: 0 });
  });

  it('countryShown(n>0): 타깃만 바꾸고 카메라는 건드리지 않는다(홉은 확정 시)', () => {
    const engine = fakeEngine();
    render(<RaceGlobe countryIds={IDS} engine={engine} opponents={[]} reducedMotion={false} />);
    mocks.handle!.moveVehicle.mockClear();

    act(() => engine.emit(shown(2)));
    expect(mocks.handle!.setTarget).toHaveBeenLastCalledWith('CN');
    expect(mocks.handle!.moveVehicle).not.toHaveBeenCalled();
  });

  it('countryCommitted: markSolved(대륙색) + drawRouteSegment + moveVehicle 각 1회', () => {
    const engine = fakeEngine();
    render(<RaceGlobe countryIds={IDS} engine={engine} opponents={[]} reducedMotion={false} />);
    mocks.handle!.moveVehicle.mockClear();

    act(() => engine.emit(committed(1)));
    expect(mocks.handle!.markSolved).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.markSolved).toHaveBeenCalledWith('JP', 'var(--continent-asia)');
    expect(mocks.handle!.drawRouteSegment).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.drawRouteSegment).toHaveBeenCalledWith('KR', 'JP');
    expect(mocks.handle!.moveVehicle).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.moveVehicle).toHaveBeenCalledWith('KR', 'JP');
  });

  it('countryCommitted(index 0): 이전 국가가 없어 노선/홉 없이 채색만', () => {
    const engine = fakeEngine();
    render(<RaceGlobe countryIds={IDS} engine={engine} opponents={[]} reducedMotion={false} />);
    mocks.handle!.moveVehicle.mockClear();

    act(() => engine.emit(committed(0)));
    expect(mocks.handle!.markSolved).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.drawRouteSegment).not.toHaveBeenCalled();
    expect(mocks.handle!.moveVehicle).not.toHaveBeenCalled();
  });

  it('스킵 확정은 회색 표시만(축하 연출·노선·홉 없음 — 싱글 규약 승계)', () => {
    const engine = fakeEngine();
    render(<RaceGlobe countryIds={IDS} engine={engine} opponents={[]} reducedMotion={false} />);
    mocks.handle!.moveVehicle.mockClear();

    act(() => engine.emit(committed(1, true)));
    expect(mocks.handle!.markSkipped).toHaveBeenCalledWith('JP');
    expect(mocks.handle!.markSolved).not.toHaveBeenCalled();
    expect(mocks.handle!.drawRouteSegment).not.toHaveBeenCalled();
    expect(mocks.handle!.moveVehicle).not.toHaveBeenCalled();
  });
});

describe('상대 비행기 배선(opponents 스토어 → 오버레이 핸들)', () => {
  const opponents = [player('o1'), player('o2')];

  function mount(reduced = false) {
    return render(
      <RaceGlobe
        countryIds={IDS}
        engine={fakeEngine()}
        opponents={opponents}
        reducedMotion={reduced}
      />,
    );
  }

  it('마운트 시 로스터를 등록하고(색 배정 = 트랙 순서) 출발국에 스냅한다', () => {
    mount();
    expect(mocks.handle!.setRoster).toHaveBeenCalledWith([
      { id: 'o1', color: racePlaneColor(0) },
      { id: 'o2', color: racePlaneColor(1) },
    ]);
    expect(mocks.handle!.snapPlane).toHaveBeenCalledWith('o1', 'KR');
    expect(mocks.handle!.snapPlane).toHaveBeenCalledWith('o2', 'KR');
  });

  it('idx 1칸 전진(위치 인덱스 +1)은 마지막 구간 홉 1회로 반영된다', () => {
    mount();
    mocks.handle!.snapPlane.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 2 }));
    expect(mocks.handle!.movePlane).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.movePlane).toHaveBeenCalledWith('o1', 'KR', 'JP');
    expect(mocks.handle!.snapPlane).not.toHaveBeenCalled();
  });

  it('첫 확정(idx 0→1)은 위치가 그대로라 홉이 생기지 않는다(내 비행기 규약과 동일)', () => {
    mount();
    mocks.handle!.snapPlane.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 1 }));
    expect(mocks.handle!.movePlane).not.toHaveBeenCalled();
    expect(mocks.handle!.snapPlane).not.toHaveBeenCalled();
  });

  it('2칸 이상 점프(tick 유실/재접속)는 직전 국가로 스냅 후 마지막 구간만 홉한다', () => {
    mount();
    mocks.handle!.snapPlane.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 4 })); // 위치 0 → 3
    expect(mocks.handle!.snapPlane).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.snapPlane).toHaveBeenCalledWith('o1', 'CN');
    expect(mocks.handle!.movePlane).toHaveBeenCalledTimes(1);
    expect(mocks.handle!.movePlane).toHaveBeenCalledWith('o1', 'CN', 'TH');
  });

  it('되감기(race-sync 재동기)는 홉 없이 스냅한다', () => {
    mount();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 4 }));
    mocks.handle!.snapPlane.mockClear();
    mocks.handle!.movePlane.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 2 }));
    expect(mocks.handle!.snapPlane).toHaveBeenCalledWith('o1', 'JP');
    expect(mocks.handle!.movePlane).not.toHaveBeenCalled();
  });

  it('세트 범위를 넘는 idx는 마지막 국가로 클램프된다', () => {
    mount();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 99 }));
    expect(mocks.handle!.movePlane).toHaveBeenCalledWith('o1', 'TH', 'VN');
  });

  it('다른 플레이어의 tick은 내 기체를 움직이지 않는다', () => {
    mount();
    mocks.handle!.movePlane.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o2', { idx: 3 }));
    const ids = mocks.handle!.movePlane.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(['o2']);
  });
});

describe('reduced-motion / 관전 모드', () => {
  it('reducedMotion이면 juice 강등(1)으로 시작한다', () => {
    render(<RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion />);
    expect(mocks.handle!.setJuiceLevel).toHaveBeenCalledWith(1);
  });

  it('reducedMotion 해제 시 juice 0으로 복귀한다', () => {
    const { rerender } = render(
      <RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion />,
    );
    mocks.handle!.setJuiceLevel.mockClear();
    rerender(<RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[]} reducedMotion={false} />);
    expect(mocks.handle!.setJuiceLevel).toHaveBeenCalledWith(0);
  });

  it('관전(엔진 없음)은 코어 기체를 숨기고 카메라만 세트 출발국에 둔다', () => {
    render(<RaceGlobe countryIds={IDS} opponents={[player('o1')]} reducedMotion={false} />);
    expect(mocks.handle!.setVehicleVisible).toHaveBeenCalledWith(false);
    expect(mocks.handle!.flyTo).toHaveBeenCalledWith(['KR'], { durationMs: 0 });
  });

  it('관전 카메라는 선두 기체를 따라간다', () => {
    render(<RaceGlobe countryIds={IDS} opponents={[player('o1')]} reducedMotion={false} />);
    mocks.handle!.flyTo.mockClear();
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 3 }));
    expect(mocks.handle!.flyTo).toHaveBeenCalledWith(['CN'], { durationMs: 600 });
  });

  it('엔진이 있으면(내가 뛰는 판) 카메라 추종은 내 비행기 몫이라 flyTo하지 않는다', () => {
    render(
      <RaceGlobe countryIds={IDS} engine={fakeEngine()} opponents={[player('o1')]} reducedMotion={false} />,
    );
    act(() => useMultiplayerStore.getState().upsertOpponent('o1', { idx: 3 }));
    expect(mocks.handle!.flyTo).not.toHaveBeenCalled();
  });
});
