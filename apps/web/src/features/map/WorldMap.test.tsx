// @vitest-environment jsdom
//
// spec: docs/03 §3.2(핸들 계약)·§3.3(색상)·§3.5(노선)·§3.6(리렌더 0 계약), WT-M2-04.
// acceptance 대체 조정(리드 사전 승인): React.Profiler onRender로 setTarget/markSolved 연속 10회 시
// WorldMap 커밋 0회를 자동 어서션한다(실브라우저 Profiler 캡처는 리드 수동 확인).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Profiler, createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { buildGeoIndex, type GeoIndex, type TopologyLike } from './geo-index';
import { WorldMap } from './WorldMap';
import type { WorldMapHandle } from './map-handle';

// jsdom에서 import.meta.url이 file: 스킴이 아니므로 cwd 기준 후보 경로로 산출물을 로드한다.
function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let index: GeoIndex;

beforeAll(() => {
  const topo = load('countries-110m.json') as TopologyLike;
  const dataset = load('countries.json') as { countries: Country[] };
  index = buildGeoIndex(topo, dataset.countries);
});

afterEach(cleanup);

function renderMap(): { handle: WorldMapHandle; container: HTMLElement } {
  let handle: WorldMapHandle | null = null;
  const { container } = render(
    createElement(WorldMap, {
      index,
      onReady: (h) => {
        handle = h;
      },
    }),
  );
  if (!handle) throw new Error('onReady not called — handle missing');
  return { handle, container };
}

