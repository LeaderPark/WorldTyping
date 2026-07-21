// spec: docs/03 §3.2(컴포넌트 계층·WorldMapHandle·리렌더 0 계약), §3.3(색상 상태), §3.4(카메라),
//       §3.5(노선), §3.6(성능 가드·juice 강등), docs/02 §7(초소국 circle·중립 feature), WT-M2-04
//
// 계약(§3.6): 마운트 후 React 커밋 0회. props는 마운트 시점 상수(index/className/onReady)이며
// 게임 진행은 전부 WorldMapHandle로만 처리한다 — 엔진 이벤트가 초당 수 회 국가를 확정해도
// 폴리곤 서브트리를 재조정하지 않는다(입력 프레임 보호). 핸들 메서드는 SVG DOM만 조작(WAAPI 포함).

import { memo, useEffect, useRef } from 'react';
import type { CountryId } from '@wt/shared';
import {
  CIRCLE_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  type CountryGeo,
  type GeoIndex,
} from './geo-index';
import {
  WORLD_CAMERA,
  applyCamera,
  cameraTransform,
  computeCamera,
} from './camera';
import { animateDash, routeSegmentPaths } from './route-layer';
import type { FlyToOptions, JuiceLevel, WorldMapHandle } from './map-handle';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface WorldMapProps {
  /** 마운트 시점 상수. 부팅 시 1회 구축·동결된 GeoIndex(getGeoIndex). 이후 변경 금지. */
  index: GeoIndex;
  className?: string;
  /** 마운트 후 1회 호출 — 이후 모든 지도 변화는 이 핸들로만. */
  onReady?: (handle: WorldMapHandle) => void;
}

/** 국가의 target/solved 도형(폴리곤 clone 또는 circle)을 생성한다. 없으면 null. */
function createCountryShape(index: GeoIndex, id: CountryId): SVGElement | null {
  const geo = index.byCountry.get(id);
  if (!geo) return null;
  if (geo.featureId !== null) {
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', index.paths.get(geo.featureId) ?? '');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    el.setAttribute('data-country', id);
    return el;
  }
  const [cx, cy] = geo.centroid;
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', String(cx));
  el.setAttribute('cy', String(cy));
  el.setAttribute('r', String(CIRCLE_RADIUS));
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  el.setAttribute('data-country', id);
  return el;
}

