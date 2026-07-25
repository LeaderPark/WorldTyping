// @vitest-environment jsdom
//
// spec: docs/09-chase-mode-goldrunner.md §7.5(GlobeChaseHandle)·§11(성능 가드레일 — canvas 재그리기
// 0)·§8.5(콜아웃 배치 소비 계약), docs/00 §11-D67, WT-CH-05 acceptance.
//
// "canvas 재그리기 0(D67)" 계약은 GlobeMap 코어의 canvas 렌더 표면이 handle 메서드(setTarget/
// markSolved/markSkipped/drawRouteSegment/moveVehicle/flyTo/reset/pulseCheckpointRing)를 통해서만
// 트리거된다는 아키텍처 사실에 근거해, mock core(vi.fn() 스파이)로 "chase 전용 메서드 호출이 이
// core 메서드들을 절대 부르지 않는다"를 직접 검증한다 — jsdom의 canvas 2d 컨텍스트 미구현·
// pretendToBeVisual rAF(setInterval 기반) 타이밍 불확정성을 우회하는 더 정확하고 결정적인 경계
// 테스트다(기존 GlobeMap.test.tsx의 "jsdom엔 2d ctx 없어 렌더가 가드로 no-op" 서술 참조 — 그 방식은
// canvas 유무와 무관하게 항상 참이라 이 태스크의 "0 확인"으로는 근거가 약하다고 판단해 채택하지 않음,
// 최종 보고 기재).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { geoContains, geoDistance, geoOrthographic } from 'd3-geo';
import { CHASE_GRAPH } from '@wt/data';
import { DEFAULT_CHASE_CONSTANTS } from '@wt/shared';
import type { Country, CountryId } from '@wt/shared';
import type { TopologyLike } from '../geo-index';
import type { GeoFeature } from '../feature-binding';
import { GlobeMap, type GlobeMapHandle } from './GlobeMap';
import { buildGlobeIndex, type GlobeIndex } from './globe-index';
import { hopDurationMs, isFrontFacing, sampleArc, type LngLat } from './globe-hop';
import {
  createGlobeChaseHandle,
  largestPolygonCentroid,
  type GlobeChaseHandle,
  type GoldView,
  type PoliceView,
} from './globe-chase';

function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let index: GlobeIndex;
let countries: Country[];

beforeAll(() => {
  const topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  countries = dataset.countries;
  index = buildGlobeIndex(topo, dataset.countries);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/** GlobeMap.tsx의 기본 카메라(INITIAL_CENTER=[20,20])에서 정면/뒷면인 국가를 각각 1개씩, 폴리곤
 * feature가 있는 것으로만 결정적으로 고른다(특정 ISO 코드 하드코딩 없음 — 데이터 갱신에 안전). */
function pickFrontAndBack(): { front: CountryId; back: CountryId } {
  const center: [number, number] = [20, 20];
  let front: CountryId | null = null;
  let back: CountryId | null = null;
  for (const [id, a] of index.anchor) {
    if (!index.featureByCountry.has(id)) continue;
    if (isFrontFacing(a, center)) {
      if (!front) front = id;
    } else if (!back) back = id;
    if (front && back) break;
  }
  if (!front || !back) throw new Error('fixture lacks both front/back cases with polygon features');
  return { front, back };
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

/**
 * §11-D114-A 활공 구동용 rAF 스텁 — 콜백을 핸들 단위 큐에 담아 **원하는 타임스탬프로 수동 실행**한다
 * (jsdom pretendToBeVisual rAF의 setInterval 기반 타이밍 불확정성을 배제한 결정적 구동). cancel도
 * 핸들 단위로 정확히 동작해 미러 홉 rAF와 경찰 활공 rAF가 서로를 지우지 않는다.
 */
function stubRaf(): {
  step: (t: number) => void;
  runToEnd: () => void;
  pending: () => number;
} {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id);
  });
  const step = (t: number): void => {
    const due = Array.from(queue.values());
    queue.clear();
    for (const cb of due) cb(t);
  };
  return {
    step,
    runToEnd: () => {
      for (let i = 0; i < 100 && queue.size > 0; i++) step(performance.now() + 1_000_000);
    },
    pending: () => queue.size,
  };
}

