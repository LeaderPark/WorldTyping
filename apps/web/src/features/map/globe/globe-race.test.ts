// @vitest-environment jsdom
//
// spec: docs/03 §3.2(핸들 계약)·§3.6(juice 강등)·§3.7·§7.3(reduced-motion), docs/00 §11-D67
// (canvas 재그리기 0 — 정지 시 rAF 0), WT-RACE-GLOBE acceptance.
//
// globe-chase.test.ts와 동일한 근거로 mock core(vi.fn 스파이)를 쓴다: "코어 무접촉"은 handle
// 메서드 호출 여부로 직접 단정하는 편이 jsdom canvas/rAF 타이밍에 기대는 것보다 결정적이다.
// 애니메이션 경로는 rAF·performance.now를 수동 큐/가상 시계로 대체해 프레임을 직접 구동한다.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Country, CountryId } from '@wt/shared';
import type { TopologyLike } from '../geo-index';
import type { GlobeMapHandle } from './GlobeMap';
import { buildGlobeIndex, type GlobeIndex } from './globe-index';
import { isFrontFacing } from './globe-hop';
import { createGlobeRaceHandle, type GlobeRaceHandle } from './globe-race';

function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let index: GlobeIndex;

beforeAll(() => {
  const topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  index = buildGlobeIndex(topo, dataset.countries);
});

/** GlobeMap.tsx 기본 카메라([20,20])에서 정면/뒷면인 국가를 각각 결정적으로 고른다(ISO 하드코딩 없음). */
function pickFrontAndBack(): { front: CountryId; front2: CountryId; back: CountryId } {
  const center: [number, number] = [20, 20];
  const fronts: CountryId[] = [];
  let back: CountryId | null = null;
  for (const [id, a] of index.anchor) {
    if (isFrontFacing(a, center)) {
      if (fronts.length < 2) fronts.push(id);
    } else if (!back) {
      back = id;
    }
    if (fronts.length >= 2 && back) break;
  }
  const [front, front2] = fronts;
  if (!front || !front2 || !back) throw new Error('fixture lacks front/back cases');
  return { front, front2, back };
}

function mockCore() {
  return {
    setTarget: vi.fn(),
    markSolved: vi.fn(),
    markSkipped: vi.fn(),
    drawRouteSegment: vi.fn(),
    flyTo: vi.fn(),
    reset: vi.fn(),
    setJuiceLevel: vi.fn(),
    moveVehicle: vi.fn(),
    setVehicleVisible: vi.fn(),
    setWaypointLabels: vi.fn(),
    pulseCheckpointRing: vi.fn(),
    setIdleSpin: vi.fn(),
  };
}

interface Harness {
  handle: GlobeRaceHandle;
  core: ReturnType<typeof mockCore>;
  container: HTMLElement;
}

function setup(): Harness {
  const core = mockCore();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handle = createGlobeRaceHandle({ core: core as unknown as GlobeMapHandle, container, index });
  return { handle, core, container };
}

function planeEl(container: HTMLElement, id: string): SVGGElement | null {
  return container.querySelector<SVGGElement>(`[data-race-plane="${id}"]`);
}

// ── 가상 rAF/시계 ────────────────────────────────────────────────────────────
let clock = 0;
let frames: FrameRequestCallback[] = [];

function installVirtualRaf(): void {
  clock = 0;
  frames = [];
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
}
/** ms만큼 시계를 진행시키고 예약된 프레임을 1회 실행한다. */
function advance(ms: number): void {
  clock += ms;
  const due = frames;
  frames = [];
  for (const cb of due) cb(clock);
}

/** matchMedia(prefers-reduced-motion) 스텁 — jsdom 기본은 matches:false다. */
function stubReducedMotion(matches: boolean): void {
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
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: globalThis.matchMedia,
  });
}

