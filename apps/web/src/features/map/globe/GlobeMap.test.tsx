// @vitest-environment jsdom
//
// spec: docs/03 §3.7(지구본 무대)·§3.2(핸들 계약·리렌더 0), 00 §11-D67, WT-DC-08 acceptance 2번.
// jsdom은 canvas 2d ctx/ResizeObserver 미구현 + 레이아웃 0(clientWidth=0)이라 canvas 렌더는
// 가드로 no-op이지만, 핸들의 SVG 오버레이 조작(ledger·타깃 해제·reset·immediate 스냅·선점)은
// 그대로 검증된다. e3(.wt-map [data-layer=solved|skipped] [data-country]) 셀렉터 계약을 선검증한다.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import type { TopologyLike } from '../geo-index';
import { buildGlobeIndex, type GlobeIndex } from './globe-index';
import { GlobeMap, type GlobeMapHandle } from './GlobeMap';

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

function renderGlobe(): { handle: GlobeMapHandle; container: HTMLElement } {
  let handle: GlobeMapHandle | null = null;
  const { container } = render(
    createElement(GlobeMap, {
      index,
      onReady: (h) => {
        handle = h;
      },
    }),
  );
  if (!handle) throw new Error('onReady not called — handle missing');
  return { handle, container };
}

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

describe('1회 렌더 구조(§3.7)', () => {
  it('canvas + .wt-map.wt-globe__overlay + 전 오버레이 레이어/요소', () => {
    const { container } = renderGlobe();
    expect(container.querySelector('canvas.wt-globe__canvas')).not.toBeNull();
    const svg = container.querySelector('svg.wt-map.wt-globe__overlay');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 960 500');
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    for (const layer of ['solved', 'skipped', 'checkpoint', 'labels', 'vehicle', 'particles']) {
      expect(container.querySelector(`[data-layer="${layer}"]`)).not.toBeNull();
    }
    expect(container.querySelector('.wt-globe__target-ring')).not.toBeNull();
    expect(container.querySelectorAll('[data-layer="labels"] text')).toHaveLength(3);
    // 비행기·타깃 링은 초기 숨김.
    const plane = container.querySelector('[data-layer="vehicle"]') as SVGGElement;
    expect(plane.style.display).toBe('none');
  });

  it('비행기 = 참조 제트 실루엣 path + 정적 transform(노즈 +x 정렬, §11-D73)', () => {
    const { container } = renderGlobe();
    const plane = container.querySelector('.wt-globe__plane')!;
    expect(plane.getAttribute('d')).toMatch(/^M21\.5 15\.5/);
    expect(plane.getAttribute('transform')).toBe('rotate(90) translate(-12 -12)');
  });
});

describe('ledger 추가 — e3 셀렉터 계약(.wt-map [data-layer] [data-country])', () => {
  it('markSolved: solved 레이어에 data-country + .wt-map__solved(d 없는 path)', () => {
    const { handle, container } = renderGlobe();
    handle.markSolved('CO', 'var(--continent-south-america)');
    const node = container.querySelector('.wt-map [data-layer="solved"] [data-country="CO"]');
    expect(node).not.toBeNull();
    expect(node!.getAttribute('class')).toBe('wt-map__solved');
    expect(node!.getAttribute('d')).toBeNull(); // 시각 없음 — 셀렉터 훅 전용.
  });
  it('markSkipped: skipped 레이어에 data-country + .wt-map__skipped, solved와 분리', () => {
    const { handle, container } = renderGlobe();
    handle.markSkipped('VE');
    expect(
      container.querySelector('.wt-map [data-layer="skipped"] [data-country="VE"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.wt-map [data-layer="skipped"] .wt-map__skipped'),
    ).not.toBeNull();
    expect(container.querySelector('[data-layer="solved"] [data-country="VE"]')).toBeNull();
  });
});

describe('타깃 해제(markSolved/markSkipped 시 타깃 링 해제)', () => {
  it('setTarget 후 markSolved(동일국)이면 타깃 링 data-country 해제', () => {
    const { handle, container } = renderGlobe();
    const ring = container.querySelector('.wt-globe__target-ring') as SVGCircleElement;
    handle.setTarget('CO');
    expect(ring.getAttribute('data-country')).toBe('CO');
    handle.markSolved('CO', 'var(--continent-south-america)');
    expect(ring.getAttribute('data-country')).toBeNull();
    expect(ring.style.display).toBe('none');
  });
  it('setTarget(null)이면 링 해제', () => {
    const { handle, container } = renderGlobe();
    const ring = container.querySelector('.wt-globe__target-ring') as SVGCircleElement;
    handle.setTarget('JP');
    expect(ring.getAttribute('data-country')).toBe('JP');
    handle.setTarget(null);
    expect(ring.getAttribute('data-country')).toBeNull();
  });
});