describe('1회 렌더 구조(§3.2)', () => {
  it('5개 레이어 + base 폴리곤 + dots circle 렌더', () => {
    const { container } = renderMap();
    for (const layer of ['camera', 'base', 'route', 'solved', 'skipped', 'target', 'dots']) {
      expect(container.querySelector(`[data-layer="${layer}"]`)).not.toBeNull();
    }
    expect(container.querySelectorAll('[data-layer="base"] path').length).toBeGreaterThan(100);
    expect(container.querySelectorAll('[data-layer="dots"] circle').length).toBeGreaterThan(0);
  });
  it('svg viewBox 고정·aria-hidden·전 path에 non-scaling-stroke', () => {
    const { container } = renderMap();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 960 500');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const first = container.querySelector('[data-layer="base"] path')!;
    expect(first.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  });
});

describe('리렌더 0 계약(§3.6) — Profiler 커밋 카운트', () => {
  it('setTarget/markSolved 연속 10회에도 update 커밋 0회', () => {
    let handle: WorldMapHandle | null = null;
    let updateCommits = 0;
    const onRender = (_id: string, phase: string): void => {
      if (phase === 'update') updateCommits++;
    };
    render(
      createElement(
        Profiler,
        { id: 'worldmap', onRender },
        createElement(WorldMap, {
          index,
          onReady: (h: WorldMapHandle) => {
            handle = h;
          },
        }),
      ),
    );
    // 마운트 직후 update 커밋은 0이어야 한다(mount 페이즈만).
    expect(updateCommits).toBe(0);
    const h = handle as unknown as WorldMapHandle;
    for (let i = 0; i < 10; i++) {
      h.setTarget('KR');
      h.markSolved('KR', 'var(--continent-asia)');
    }
    // 핸들 조작은 순수 DOM — React 커밋을 유발하지 않는다.
    expect(updateCommits).toBe(0);
  });
});

describe('핸들 명령형 조작(§3.2)', () => {
  it('setTarget: 폴리곤 국가는 target 레이어에 path 1개', () => {
    const { handle, container } = renderMap();
    handle.setTarget('KR');
    const target = container.querySelector('[data-layer="target"]')!;
    expect(target.children).toHaveLength(1);
    const el = target.querySelector('[data-country="KR"]')!;
    expect(el.tagName.toLowerCase()).toBe('path');
    // 이전 타깃 해제: 새 타깃 지정 시 1개 유지.
    handle.setTarget('JP');
    expect(target.children).toHaveLength(1);
    expect(target.querySelector('[data-country="JP"]')).not.toBeNull();
    // null이면 해제.
    handle.setTarget(null);
    expect(target.children).toHaveLength(0);
  });
  it('setTarget: 초소국(MC)은 circle로 점등', () => {
    const { handle, container } = renderMap();
    handle.setTarget('MC');
    const el = container.querySelector('[data-layer="target"] [data-country="MC"]')!;
    expect(el.tagName.toLowerCase()).toBe('circle');
  });
  it('markSolved: solved 레이어에 색 지정 도형 추가·타깃 해제', () => {
    const { handle, container } = renderMap();
    handle.setTarget('KR');
    handle.markSolved('KR', 'var(--continent-asia)');
    const solved = container.querySelector('[data-layer="solved"] [data-country="KR"]') as SVGElement;
    expect(solved).not.toBeNull();
    expect(solved.style.fill).toBe('var(--continent-asia)');
    // 같은 국가 확정 시 타깃 하이라이트 제거.
    expect(container.querySelector('[data-layer="target"]')!.children).toHaveLength(0);
  });
  it('markSkipped: skipped 레이어에 .wt-map__skipped 도형 추가·타깃 해제(solved와 분리)', () => {
    const { handle, container } = renderMap();
    handle.setTarget('KR');
    handle.markSkipped('KR');
    const skipped = container.querySelector(
      '[data-layer="skipped"] [data-country="KR"]',
    ) as SVGElement;
    expect(skipped).not.toBeNull();
    expect(skipped.getAttribute('class')).toBe('wt-map__skipped');
    // 스킵은 solved가 아니다 — solved 레이어에는 들어가지 않는다.
    expect(container.querySelector('[data-layer="solved"] [data-country="KR"]')).toBeNull();
    // 스킵된 국가가 현재 타깃이면 타깃 하이라이트 해제.
    expect(container.querySelector('[data-layer="target"]')!.children).toHaveLength(0);
  });
  it('markSkipped: 초소국(MC)은 circle로 스킵 표시', () => {
    const { handle, container } = renderMap();
    handle.markSkipped('MC');
    const el = container.querySelector('[data-layer="skipped"] [data-country="MC"]')!;
    expect(el.tagName.toLowerCase()).toBe('circle');
    expect(el.getAttribute('class')).toBe('wt-map__skipped');
  });
  it('drawRouteSegment: 비래핑은 route 레이어에 path 1개', () => {
    const { handle, container } = renderMap();
    handle.drawRouteSegment('KR', 'JP');
    expect(container.querySelectorAll('[data-layer="route"] path')).toHaveLength(1);
  });
  it('flyTo: 카메라 transform이 월드 고정에서 변한다', () => {
    const { handle, container } = renderMap();
    const cam = container.querySelector('[data-layer="camera"]')!;
    expect(cam.getAttribute('transform')).toBe('translate(0 0) scale(1)');
    handle.flyTo(['KR']);
    expect(cam.getAttribute('transform')).not.toBe('translate(0 0) scale(1)');
  });
  it('reset: target/solved/route 비우고 카메라 월드 복귀', () => {
    const { handle, container } = renderMap();
    handle.setTarget('KR');
    handle.markSolved('JP', 'var(--continent-asia)');
    handle.markSkipped('CN');
    handle.drawRouteSegment('KR', 'JP');
    handle.flyTo(['KR']);
    handle.reset();
    expect(container.querySelector('[data-layer="target"]')!.children).toHaveLength(0);
    expect(container.querySelector('[data-layer="solved"]')!.children).toHaveLength(0);
    expect(container.querySelector('[data-layer="skipped"]')!.children).toHaveLength(0);
    expect(container.querySelector('[data-layer="route"]')!.children).toHaveLength(0);
    expect(container.querySelector('[data-layer="camera"]')!.getAttribute('transform')).toBe(
      'translate(0 0) scale(1)',
    );
  });
  it('setJuiceLevel: svg data-juice 속성 반영', () => {
    const { handle, container } = renderMap();
    handle.setJuiceLevel(1);
    expect(container.querySelector('svg')!.getAttribute('data-juice')).toBe('1');
  });
});

describe('WAAPI / reduced-motion 분기(§3.3~3.5)', () => {
  // jsdom 기본은 matchMedia·animate 미구현 → 실브라우저 분기를 스텁으로 재현한다.
  function stubMatchMedia(matches: boolean): void {
    window.matchMedia = ((query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  it('reduced-motion 아님 + animate 지원 → markSolved/flyTo가 WAAPI 사용', () => {
    const origMM = window.matchMedia;
    const origAnimate = Element.prototype.animate;
    const spy = vi.fn(() => ({}) as Animation);
    stubMatchMedia(false);
    Element.prototype.animate = spy as unknown as Element['animate'];
    try {
      const { handle } = renderMap();
      handle.setTarget('KR');
      handle.markSolved('KR', 'var(--continent-asia)'); // opacity 0→1 전이
      handle.flyTo(['KR']); // 카메라 WAAPI 전이
      expect(spy).toHaveBeenCalled();
    } finally {
      window.matchMedia = origMM;
      Element.prototype.animate = origAnimate;
    }
  });

  it('reduced-motion → 즉시(WAAPI 미사용)', () => {
    const origMM = window.matchMedia;
    const origAnimate = Element.prototype.animate;
    const spy = vi.fn(() => ({}) as Animation);
    stubMatchMedia(true);
    Element.prototype.animate = spy as unknown as Element['animate'];
    try {
      const { handle } = renderMap();
      handle.markSolved('KR', 'var(--continent-asia)');
      handle.flyTo(['KR']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = origMM;
      Element.prototype.animate = origAnimate;
    }
  });
});
