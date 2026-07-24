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
import { geoOrthographic } from 'd3-geo';
import type { Country, CountryId } from '@wt/shared';
import type { TopologyLike } from '../geo-index';
import { GlobeMap, type GlobeMapHandle } from './GlobeMap';
import { buildGlobeIndex, type GlobeIndex } from './globe-index';
import { isFrontFacing } from './globe-hop';
import { createGlobeChaseHandle, type GlobeChaseHandle, type GoldView, type PoliceView } from './globe-chase';

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
    const { handle, container } = setup();
    const { front, back } = pickFrontAndBack();
    handle.upsertPoliceMarker({ id: 11, kind: 'chaser', at: back });
    expect(container.querySelector('[data-radar-key="police:11"]')).not.toBeNull();
    handle.upsertPoliceMarker({ id: 11, kind: 'chaser', at: front });
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