describe('reset — 전 상태 클리어', () => {
  it('ledger·타깃·라벨·비행기 초기화', () => {
    const { handle, container } = renderGlobe();
    handle.setTarget('CO');
    handle.markSolved('CO', 'var(--continent-south-america)');
    handle.markSkipped('VE');
    handle.drawRouteSegment('CO', 'VE');
    handle.setWaypointLabels({
      prev: { id: 'CO', label: '콜롬비아' },
      cur: { id: 'VE', label: '베네수엘라' },
      next: null,
    });
    handle.reset();
    expect(container.querySelector('[data-layer="solved"]')!.children).toHaveLength(0);
    expect(container.querySelector('[data-layer="skipped"]')!.children).toHaveLength(0);
    const ring = container.querySelector('.wt-globe__target-ring') as SVGCircleElement;
    expect(ring.getAttribute('data-country')).toBeNull();
    expect(ring.style.display).toBe('none');
    const plane = container.querySelector('[data-layer="vehicle"]') as SVGGElement;
    expect(plane.style.display).toBe('none');
    for (const text of container.querySelectorAll('[data-layer="labels"] text')) {
      expect(text.textContent).toBe('');
      expect((text as SVGElement).style.display).toBe('none');
    }
  });
});

describe('immediate 스냅(reduced-motion) — 비행기 종점 스냅', () => {
  it('moveVehicle: 비행기 표시 + transform(translate/rotate/scale) + data-country', () => {
    stubMatchMedia(true); // prefers-reduced-motion → immediate
    const { handle, container } = renderGlobe();
    const plane = container.querySelector('[data-layer="vehicle"]') as SVGGElement;
    handle.moveVehicle('KR', 'JP');
    expect(plane.style.display).toBe('');
    expect(plane.getAttribute('data-country')).toBe('JP');
    const t = plane.getAttribute('transform') ?? '';
    expect(t).toMatch(/^translate\(/);
    expect(t).toMatch(/rotate\(/);
    expect(t).toMatch(/scale\(/);
  });
  it('moveVehicle(from===to) 출발역 스냅: rotate(0)', () => {
    stubMatchMedia(true);
    const { handle, container } = renderGlobe();
    const plane = container.querySelector('[data-layer="vehicle"]') as SVGGElement;
    handle.moveVehicle('KR', 'KR', { durationMs: 0 });
    expect(plane.style.display).toBe('');
    expect(plane.getAttribute('transform')).toContain('rotate(0)');
    expect(plane.getAttribute('data-country')).toBe('KR');
  });
});

describe('선점(홉 중 재호출) — 큐잉 없이 최신 목적지로 리타깃', () => {
  it('animated 홉 중 moveVehicle 재호출 시 비행기 목적지가 최신국으로', () => {
    // rAF 존재(=immediate 아님) + reduced-motion 아님 → 애니 홉 경로. 프레임을 굳이 실행하지
    // 않아도 data-country는 동기 세팅되므로 "최신 목적지 = 선점(큐잉 없음)"을 검증할 수 있다.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { handle, container } = renderGlobe();
    const plane = container.querySelector('[data-layer="vehicle"]') as SVGGElement;
    handle.drawRouteSegment('CO', 'VE');
    handle.moveVehicle('CO', 'VE'); // 홉 시작(활성)
    expect(plane.getAttribute('data-country')).toBe('VE');
    handle.drawRouteSegment('VE', 'GY');
    handle.moveVehicle('VE', 'GY'); // 선점 → 리타깃
    expect(plane.getAttribute('data-country')).toBe('GY');
    expect(plane.style.display).toBe('');
  });
});

describe('리렌더 0 계약(§3.2·§3.6)', () => {
  it('핸들 조작은 순수 DOM — React 커밋을 유발하지 않는다', () => {
    // GlobeMap은 memo + 빈 deps effect이므로, 핸들 호출이 예외 없이 SVG DOM만 조작하면 충분하다.
    const { handle } = renderGlobe();
    expect(() => {
      for (let i = 0; i < 10; i++) {
        handle.setTarget('CO');
        handle.markSolved('CO', 'var(--continent-south-america)');
      }
    }).not.toThrow();
  });
});