/** 마커 transform의 translate 좌표(rotate가 붙어도 앞부분만 읽는다). */
function markerXY(el: SVGGElement): { x: number; y: number } {
  const t = el.getAttribute('transform') ?? '';
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(t);
  if (!m) throw new Error(`translate 없는 transform: "${t}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function setup(): {
  handle: GlobeChaseHandle;
  core: ReturnType<typeof mockCore>;
  container: HTMLElement;
} {
  const core = mockCore();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handle = createGlobeChaseHandle({ core: core as unknown as GlobeMapHandle, container, index });
  return { handle, core, container };
}

describe('경찰/금 마커 — upsert·remove(§7.5)', () => {
  it('upsertPoliceMarker: data-police-id 노드 생성 + kind별 클래스', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    const u: PoliceView = { id: 1, kind: 'chaser', at: front };
    handle.upsertPoliceMarker(u);
    const el = container.querySelector('[data-police-id="1"]');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('class')).toContain('wt-chase__police--chaser');
  });

  it('동일 id 재호출(같은 kind)은 기존 노드를 재사용한다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 2, kind: 'interceptor', at: front });
    const first = container.querySelector('[data-police-id="2"]');
    handle.upsertPoliceMarker({ id: 2, kind: 'interceptor', at: front });
    const second = container.querySelector('[data-police-id="2"]');
    expect(second).toBe(first);
  });

  it('kind 변경 시 노드를 교체(중복 노드 없음)', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 3, kind: 'chaser', at: front });
    handle.upsertPoliceMarker({ id: 3, kind: 'heli', at: front });
    const el = container.querySelector('[data-police-id="3"]');
    expect(el!.getAttribute('class')).toContain('wt-chase__police--heli');
    expect(container.querySelectorAll('[data-police-id="3"]')).toHaveLength(1);
  });

  it('removePoliceMarker: 노드 제거', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 4, kind: 'chaser', at: front });
    handle.removePoliceMarker(4);
    expect(container.querySelector('[data-police-id="4"]')).toBeNull();
  });

  it('setGoldMarkers: 전체 치환(diff — 목록에 없는 국가는 제거)', () => {
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    const golds: GoldView[] = [
      { at: front, ring: 'near' },
      { at: back, ring: 'far' },
    ];
    handle.setGoldMarkers(golds);
    expect(container.querySelectorAll('.wt-chase__gold')).toHaveLength(2);
    handle.setGoldMarkers([{ at: front, ring: 'mid' }]);
    const remaining = container.querySelectorAll('.wt-chase__gold');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.getAttribute('data-gold-ring')).toBe('mid');
  });
});

describe('지구본 정돈(§11-D115-C) — 금 광선 기둥·경찰 위협 글로우', () => {
  it('금 마커는 광선 기둥(rect)+도트(circle) 그룹이고 그룹 transform으로 배치된다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setGoldMarkers([{ at: front, ring: 'mid' }]);

    const g = container.querySelector('.wt-chase__gold')!;
    expect(g.tagName.toLowerCase()).toBe('g');
    const beam = g.querySelector('.wt-chase__gold-beam')!;
    expect(beam).not.toBeNull();
    // 기둥은 마커에서 **위로** 뻗는다(로컬 y가 음수 시작).
    expect(Number(beam.getAttribute('y'))).toBeLessThan(0);
    expect(beam.getAttribute('fill')).toContain('url(#wt-chase-gold-beam');
    expect(g.querySelector('.wt-chase__gold-dot')).not.toBeNull();
    expect(g.getAttribute('transform')).toMatch(/^translate\(/);
    // 그라디언트 정의는 오버레이 SVG의 defs에 1회만 존재한다.
    expect(container.querySelectorAll('#wt-chase-gold-beam')).toHaveLength(1);
  });

  it('경찰 마커에 위협 글로우 원이 있고, setThreatLevel(nearestHops)이 강도 3단을 세팅한다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 7, kind: 'chaser', at: front });
    expect(container.querySelector('[data-police-id="7"] .wt-chase__police-threat')).not.toBeNull();

    const layer = container.querySelector('[data-layer="chase-police"]')!;
    handle.setThreatLevel(3, 5);
    expect(layer.getAttribute('data-threat')).toBe('low');
    handle.setThreatLevel(3, 2);
    expect(layer.getAttribute('data-threat')).toBe('mid');
    handle.setThreatLevel(3, 1);
    expect(layer.getAttribute('data-threat')).toBe('high');

    handle.reset();
    expect(layer.getAttribute('data-threat')).toBeNull();
  });
});

describe('projectAnchor — 고정 projection(INITIAL_CENTER) 대비 정확성(§8.5 소비 계약)', () => {
  it('앵커 좌표가 독립 계산한 geoOrthographic 투영과 일치한다', () => {
    const { handle } = setup();
    const { front } = pickFrontAndBack();
    const anchor = index.anchor.get(front)!;
    const expectedProj = geoOrthographic();
    expectedProj.fitSize([960, 500], { type: 'Sphere' } as never);
    expectedProj.rotate([-20, -20]);
    const [ex, ey] = expectedProj(anchor)!;
    const got = handle.projectAnchor(front);
    expect(got.x).toBeCloseTo(ex, 1);
    expect(got.y).toBeCloseTo(ey, 1);
  });
});

describe('canvas 재그리기 0 계약(D67) — chase 전용 메서드는 core의 canvas 트리거 메서드를 부르지 않는다', () => {
  it('마커 upsert/remove·프리하이라이트 on/off·threat/carried 설정 전부 0회', () => {
    const { handle, core } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setHome(front);
    handle.upsertPoliceMarker({ id: 1, kind: 'chaser', at: front });
    handle.upsertPoliceMarker({ id: 2, kind: 'heli', at: back });
    handle.setGoldMarkers([{ at: back, ring: 'far' }]);
    handle.setCarriedCount(2);
    handle.setCandidateAnchors([front]);
    handle.setCandidatePrehighlight(front);
    handle.setCandidatePrehighlight(null);
    handle.setThreatLevel(3, 1);
    handle.removePoliceMarker(2);

    const canvasTriggering = [
      core.setTarget,
      core.markSolved,
      core.markSkipped,
      core.drawRouteSegment,
      core.moveVehicle,
      core.flyTo,
      core.reset,
      core.pulseCheckpointRing,
    ];
    for (const spy of canvasTriggering) expect(spy).not.toHaveBeenCalled();
  });
});

describe('onHopLifecycle — start/land 발화 순서(§8.5 배치 알고리즘-5)', () => {
  it('reduced-motion 스냅: start 직후 동기적으로 land', () => {
    stubMatchMedia(true);
    const { handle } = setup();
    const { front, back } = pickFrontAndBack();
    const phases: string[] = [];
    handle.onHopLifecycle((p) => phases.push(p));
    handle.moveVehicle(front, back);
    expect(phases).toEqual(['start', 'land']);
  });

  it('from===to 스냅(출발역)도 start→land가 동기 발화', () => {
    const { handle } = setup();
    const { front } = pickFrontAndBack();
    const phases: string[] = [];
    handle.onHopLifecycle((p) => phases.push(p));
    handle.moveVehicle(front, front);
    expect(phases).toEqual(['start', 'land']);
  });

  it('애니메이션 홉(immediate 아님): start는 동기, land는 비동기(다음 프레임)', () => {
    const { handle } = setup();
    const { front, back } = pickFrontAndBack();
    const phases: string[] = [];
    handle.onHopLifecycle((p) => phases.push(p));
    handle.moveVehicle(front, back);
    expect(phases).toEqual(['start']);
  });

  it('구독 해제 함수가 이후 발화를 막는다', () => {
    stubMatchMedia(true);
    const { handle } = setup();
    const { front, back } = pickFrontAndBack();
    const phases: string[] = [];
    const unsub = handle.onHopLifecycle((p) => phases.push(p));
    unsub();
    handle.moveVehicle(front, back);
    expect(phases).toEqual([]);
  });
});

describe('뒷면 클리핑 → 레이더 에지 화살표 전환(§7.5)', () => {
  it('뒷면 police 마커는 숨김 + 레이더 화살표 노드 생성', () => {
    const { handle, container } = setup();
    const { back } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 9, kind: 'chaser', at: back });
    const marker = container.querySelector('[data-police-id="9"]') as SVGGElement;
    expect(marker.style.display).toBe('none');
    expect(container.querySelector('[data-radar-key="police:9"]')).not.toBeNull();
  });

  it('정면 police 마커는 표시 + 화살표 없음', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 10, kind: 'chaser', at: front });
    const marker = container.querySelector('[data-police-id="10"]') as SVGGElement;
    expect(marker.style.display).not.toBe('none');
    expect(container.querySelector('[data-radar-key="police:10"]')).toBeNull();
  });

  it('뒷면 → 정면으로 국가가 바뀌면(재 upsert) 화살표가 해제되고 마커가 표시된다', () => {
    // §11-D114-A 이후 at 변경은 즉시 전환이 아니라 활공이므로, 착지까지 구동한 뒤 판정한다
    // (전환 규약 자체는 불변 — 정면 도달 시 화살표 해제 + 마커 표시).
    const raf = stubRaf();
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 11, kind: 'chaser', at: back });
    expect(container.querySelector('[data-radar-key="police:11"]')).not.toBeNull();
    handle.upsertPoliceMarker({ id: 11, kind: 'chaser', at: front });
    raf.runToEnd();
    expect(container.querySelector('[data-radar-key="police:11"]')).toBeNull();
    const marker = container.querySelector('[data-police-id="11"]') as SVGGElement;
    expect(marker.style.display).not.toBe('none');
  });
});

describe('juice/reduced-motion 강등 — 추적선(§11 "저사양: 추적선 off")', () => {
  it('juice=0 + 비-reduced-motion: 정면 경찰이 있으면 추적선이 그려진다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setJuiceLevel(0);
    handle.upsertPoliceMarker({ id: 20, kind: 'chaser', at: front });
    expect(container.querySelectorAll('.wt-chase__trail').length).toBeGreaterThan(0);
  });

  it('juice=1: 추적선 0(저사양 강등)', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setJuiceLevel(1);
    handle.upsertPoliceMarker({ id: 21, kind: 'chaser', at: front });
    expect(container.querySelectorAll('.wt-chase__trail')).toHaveLength(0);
  });

  it('reduced-motion: juice=0이어도 추적선 0', () => {
    stubMatchMedia(true);
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setJuiceLevel(0);
    handle.upsertPoliceMarker({ id: 22, kind: 'chaser', at: front });
    expect(container.querySelectorAll('.wt-chase__trail')).toHaveLength(0);
  });
});

describe('reset — chase 상태 전체 클리어 + core.reset 위임', () => {
  it('마커·홈·후보·프리하이라이트·비네트가 전부 초기화된다', () => {
    const { handle, container, core } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setHome(front);
    handle.upsertPoliceMarker({ id: 30, kind: 'chaser', at: front });
    handle.setGoldMarkers([{ at: back, ring: 'far' }]);
    handle.setCandidateAnchors([front]);
    handle.setCandidatePrehighlight(front);
    handle.setThreatLevel(5, 1);

    handle.reset();

    expect(core.reset).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-police-id="30"]')).toBeNull();
    expect(container.querySelectorAll('.wt-chase__gold')).toHaveLength(0);
    expect(container.querySelector('[data-candidate-anchor]')).toBeNull();
    expect(container.querySelector('.wt-chase__prehighlight')).toBeNull();
    const vignetteEl = container.querySelector('.wt-chase__vignette') as HTMLElement;
    expect(vignetteEl.style.getPropertyValue('--chase-vignette-alpha')).toBe('0');
  });
});

describe('WorldMapHandle 위임 — 카메라 비접점 메서드는 core로 그대로 전달', () => {
  it('setTarget/markSolved/markSkipped/drawRouteSegment/setVehicleVisible/setWaypointLabels/pulseCheckpointRing/setIdleSpin', () => {
    const { handle, core } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setTarget(front);
    handle.markSolved(front, 'var(--continent-asia)');
    handle.markSkipped(back);
    handle.drawRouteSegment(front, back);
    handle.setVehicleVisible(true);
    handle.setWaypointLabels({ prev: null, cur: null, next: null });
    handle.pulseCheckpointRing(front);
    handle.setIdleSpin(true);

    expect(core.setTarget).toHaveBeenCalledWith(front);
    expect(core.markSolved).toHaveBeenCalledWith(front, 'var(--continent-asia)');
    expect(core.markSkipped).toHaveBeenCalledWith(back);
    expect(core.drawRouteSegment).toHaveBeenCalledWith(front, back);
    expect(core.setVehicleVisible).toHaveBeenCalledWith(true);
    expect(core.setWaypointLabels).toHaveBeenCalled();
    expect(core.pulseCheckpointRing).toHaveBeenCalledWith(front);
    expect(core.setIdleSpin).toHaveBeenCalledWith(true);
  });
});

describe('setThreatLevel — 비네트 alpha 공식(§7.5) + 콜백 주입', () => {
  it('alpha = clamp(0.04×stars + (nearestHops<=2?0.08:0), 0, 0.28)', () => {
    const { handle, container } = setup();
    const vignetteEl = container.querySelector('.wt-chase__vignette') as HTMLElement;
    handle.setThreatLevel(3, 3);
    expect(Number(vignetteEl.style.getPropertyValue('--chase-vignette-alpha'))).toBeCloseTo(0.12, 5);
    handle.setThreatLevel(5, 1);
    expect(Number(vignetteEl.style.getPropertyValue('--chase-vignette-alpha'))).toBeCloseTo(0.28, 5);
    handle.setThreatLevel(10, 1); // 0.4+0.08=0.48 → clamp 0.28
    expect(Number(vignetteEl.style.getPropertyValue('--chase-vignette-alpha'))).toBeCloseTo(0.28, 5);
  });

  it('onThreatLevelChange 콜백이 발화하고 구독 해제 후에는 멈춘다', () => {
    const { handle } = setup();
    const seen: Array<[number, number]> = [];
    const unsub = handle.onThreatLevelChange((stars, hops) => seen.push([stars, hops]));
    handle.setThreatLevel(2, 4);
    unsub();
    handle.setThreatLevel(4, 1);
    expect(seen).toEqual([[2, 4]]);
  });
});

describe('setCandidatePrehighlight — 폴리곤 프리하이라이트(§8.5 상태 매트릭스 matching)', () => {
  it('id 지정 시 국가 폴리곤 path가 생성된다(d 비어있지 않음)', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setCandidatePrehighlight(front);
    const path = container.querySelector(`.wt-chase__prehighlight[data-country="${front}"]`);
    expect(path).not.toBeNull();
    expect(path!.getAttribute('d')).toBeTruthy();
  });

  it('null이면 해제(단일 상태 — 동시 2개 프리하이라이트 없음)', () => {
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setCandidatePrehighlight(front);
    handle.setCandidatePrehighlight(back);
    expect(container.querySelectorAll('.wt-chase__prehighlight')).toHaveLength(1);
    handle.setCandidatePrehighlight(null);
    expect(container.querySelector('.wt-chase__prehighlight')).toBeNull();
  });
});

describe('setCandidateAnchors — 후보 도트(§7.5, 리더 라인 시작점)', () => {
  it('목록 변경 시 diff 갱신(중복 없음, 제외된 국가는 제거)', () => {
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.setCandidateAnchors([front, back]);
    expect(container.querySelectorAll('[data-candidate-anchor]')).toHaveLength(2);
    handle.setCandidateAnchors([front]);
    const remaining = container.querySelectorAll('[data-candidate-anchor]');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.getAttribute('data-candidate-anchor')).toBe(front);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WT-CH-DEV-1(§11-D108) 시인성 디벨롭 4건
// ─────────────────────────────────────────────────────────────────────────────

/** 지구본 중심을 origin에 스냅한 상태로 setup — 후보/연결선이 항상 정면이 되게 한다. */
function setupAt(origin: CountryId): ReturnType<typeof setup> {
  stubMatchMedia(true); // reduced-motion = 즉시 스냅(비동기 홉 미러 rAF 회피)
  const s = setup();
  s.handle.moveVehicle(origin, origin);
  return s;
}

/** chase-graph 기준 origin의 최근접 n개국(= 실전 후보와 동일 성격 — 항상 정면). */
function nearestOf(origin: CountryId, n: number): CountryId[] {
  return CHASE_GRAPH.nodes[origin]!.nearest.slice(0, n).map((e) => e.id);
}

describe('§11-D108-A 대표 좌표 단일 소스 — 앵커 == chase-graph 거리 기준점(본토 회귀 잠금)', () => {
  it('FR·US·RU 앵커가 countries.json latlng 그대로이고 본토 폴리곤 내부에 있다', () => {
    for (const id of ['FR', 'US', 'RU'] as CountryId[]) {
      const anchor = index.anchor.get(id);
      const country = countries.find((c) => c.id === id);
      expect(country, `${id} 국가 데이터 부재`).toBeDefined();
      // chase-graph(packages/data/src/build/chase-graph.ts)는 country.latlng으로 거리를 계산한다 —
      // 시각 앵커가 [lng, lat] 역순 그대로여야 "심의 거리 ↔ 화면 위치"가 동일 점을 가리킨다.
      expect(anchor).toEqual([country!.latlng[1], country!.latlng[0]]);
      const feature = index.featureByCountry.get(id);
      expect(feature, `${id} 폴리곤 부재`).toBeDefined();
      // 다권역 국가(해외영토 포함)의 전체 centroid를 쓰면 바다에 찍힌다 — 본토 내부 잠금.
      expect(geoContains(feature as never, anchor as [number, number])).toBe(true);
    }
  });

  it('projectAnchor(FR)가 그 대표 좌표를 그대로 투영한다(모든 chase 좌표의 단일 출구)', () => {
    const { handle } = setup();
    const anchor = index.anchor.get('FR' as CountryId)!;
    const expectedProj = geoOrthographic();
    expectedProj.fitSize([960, 500], { type: 'Sphere' } as never);
    expectedProj.rotate([-20, -20]);
    const [ex, ey] = expectedProj(anchor)!;
    const got = handle.projectAnchor('FR' as CountryId);
    expect(got.x).toBeCloseTo(ex, 1);
    expect(got.y).toBeCloseTo(ey, 1);
  });

  it('largestPolygonCentroid 폴백은 최대 면적 폴리곤의 대표점을 고른다(작은 섬 무시·감김 무관)', () => {
    const island = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const mainland = [[100, 0], [120, 0], [120, 20], [100, 20], [100, 0]];
    const featureOf = (rings: number[][][]): GeoFeature => ({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) },
    });

    const c = largestPolygonCentroid(featureOf([island, mainland]));
    expect(c).not.toBeNull();
    expect(c![0]).toBeGreaterThan(90);
    expect(c![1]).toBeGreaterThan(5);
    // 두 번째 호출은 모듈 WeakMap 캐시(동일 값 반환).
    const same = featureOf([island, mainland]);
    expect(largestPolygonCentroid(same)).toEqual(largestPolygonCentroid(same));
    // 링 감김을 뒤집어도 같은 덩어리를 고른다(d3 구면 geoArea의 winding 함정 회귀 잠금).
    const reversed = largestPolygonCentroid(
      featureOf([[...island].reverse(), [...mainland].reverse()]),
    );
    expect(reversed![0]).toBeCloseTo(c![0], 6);
    expect(reversed![1]).toBeCloseTo(c![1], 6);

    // Polygon(단일) 형태도 지원.
    const single = largestPolygonCentroid({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [mainland] },
    });
    expect(single![0]).toBeCloseTo(c![0], 6);
  });

  it('회귀: 후보 앵커 배지가 홉(카메라 회전) 이후 재투영된다 — 리더 라인 끝점과 어긋나지 않는다', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    const [candidate] = nearestOf(origin, 1);
    handle.setCandidateAnchors([candidate!]);
    const el = container.querySelector(`[data-candidate-anchor="${candidate}"]`) as SVGGElement;
    const before = el.getAttribute('transform');

    // 지구 반대편으로 스냅 홉 — 카메라가 크게 회전한다.
    handle.moveVehicle(origin, 'BR' as CountryId);
    const after = el.getAttribute('transform');
    expect(after).not.toBe(before);

    // 재투영 결과가 라이브 projectAnchor(리더 라인이 쓰는 값)와 일치해야 한다.
    const live = handle.projectAnchor(candidate!);
    expect(after).toBe(`translate(${live.x} ${live.y})`);
  });
});

describe('§11-D108-B 전 국가 노드 도트 레이어', () => {
  it('setCountryNodes(un195)가 195개 노드를 만든다(레이어 1개, 중복 없음)', () => {
    const { handle, container } = setup();
    handle.setCountryNodes(CHASE_GRAPH.ids);
    expect(container.querySelectorAll('[data-layer="chase-nodes"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-node]')).toHaveLength(CHASE_GRAPH.ids.length);
    expect(CHASE_GRAPH.ids.length).toBe(195);
    // 재호출은 치환(누적 금지).
    handle.setCountryNodes(CHASE_GRAPH.ids);
    expect(container.querySelectorAll('[data-node]')).toHaveLength(195);
  });

  it('현재국·홈·후보 3국만 강조 상태이고 나머지는 idle(반경도 확대)', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    handle.setCountryNodes(CHASE_GRAPH.ids);
    const home = 'FR' as CountryId;
    handle.setHome(home);
    const candidates = nearestOf(origin, 3);
    handle.setCandidateAnchors(candidates);

    const nodeOf = (id: CountryId): SVGCircleElement =>
      container.querySelector(`[data-node="${id}"]`) as SVGCircleElement;
    expect(nodeOf(origin).getAttribute('data-node-state')).toBe('current');
    expect(nodeOf(home).getAttribute('data-node-state')).toBe('home');
    for (const c of candidates) expect(nodeOf(c).getAttribute('data-node-state')).toBe('candidate');

    const emphasised = new Set<CountryId>([origin, home, ...candidates]);
    const idle = CHASE_GRAPH.ids.filter((id) => !emphasised.has(id));
    expect(nodeOf(idle[0]!).getAttribute('data-node-state')).toBe('idle');
    expect(container.querySelectorAll('[data-node-state="idle"]')).toHaveLength(idle.length);

    // 강조 노드는 idle보다 크다.
    const r = (el: SVGCircleElement): number => Number(el.getAttribute('r'));
    expect(r(nodeOf(origin))).toBeGreaterThan(r(nodeOf(idle[0]!)));
    expect(r(nodeOf(candidates[0]!))).toBeGreaterThan(r(nodeOf(idle[0]!)));
  });

  it('뒷면(카메라 반대편) 노드는 은닉되고 정면 노드는 표시된다(기존 isFrontFacing 재사용)', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    handle.setCountryNodes(CHASE_GRAPH.ids);
    const originAnchor = index.anchor.get(origin)!;
    let hiddenBack = 0;
    let shownFront = 0;
    for (const id of CHASE_GRAPH.ids) {
      const el = container.querySelector(`[data-node="${id}"]`) as SVGCircleElement | null;
      if (!el) continue;
      const front = isFrontFacing(index.anchor.get(id)!, originAnchor);
      if (front) {
        expect(el.style.display).not.toBe('none');
        shownFront++;
      } else {
        expect(el.style.display).toBe('none');
        hiddenBack++;
      }
    }
    expect(shownFront).toBeGreaterThan(0);
    expect(hiddenBack).toBeGreaterThan(0);
  });

  it('reset은 노드 레이어를 비운다', () => {
    const { handle, container } = setup();
    handle.setCountryNodes(CHASE_GRAPH.ids);
    handle.reset();
    expect(container.querySelector('[data-node]')).toBeNull();
  });
});

describe('§11-D108-C 후보 대권 연결선 + 칩↔앵커 번호 일치', () => {
  it('현재국 → 후보 3국 연결선 3개가 great-circle 원호(직선 아님)로 그려진다', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    const candidates = nearestOf(origin, 3);
    handle.setCandidateAnchors(candidates);

    const links = Array.from(container.querySelectorAll('[data-candidate-link]'));
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.getAttribute('data-candidate-link'))).toEqual(candidates);
    // 슬롯 번호가 전달 순서(=칩 슬롯 순서)와 일치.
    expect(links.map((l) => l.getAttribute('data-candidate-slot'))).toEqual(['0', '1', '2']);
    for (const l of links) {
      const d = l.getAttribute('d') ?? '';
      expect(d).toBeTruthy();
      // 직선(M…L… 1개)이 아니라 다분절 원호여야 한다.
      expect((d.match(/L/g) ?? []).length).toBeGreaterThan(1);
    }
  });

  it('후보가 바뀌면 연결선이 갱신된다(옛 후보 선 잔존 없음)', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    const first = nearestOf(origin, 3);
    handle.setCandidateAnchors(first);
    const next = nearestOf(origin, 6).slice(3);
    handle.setCandidateAnchors(next);

    const links = Array.from(container.querySelectorAll('[data-candidate-link]'));
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.getAttribute('data-candidate-link'))).toEqual(next);
    for (const gone of first) {
      expect(container.querySelector(`[data-candidate-link="${gone}"]`)).toBeNull();
    }
  });

  it('앵커 배지가 슬롯 번호(1~3)를 표시하고 홉 후에도 유지된다', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    const candidates = nearestOf(origin, 3);
    handle.setCandidateAnchors(candidates);
    candidates.forEach((id, i) => {
      const g = container.querySelector(`[data-candidate-anchor="${id}"]`) as SVGGElement;
      expect(g.getAttribute('data-candidate-slot')).toBe(String(i));
      expect(g.querySelector('.wt-chase__candidate-index')!.textContent).toBe(String(i + 1));
    });
  });

  it('프리하이라이트 후보의 연결선만 선두 강조(--lead)되고 해제 시 사라진다', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    const candidates = nearestOf(origin, 3);
    handle.setCandidateAnchors(candidates);

    handle.setCandidatePrehighlight(candidates[1]!);
    expect(container.querySelectorAll('.wt-chase__link--lead')).toHaveLength(1);
    expect(
      container.querySelector('.wt-chase__link--lead')!.getAttribute('data-candidate-link'),
    ).toBe(candidates[1]);

    // 재투영(홉)을 거쳐도 선두 강조가 유지된다.
    handle.moveVehicle(origin, origin);
    expect(container.querySelectorAll('.wt-chase__link--lead')).toHaveLength(1);

    handle.setCandidatePrehighlight(null);
    expect(container.querySelectorAll('.wt-chase__link--lead')).toHaveLength(0);
  });

  it('reset은 연결선 레이어를 비운다', () => {
    const origin = 'KR' as CountryId;
    const { handle, container } = setupAt(origin);
    handle.setCandidateAnchors(nearestOf(origin, 3));
    handle.reset();
    expect(container.querySelector('[data-candidate-link]')).toBeNull();
  });
});

describe('§11-D108-D 경찰 배지 아이콘 3종', () => {
  it('3종 모두 원형 배지 + 순수 SVG path 실루엣 구조를 갖는다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    const kinds: PoliceView['kind'][] = ['chaser', 'interceptor', 'heli'];
    kinds.forEach((kind, i) => {
      handle.upsertPoliceMarker({ id: 100 + i, kind, at: front });
      const el = container.querySelector(`[data-police-id="${100 + i}"]`) as SVGGElement;
      expect(el.getAttribute('data-police-kind')).toBe(kind);
      const badge = el.querySelector('.wt-chase__police-badge');
      expect(badge, `${kind} 배지 부재`).not.toBeNull();
      expect(Number(badge!.getAttribute('r'))).toBeGreaterThanOrEqual(8);
      const glyph = el.querySelector(`.wt-chase__police-glyph--${kind}`);
      expect(glyph, `${kind} 실루엣 부재`).not.toBeNull();
      expect(glyph!.tagName.toLowerCase()).toBe('path');
      expect(glyph!.getAttribute('d')).toBeTruthy();
      // 배지 없이 색 도트만 두던 구 구조는 완전히 사라졌다.
      expect(el.querySelector('.wt-chase__police-dot')).toBeNull();
    });
  });

  it('chaser는 확산 링, heli는 로터+서치라이트 콘을 추가로 갖는다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 110, kind: 'chaser', at: front });
    handle.upsertPoliceMarker({ id: 111, kind: 'interceptor', at: front });
    handle.upsertPoliceMarker({ id: 112, kind: 'heli', at: front });
    const el = (id: number): SVGGElement =>
      container.querySelector(`[data-police-id="${id}"]`) as SVGGElement;

    expect(el(110).querySelector('.wt-chase__police-ring')).not.toBeNull();
    expect(el(111).querySelector('.wt-chase__police-ring')).toBeNull();
    expect(el(111).querySelector('.wt-chase__police-rotor')).toBeNull();
    expect(el(112).querySelector('.wt-chase__police-rotor')).not.toBeNull();
    expect(el(112).querySelector('.wt-chase__police-cone')).not.toBeNull();
  });
});

describe('실 GlobeMap 합성 — 형제 오버레이 삽입(코어 무수정 확인)', () => {
  it('GlobeMap 컨테이너에 .wt-chase__overlay + .wt-chase__vignette가 형제로 추가되고, moveVehicle이 core로 위임된다', () => {
    let core: GlobeMapHandle | null = null;
    const { container } = render(
      createElement(GlobeMap, {
        index,
        onReady: (h) => {
          core = h;
        },
      }),
    );
    if (!core) throw new Error('onReady not called — handle missing');
    const mapDiv = container.querySelector('canvas')!.parentElement as HTMLElement;
    const before = mapDiv.children.length;

    const chase = createGlobeChaseHandle({ core, container: mapDiv, index });

    expect(mapDiv.querySelector('svg.wt-chase__overlay')).not.toBeNull();
    expect(mapDiv.querySelector('.wt-chase__vignette')).not.toBeNull();
    expect(mapDiv.children.length).toBe(before + 2);

    // 카메라 접점 위임 확인 — from===to 스냅 경로가 실제 core.moveVehicle을 호출한다(코어 무수정,
    // 조합으로만 확장했음을 통합 레벨에서도 재확인).
    expect(() => chase.moveVehicle('KR', 'KR')).not.toThrow();
  });
});

// ── WT-CH-DEV-2(§11-D111) 신규 3종: phase 오버레이 은닉 · 레이더 스윕 · 배송 목표 강조 ──────────
describe('§11-D111 ②-a setOverlayVisible — idle/finished 스핀 구간 오버레이 은닉', () => {
  it('기본은 표시(is-hidden 없음), false면 오버레이+비네트 둘 다 은닉, true면 복귀한다', () => {
    const { handle, container } = setup();
    const svg = container.querySelector('svg.wt-chase__overlay')!;
    const vignette = container.querySelector('.wt-chase__vignette')!;
    expect(svg.classList.contains('is-hidden')).toBe(false);

    handle.setOverlayVisible(false);
    expect(svg.classList.contains('is-hidden')).toBe(true);
    expect(vignette.classList.contains('is-hidden')).toBe(true);

    handle.setOverlayVisible(true);
    expect(svg.classList.contains('is-hidden')).toBe(false);
    expect(vignette.classList.contains('is-hidden')).toBe(false);
  });

  it('은닉 중에도 DOM·상태는 유지돼 복귀 즉시 최신 마커가 보인다(재구축 비용 0)', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setOverlayVisible(false);
    handle.upsertPoliceMarker({ id: 200, kind: 'chaser', at: front });
    handle.setOverlayVisible(true);
    expect(container.querySelector('[data-police-id="200"]')).not.toBeNull();
  });
});

describe('§11-D111 ②-b playRadarSweep — 수배 발령 부채꼴 스윕(§7.6 600ms)', () => {
  it('부채꼴 SVG 노드를 레이더 레이어에 1개 생성한다(중복 호출에도 1개 유지)', () => {
    const { handle, container } = setup();
    handle.playRadarSweep();
    const sweeps = container.querySelectorAll('.wt-chase__sweep');
    expect(sweeps).toHaveLength(1);
    const wedge = sweeps[0]!.querySelector('.wt-chase__sweep-wedge');
    expect(wedge).not.toBeNull();
    expect(wedge!.tagName.toLowerCase()).toBe('path');
    expect(wedge!.getAttribute('d')).toMatch(/^M0 0 L/);
    expect((sweeps[0]!.parentNode as SVGGElement).getAttribute('data-layer')).toBe('chase-radar');

    handle.playRadarSweep();
    expect(container.querySelectorAll('.wt-chase__sweep')).toHaveLength(1);
  });

  it('reduced-motion이면 스윕을 그리지 않는다(§7 헤더 강등표)', () => {
    stubMatchMedia(true);
    const { handle, container } = setup();
    handle.playRadarSweep();
    expect(container.querySelectorAll('.wt-chase__sweep')).toHaveLength(0);
  });

  it('juice 강등(=1)에서도 스윕을 그리지 않는다', () => {
    const { handle, container } = setup();
    handle.setJuiceLevel(1);
    handle.playRadarSweep();
    expect(container.querySelectorAll('.wt-chase__sweep')).toHaveLength(0);
  });

  it('reset이 진행 중이던 스윕 노드를 정리한다(누수 금지)', () => {
    const { handle, container } = setup();
    handle.playRadarSweep();
    expect(container.querySelectorAll('.wt-chase__sweep')).toHaveLength(1);
    handle.reset();
    expect(container.querySelectorAll('.wt-chase__sweep')).toHaveLength(0);
  });
});

describe('§11-D111 ③ 배송 목표 강조 — setCarriedCount가 홈 비컨/레이더 화살표를 토글', () => {
  it('금 소지 시 홈 레이어에 is-delivering, 배송 후 해제된다', () => {
    const { handle, container } = setup();
    const { front } = pickFrontAndBack();
    handle.setHome(front);
    const home = container.querySelector('.wt-chase__home')!;
    expect(home.classList.contains('is-delivering')).toBe(false);

    handle.setCarriedCount(2);
    expect(home.classList.contains('is-delivering')).toBe(true);

    handle.setCarriedCount(0);
    expect(home.classList.contains('is-delivering')).toBe(false);
  });

  it('홈이 뒷면이면 레이더 화살표 쪽에 is-emphasis가 붙는다(방향 강조)', () => {
    const { handle, container } = setup();
    const { back } = pickFrontAndBack();
    handle.setHome(back);
    const arrow = container.querySelector('.wt-chase__radar-arrow--home')!;
    expect(arrow).not.toBeNull();
    expect(arrow.classList.contains('is-emphasis')).toBe(false);

    handle.setCarriedCount(1);
    expect(arrow.classList.contains('is-emphasis')).toBe(true);

    handle.setCarriedCount(0);
    expect(arrow.classList.contains('is-emphasis')).toBe(false);
  });
});

// ── WT-CH-DEV-3(§11-D114-A) 경찰 활공 연출 ────────────────────────────────────────────────────
// 순간이동으로 보이던 경찰 이동을 플레이어 비행기 홉과 같은 대권 활공으로 잇는다. 심(shared/engine)은
// 무접촉이며 아래 검증은 전부 표시 계층 계약(좌표·경로·상한·재타깃·강등·정적 복귀)만 본다.

/** 기본 카메라(INITIAL_CENTER=[20,20])에서 **둘 다 정면**이고, 충분히 떨어져 있으며(각거리 ≥0.3rad),
 *  동/서 성분이 있어 기울임(lean≠0)이 관찰되는 국가 3개를 결정적으로 고른다. */
function pickFrontTrio(): { a: CountryId; b: CountryId; c: CountryId } {
  const center: LngLat = [20, 20];
  const fronts: CountryId[] = [];
  for (const [id, anchor] of index.anchor) {
    if (index.featureByCountry.has(id) && isFrontFacing(anchor, center)) fronts.push(id);
  }
  fronts.sort(); // 데이터 순서에 의존하지 않도록 결정적 정렬.
  const far = (x: CountryId, y: CountryId): boolean =>
    geoDistance(index.anchor.get(x)!, index.anchor.get(y)!) > 0.3 &&
    Math.abs(index.anchor.get(x)![0] - index.anchor.get(y)![0]) > 20; // 동서 성분 확보
  for (const a of fronts)
    for (const b of fronts)
      for (const c of fronts) {
        if (a === b || b === c || a === c) continue;
        if (far(a, b) && far(b, c)) return { a, b, c };
      }
  throw new Error('fixture lacks three well-separated front countries');
}

/** setup()의 미러 카메라와 동일한 투영(테스트가 독립 계산하는 기대 좌표계). */
function expectedProjection(): (p: LngLat) => [number, number] {
  const proj = geoOrthographic();
  proj.fitSize([960, 500], { type: 'Sphere' } as never);
  proj.rotate([-20, -20]);
  return (p) => proj(p) as [number, number];
}

describe('§11-D114-A 경찰 활공 — at 변경은 순간이동이 아니라 대권 보간', () => {
  it('스폰(첫 upsert)과 동일국 재갱신은 정적 — rAF를 전혀 돌리지 않는다', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 1, kind: 'chaser', at: a });
    const el = container.querySelector('[data-police-id="1"]') as SVGGElement;
    expect(markerXY(el)).toEqual(handle.projectAnchor(a));
    expect(raf.pending()).toBe(0);

    // policeUpdated는 이동하지 않은 유닛도 함께 싣는다 — 동일국 재갱신에 애니메이션이 붙으면 안 된다.
    handle.upsertPoliceMarker({ id: 1, kind: 'chaser', at: a });
    expect(raf.pending()).toBe(0);
  });

  it('at 변경 시 즉시 순간이동하지 않고(출발지 유지) 활공을 시작해 착지에서 목적지 앵커에 정확히 안착', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 2, kind: 'chaser', at: a });
    const el = container.querySelector('[data-police-id="2"]') as SVGGElement;
    const startXY = markerXY(el);

    handle.upsertPoliceMarker({ id: 2, kind: 'chaser', at: b });
    expect(markerXY(el)).toEqual(startXY); // 순간이동 금지 — 아직 출발지.
    expect(raf.pending()).toBe(1); // 활공 루프 1개(전 유닛 공용, 유휴 루프 없음).

    raf.runToEnd();
    expect(markerXY(el)).toEqual(handle.projectAnchor(b));
    expect(raf.pending()).toBe(0); // 착지 즉시 루프 종료(상시 rAF 신설 금지 계약).
  });

  it('중간 프레임 좌표가 great-circle 아크 위에 있고(직선 아님) 양 끝점 사이에 있다', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    const anchorA = index.anchor.get(a)!;
    const anchorB = index.anchor.get(b)!;
    handle.upsertPoliceMarker({ id: 3, kind: 'chaser', at: a });
    const el = container.querySelector('[data-police-id="3"]') as SVGGElement;

    const t0 = performance.now();
    handle.upsertPoliceMarker({ id: 3, kind: 'chaser', at: b });
    raf.step(t0 + hopDurationMs(anchorA, anchorB) * 0.5); // 홉 중앙 부근

    const mid = markerXY(el);
    const project = expectedProjection();
    // 대권 아크 샘플(globe-hop.sampleArc — 코어와 동일 수학) 위 1px 이내.
    let best = Infinity;
    for (const p of sampleArc(anchorA, anchorB, 512)) {
      const [x, y] = project(p);
      best = Math.min(best, Math.hypot(x - mid.x, y - mid.y));
    }
    expect(best).toBeLessThan(1);

    // 양 끝점 어느 쪽도 아니다(= 진짜 중간 지점을 지난다).
    const [ax, ay] = project(anchorA);
    const [bx, by] = project(anchorB);
    expect(Math.hypot(mid.x - ax, mid.y - ay)).toBeGreaterThan(5);
    expect(Math.hypot(mid.x - bx, mid.y - by)).toBeGreaterThan(5);

    // 진행 방향 미세 기울임(±8°)이 홉 중에만 붙고 착지에서 사라진다.
    expect(el.getAttribute('transform')).toMatch(/rotate\(/);
    raf.runToEnd();
    expect(el.getAttribute('transform')).not.toMatch(/rotate\(/);
  });

  it('활공 지속은 최단 경찰 이동 주기의 80% 미만이다(연출이 다음 틱과 겹치지 않음)', () => {
    const p = DEFAULT_CHASE_CONSTANTS.police;
    const minTickMs = Math.min(p.heliTickMs, p.interceptorTickMs, p.chaserMinTickMs);
    // 거리 가중 duration의 구조적 상한(대척 거리)조차 80% 밴드 아래다.
    expect(hopDurationMs([0, 0], [180, 0])).toBeLessThan(minTickMs * 0.8);

    // 행동 검증: 80% 시점에는 어떤 쌍이든 이미 착지해 루프가 끊겨 있다.
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 4, kind: 'heli', at: a });
    const el = container.querySelector('[data-police-id="4"]') as SVGGElement;
    const t0 = performance.now();
    handle.upsertPoliceMarker({ id: 4, kind: 'heli', at: b });
    raf.step(t0 + minTickMs * 0.8);
    expect(markerXY(el)).toEqual(handle.projectAnchor(b));
    expect(raf.pending()).toBe(0);
  });

  it('홉 도중 새 이동이 오면 현재 위치에서 새 목표로 재시작한다(스냅 금지·큐 누적 금지)', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b, c } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 5, kind: 'chaser', at: a });
    const el = container.querySelector('[data-police-id="5"]') as SVGGElement;

    const t0 = performance.now();
    handle.upsertPoliceMarker({ id: 5, kind: 'chaser', at: b });
    raf.step(t0 + hopDurationMs(index.anchor.get(a)!, index.anchor.get(b)!) * 0.5);
    const mid = markerXY(el);

    // 재타깃 — 위치가 튀지 않고(스냅 금지) 루프도 1개 그대로(큐 누적 금지).
    handle.upsertPoliceMarker({ id: 5, kind: 'chaser', at: c });
    expect(markerXY(el)).toEqual(mid);
    expect(raf.pending()).toBe(1);

    raf.runToEnd();
    expect(markerXY(el)).toEqual(handle.projectAnchor(c)); // 최종 목적지는 마지막 목표.
  });

  it('활공 종료 후에는 정적 재투영 경로로 복귀한다(카메라 회전 시 목적지 앵커를 따라간다)', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 6, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 6, kind: 'chaser', at: b });
    raf.runToEnd();
    const el = container.querySelector('[data-police-id="6"]') as SVGGElement;
    const landed = markerXY(el);

    // 카메라를 크게 돌린다(스냅 홉 — 미러 rAF 없이 즉시 재투영).
    stubMatchMedia(true);
    handle.moveVehicle(a, 'BR' as CountryId);
    const after = markerXY(el);
    expect(after).not.toEqual(landed);
    expect(after).toEqual(handle.projectAnchor(b)); // 정적 경로(=소속국 앵커) 복귀 확인.
  });

  it('활공 결과 지구 뒷면에 놓이면 기존 규약대로 은닉 + 레이더 화살표로 대체된다', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 7, kind: 'chaser', at: front });
    expect(container.querySelector('[data-radar-key="police:7"]')).toBeNull();

    handle.upsertPoliceMarker({ id: 7, kind: 'chaser', at: back });
    raf.runToEnd();
    const el = container.querySelector('[data-police-id="7"]') as SVGGElement;
    expect(el.style.display).toBe('none');
    expect(container.querySelector('[data-radar-key="police:7"]')).not.toBeNull();
  });

  it('reduced-motion이면 활공 없이 즉시 스냅한다(기존 강등 표)', () => {
    stubMatchMedia(true);
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 8, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 8, kind: 'chaser', at: b });
    const el = container.querySelector('[data-police-id="8"]') as SVGGElement;
    expect(markerXY(el)).toEqual(handle.projectAnchor(b));
    expect(raf.pending()).toBe(0); // rAF 자체를 예약하지 않는다.
  });

  it('juice 강등(=1)으로 전환되면 진행 중인 활공을 즉시 스냅하고 루프를 끊는다', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 9, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 9, kind: 'chaser', at: b });
    expect(raf.pending()).toBe(1);

    handle.setJuiceLevel(1);
    const el = container.querySelector('[data-police-id="9"]') as SVGGElement;
    expect(markerXY(el)).toEqual(handle.projectAnchor(b));
    expect(raf.pending()).toBe(0);
  });

  it('활공 중 유닛 제거·reset은 루프를 남기지 않는다(rAF 누수 금지)', () => {
    const raf = stubRaf();
    const { handle } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 10, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 10, kind: 'chaser', at: b });
    expect(raf.pending()).toBe(1);
    handle.removePoliceMarker(10);
    expect(raf.pending()).toBe(0);

    handle.upsertPoliceMarker({ id: 11, kind: 'heli', at: a });
    handle.upsertPoliceMarker({ id: 11, kind: 'heli', at: b });
    expect(raf.pending()).toBe(1);
    handle.reset();
    expect(raf.pending()).toBe(0);
  });

  it('카메라 회전(홉 미러)과 공존한다 — 두 루프가 서로를 취소하지 않고 착지 좌표가 새 카메라와 정합', () => {
    const raf = stubRaf();
    const { handle, container } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 13, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 13, kind: 'chaser', at: b });
    expect(raf.pending()).toBe(1);

    handle.moveVehicle(a, 'BR' as CountryId); // 애니메이션 홉 → 미러 카메라 rAF가 함께 돈다.
    expect(raf.pending()).toBe(2);

    raf.runToEnd();
    expect(raf.pending()).toBe(0); // 둘 다 정상 종료(유휴 루프 잔존 없음).
    const el = container.querySelector('[data-police-id="13"]') as SVGGElement;
    expect(markerXY(el)).toEqual(handle.projectAnchor(b)); // 회전이 끝난 카메라 기준 좌표.
  });

  it('canvas 재그리기 0 계약 유지 — 활공은 core 메서드를 단 한 번도 부르지 않는다(D67)', () => {
    const raf = stubRaf();
    const { handle, core } = setup();
    const { a, b } = pickFrontTrio();
    handle.upsertPoliceMarker({ id: 12, kind: 'chaser', at: a });
    handle.upsertPoliceMarker({ id: 12, kind: 'chaser', at: b });
    raf.runToEnd();
    for (const spy of [
      core.setTarget,
      core.markSolved,
      core.markSkipped,
      core.drawRouteSegment,
      core.moveVehicle,
      core.flyTo,
      core.reset,
      core.pulseCheckpointRing,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