function clearLayer(el: SVGGElement | null): void {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function WorldMapImpl({ index, className, onReady }: WorldMapProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const cameraRef = useRef<SVGGElement>(null);
  const routeRef = useRef<SVGGElement>(null);
  const solvedRef = useRef<SVGGElement>(null);
  const targetRef = useRef<SVGGElement>(null);
  const juiceRef = useRef<JuiceLevel>(0);
  const targetIdRef = useRef<CountryId | null>(null);
  // onReady를 ref로 잡아 마운트 1회 effect에서 최신 참조를 쓴다(deps 최소화 → 재실행 회피).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const handle: WorldMapHandle = {
      setTarget(id) {
        clearLayer(targetRef.current);
        targetIdRef.current = id;
        if (id === null) return;
        const shape = createCountryShape(index, id);
        if (!shape || !targetRef.current) return;
        const geo = index.byCountry.get(id) as CountryGeo;
        shape.setAttribute('class', 'wt-map__target');
        // 펄스·하이라이트 색은 대륙색 변수(§3.3). CSS가 테마 전환을 흡수한다.
        shape.style.setProperty('--continent-color', `var(--continent-${geo.continent})`);
        targetRef.current.appendChild(shape);
      },
      markSolved(id, colorVar) {
        const shape = createCountryShape(index, id);
        if (!shape || !solvedRef.current) return;
        shape.setAttribute('class', 'wt-map__solved');
        shape.style.fill = colorVar;
        solvedRef.current.appendChild(shape);
        // fill 0→1 전이 300ms(§3.3). juice 0 또는 애니 미지원이면 즉시.
        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        if (!immediate && typeof shape.animate === 'function') {
          shape.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 300,
            easing: 'ease-out',
            fill: 'none',
          });
        }
        shape.style.opacity = '1';
        // 확정된 국가가 현재 타깃이면 타깃 하이라이트 해제(중복 점등 방지).
        if (targetIdRef.current === id) {
          clearLayer(targetRef.current);
          targetIdRef.current = null;
        }
      },
      drawRouteSegment(from, to) {
        const a = index.byCountry.get(from);
        const b = index.byCountry.get(to);
        if (!a || !b || !routeRef.current) return;
        const ds = routeSegmentPaths(a.centroid, b.centroid);
        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        for (const d of ds) {
          const el = document.createElementNS(SVG_NS, 'path');
          el.setAttribute('d', d);
          el.setAttribute('class', 'wt-map__route');
          el.setAttribute('vector-effect', 'non-scaling-stroke');
          routeRef.current.appendChild(el);
          animateDash(el, 300, immediate);
        }
      },
      flyTo(ids, opts?: FlyToOptions) {
        if (!cameraRef.current) return;
        const cam = computeCamera(index, ids, opts?.padding ?? 40);
        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        applyCamera(cameraRef.current, cam, {
          durationMs: opts?.durationMs ?? 800,
          immediate,
        });
      },
      reset() {
        clearLayer(routeRef.current);
        clearLayer(solvedRef.current);
        clearLayer(targetRef.current);
        targetIdRef.current = null;
        if (cameraRef.current) applyCamera(cameraRef.current, WORLD_CAMERA, { immediate: true });
      },
      setJuiceLevel(level) {
        juiceRef.current = level;
        svgRef.current?.setAttribute('data-juice', String(level));
      },
    };
    onReadyRef.current?.(handle);
    // 마운트 1회만 실행한다(빈 deps). index는 마운트 시점 상수(§3.2 계약)이므로 재구독 불필요 —
    // 이 effect가 재실행되지 않아야 "리렌더 0" 계약(§3.6)이 성립한다.
  }, []);

  // ── 1회 렌더(§3.1). 이후 이 JSX는 다시 그려지지 않는다(핸들만 DOM 조작). ──
  const polygons: JSX.Element[] = [];
  const dots: JSX.Element[] = [];
  for (const [id, geo] of index.byCountry) {
    if (geo.featureId !== null) {
      polygons.push(
        <path
          key={id}
          data-country={id}
          className="wt-map__country"
          vectorEffect="non-scaling-stroke"
          d={index.paths.get(geo.featureId) ?? ''}
        />,
      );
    }
  }
  for (const [id, [cx, cy]] of index.circleFallback) {
    dots.push(
      <circle
        key={id}
        data-country={id}
        className="wt-map__dot"
        vectorEffect="non-scaling-stroke"
        cx={cx}
        cy={cy}
        r={CIRCLE_RADIUS}
      />,
    );
  }
  const neutrals = index.neutralFeatureIds.map((fid) => (
    <path
      key={fid}
      className="wt-map__neutral"
      vectorEffect="non-scaling-stroke"
      d={index.paths.get(fid) ?? ''}
    />
  ));

  return (
    <div className={className}>
      <svg
        ref={svgRef}
        className="wt-map"
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-hidden="true"
        data-juice="0"
        preserveAspectRatio="xMidYMid meet"
      >
        <g ref={cameraRef} data-layer="camera" transform={cameraTransform(WORLD_CAMERA)}>
          <g data-layer="base">
            {neutrals}
            {polygons}
          </g>
          <g ref={routeRef} data-layer="route" />
          <g ref={solvedRef} data-layer="solved" />
          <g ref={targetRef} data-layer="target" />
          <g data-layer="dots">{dots}</g>
        </g>
      </svg>
    </div>
  );
}

/**
 * React.memo — props(index/className/onReady)가 마운트 상수인 한 리렌더되지 않는다(§3.6 계약).
 * 부모는 이 props를 마운트 후 바꾸지 않을 책임이 있다.
 */
export const WorldMap = memo(WorldMapImpl);