beforeEach(() => {
  installVirtualRaf();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('오버레이 구성 — 코어 마크업 무수정', () => {
  it('컨테이너에 .wt-race__overlay 형제 svg를 1개만 추가한다(재호출 안전)', () => {
    const { container, core } = setup();
    expect(container.querySelectorAll('.wt-race__overlay')).toHaveLength(1);
    createGlobeRaceHandle({ core: core as unknown as GlobeMapHandle, container, index });
    expect(container.querySelectorAll('.wt-race__overlay')).toHaveLength(1);
  });

  it('오버레이는 코어와 동일 viewBox·aria-hidden이다', () => {
    const { container } = setup();
    const svg = container.querySelector('.wt-race__overlay');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 960 500');
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('setRoster — 기체 upsert/제거', () => {
  it('로스터에 있는 id마다 [data-race-plane] 노드를 만든다(초기엔 숨김)', () => {
    const { handle, container } = setup();
    handle.setRoster([
      { id: 'p1', color: 'var(--grade-b)' },
      { id: 'p2', color: 'var(--grade-a)' },
    ]);
    expect(container.querySelectorAll('[data-race-plane]')).toHaveLength(2);
    expect(planeEl(container, 'p1')!.style.display).toBe('none');
    expect(planeEl(container, 'p1')!.style.getPropertyValue('--wt-race-plane-color')).toBe(
      'var(--grade-b)',
    );
  });

  it('재호출 시 남은 기체는 노드를 재사용하고 빠진 기체만 제거한다', () => {
    const { handle, container } = setup();
    handle.setRoster([
      { id: 'p1', color: 'var(--grade-b)' },
      { id: 'p2', color: 'var(--grade-a)' },
    ]);
    const first = planeEl(container, 'p1');
    handle.setRoster([{ id: 'p1', color: 'var(--grade-c)' }]);
    expect(planeEl(container, 'p1')).toBe(first);
    expect(planeEl(container, 'p2')).toBeNull();
    expect(first!.style.getPropertyValue('--wt-race-plane-color')).toBe('var(--grade-c)');
  });

  it('removePlane은 해당 노드만 제거한다', () => {
    const { handle, container } = setup();
    handle.setRoster([
      { id: 'p1', color: 'c1' },
      { id: 'p2', color: 'c2' },
    ]);
    handle.removePlane('p1');
    expect(planeEl(container, 'p1')).toBeNull();
    expect(planeEl(container, 'p2')).not.toBeNull();
  });

  it('로스터에 없는 id에 대한 snap/move는 무시된다(throw 없음)', () => {
    const { handle } = setup();
    const { front, front2 } = pickFrontAndBack();
    expect(() => handle.snapPlane('ghost', front)).not.toThrow();
    expect(() => handle.movePlane('ghost', front, front2)).not.toThrow();
  });
});

describe('snapPlane — 즉시 배치·뒷면 은닉', () => {
  it('정면 국가로 스냅하면 표시되고 transform이 설정된다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    const el = planeEl(container, 'p1')!;
    expect(el.style.display).toBe('');
    expect(el.getAttribute('transform')).toMatch(/^translate\(/);
  });

  it('뒷면(카메라 반대편) 국가로 스냅하면 숨긴다', () => {
    const { handle, container } = setup();
    const { back } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', back);
    expect(planeEl(container, 'p1')!.style.display).toBe('none');
  });

  it('스냅은 프레임을 예약하지 않는다(정지 시 rAF 0 — D67)', () => {
    const { handle } = setup();
    const { front } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    expect(frames).toHaveLength(0);
  });
});

describe('movePlane — 홉 애니메이션', () => {
  it('프레임이 진행되며 위치가 바뀌고 완료 후 스스로 종료한다', () => {
    const { handle, container } = setup();
    const { front, front2 } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    const el = planeEl(container, 'p1')!;
    const at0 = el.getAttribute('transform');

    handle.movePlane('p1', front, front2, { durationMs: 600 });
    expect(frames.length).toBeGreaterThan(0); // 홉 구간에만 루프가 돈다

    advance(300);
    const mid = el.getAttribute('transform');
    expect(mid).not.toBe(at0);
    expect(frames.length).toBeGreaterThan(0); // 아직 진행 중

    advance(400); // 총 700ms > 600ms → 종료
    const end = el.getAttribute('transform');
    expect(end).not.toBe(mid);
    expect(frames).toHaveLength(0); // 상시 루프가 남지 않는다

    // 종점은 같은 국가로 스냅했을 때와 동일한 좌표여야 한다(수학 정합).
    handle.snapPlane('p1', front2);
    expect(el.getAttribute('transform')).toBe(end);
  });

  it('from===to는 스냅으로 처리하고 프레임을 예약하지 않는다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.movePlane('p1', front, front);
    expect(frames).toHaveLength(0);
    handle.snapPlane('p1', front);
    expect(planeEl(container, 'p1')!.style.display).toBe('');
  });

  it('홉 중 재호출(선점)은 큐잉 없이 현 위치에서 새 목적지로 리타깃한다', () => {
    const { handle, container } = setup();
    const { front, front2, back } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    handle.movePlane('p1', front, back, { durationMs: 600 });
    advance(200);
    handle.movePlane('p1', back, front2, { durationMs: 600 });
    advance(700);
    const el = planeEl(container, 'p1')!;
    const preempted = el.getAttribute('transform');
    handle.snapPlane('p1', front2);
    expect(el.getAttribute('transform')).toBe(preempted);
  });
});

describe('reduced-motion / juice 강등 — 스냅', () => {
  it('prefers-reduced-motion이면 홉 없이 즉시 종점으로 스냅한다', () => {
    stubReducedMotion(true);
    const { handle, container } = setup();
    const { front, front2 } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    handle.movePlane('p1', front, front2);
    expect(frames).toHaveLength(0);
    const el = planeEl(container, 'p1')!;
    const moved = el.getAttribute('transform');
    handle.snapPlane('p1', front2);
    expect(el.getAttribute('transform')).toBe(moved);
  });

  it('setJuiceLevel(1)이면 홉 없이 스냅한다(오버레이 data-juice도 반영)', () => {
    const { handle, container, core } = setup();
    const { front, front2 } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    handle.setJuiceLevel(1);
    expect(core.setJuiceLevel).toHaveBeenCalledWith(1);
    expect(container.querySelector('.wt-race__overlay')!.getAttribute('data-juice')).toBe('1');

    handle.movePlane('p1', front, front2);
    expect(frames).toHaveLength(0);
    const el = planeEl(container, 'p1')!;
    const moved = el.getAttribute('transform');
    handle.snapPlane('p1', front2);
    expect(el.getAttribute('transform')).toBe(moved);
  });

  it('reduced-motion에서는 내 비행기 카메라 미러도 즉시 스냅한다', () => {
    stubReducedMotion(true);
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', back); // 카메라 이전엔 뒷면 → 숨김
    expect(planeEl(container, 'p1')!.style.display).toBe('none');
    handle.moveVehicle(front, back); // 카메라가 back으로 → 정면화
    expect(frames).toHaveLength(0);
    expect(planeEl(container, 'p1')!.style.display).toBe('');
  });
});

describe('카메라 미러 — 내 비행기 홉을 따라 상대 기체를 재투영', () => {
  it('moveVehicle은 코어에 위임하면서 오버레이 좌표를 함께 갱신한다', () => {
    const { handle, container, core } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', back);
    const before = planeEl(container, 'p1')!.style.display;

    handle.moveVehicle(front, back, { durationMs: 600 });
    expect(core.moveVehicle).toHaveBeenCalledWith(front, back, { durationMs: 600 });
    advance(700);
    expect(before).toBe('none');
    expect(planeEl(container, 'p1')!.style.display).toBe(''); // 카메라가 back을 향해 정면화
    expect(frames).toHaveLength(0);
  });

  it('flyTo도 코어 위임 + 미러 이동이며 durationMs:0은 즉시 스냅이다', () => {
    const { handle, container, core } = setup();
    const { back } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', back);
    handle.flyTo([back], { durationMs: 0 });
    expect(core.flyTo).toHaveBeenCalled();
    expect(frames).toHaveLength(0);
    expect(planeEl(container, 'p1')!.style.display).toBe('');
  });
});

describe('clearRace / reset', () => {
  it('clearRace는 기체를 전부 제거하고 진행 중인 프레임을 해제한다', () => {
    const { handle, container } = setup();
    const { front, front2 } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    handle.movePlane('p1', front, front2, { durationMs: 600 });
    expect(frames.length).toBeGreaterThan(0);
    handle.clearRace();
    expect(container.querySelectorAll('[data-race-plane]')).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it('reset은 코어 reset을 호출하고 레이스 기체도 비운다', () => {
    const { handle, container, core } = setup();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.reset();
    expect(core.reset).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-race-plane]')).toHaveLength(0);
  });
});

describe('base 무접촉 — 레이스 전용 메서드는 코어를 호출하지 않는다', () => {
  it('setRoster/snapPlane/movePlane/removePlane/clearRace가 코어 메서드를 한 번도 부르지 않는다', () => {
    const { handle, core } = setup();
    const { front, front2 } = pickFrontAndBack();
    handle.setRoster([{ id: 'p1', color: 'c1' }]);
    handle.snapPlane('p1', front);
    handle.movePlane('p1', front, front2);
    advance(1000);
    handle.removePlane('p1');
    handle.clearRace();
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
  });

  it('카메라 비접점 메서드는 코어에 그대로 위임한다', () => {
    const { handle, core } = setup();
    const { front } = pickFrontAndBack();
    handle.setTarget(front);
    handle.markSolved(front, 'var(--continent-asia)');
    handle.markSkipped(front);
    handle.drawRouteSegment(front, front);
    handle.setVehicleVisible(false);
    handle.setWaypointLabels({ prev: null, cur: null, next: null });
    handle.pulseCheckpointRing(front);
    handle.setIdleSpin(true);
    expect(core.setTarget).toHaveBeenCalledWith(front);
    expect(core.markSolved).toHaveBeenCalledWith(front, 'var(--continent-asia)');
    expect(core.markSkipped).toHaveBeenCalledWith(front);
    expect(core.drawRouteSegment).toHaveBeenCalledWith(front, front);
    expect(core.setVehicleVisible).toHaveBeenCalledWith(false);
    expect(core.setWaypointLabels).toHaveBeenCalled();
    expect(core.pulseCheckpointRing).toHaveBeenCalledWith(front);
    expect(core.setIdleSpin).toHaveBeenCalledWith(true);
  });
});
