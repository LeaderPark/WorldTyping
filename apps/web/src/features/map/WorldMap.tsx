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
  computeLegCamera,
} from './camera';
import {
  animateDash,
  createStationDot,
  popInStation,
  routeSegmentPaths,
  samplePathFrames,
  unwrapAngles,
} from './route-layer';
import type {
  FlyToOptions,
  JuiceLevel,
  MoveVehicleOptions,
  Waypoint,
  WorldMapHandle,
} from './map-handle';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── §11-D63(WT-UI-02) 이동체·라벨 튜닝 상수 ────────────────────────────────
/** 이동체 기본 배율(카메라 k로 나눠 화면상 크기를 대략 일정하게 유지 — 줌 시 비대 방지). */
const VEHICLE_BASE_SCALE = 1;
/** 세그먼트당 경로 샘플 수(8~16 권장). transform 키프레임 개수. */
const VEHICLE_SAMPLES = 14;
/** 이동체 비행 시간(ms) — 노선 드로잉(animateDash 300ms)과 동기. */
const VEHICLE_DURATION_MS = 300;
/** 웨이포인트 라벨 목표 화면 폰트(px) — 카메라 k로 역보정한 user 단위 폰트로 환산. */
const LABEL_BASE_PX = 12;
/** 라벨을 centroid 위로 띄우는 화면상 오프셋(px) — k로 역보정. */
const LABEL_OFFSET_PX = 10;

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 이동체 transform: 위치 이동 + 진행 방향 회전 + 배율(스케일 원점은 plane path 원점). */
function vehicleTransform(x: number, y: number, angleDeg: number, scale: number): string {
  return `translate(${round(x, 2)} ${round(y, 2)}) rotate(${round(angleDeg, 2)}) scale(${round(
    scale,
    3,
  )})`;
}

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
  const skippedRef = useRef<SVGGElement>(null);
  const targetRef = useRef<SVGGElement>(null);
  // §11-D63 여정 무대 레이어.
  const stationsRef = useRef<SVGGElement>(null);
  const checkpointRef = useRef<SVGGElement>(null);
  const vehicleRef = useRef<SVGGElement>(null);
  const labelPrevRef = useRef<SVGTextElement>(null);
  const labelCurRef = useRef<SVGTextElement>(null);
  const labelNextRef = useRef<SVGTextElement>(null);
  // 이동체 경로 샘플용 비-부착 측정 path(getPointAtLength) — 마운트 시 1회 생성.
  const measurePathRef = useRef<SVGPathElement | null>(null);
  // 현재 카메라 배율 k(이동체/라벨 역보정용). flyTo/reset가 갱신.
  const cameraKRef = useRef(1);
  const juiceRef = useRef<JuiceLevel>(0);
  const targetIdRef = useRef<CountryId | null>(null);
  // onReady를 ref로 잡아 마운트 1회 effect에서 최신 참조를 쓴다(deps 최소화 → 재실행 회피).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    // 이동체 경로 측정용 path 1회 생성(부착하지 않음 — getPointAtLength는 path 데이터만 필요).
    if (typeof document !== 'undefined' && !measurePathRef.current) {
      measurePathRef.current = document.createElementNS(SVG_NS, 'path');
    }
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
        // §11-D63: 방문국 centroid 스테이션 도트(흰 fill + 대륙색 stroke) + 팝인. 스킵은 방문이
        // 아니므로 도트 없음(markSkipped 경로 분리).
        const geo = index.byCountry.get(id);
        if (geo && stationsRef.current) {
          const dot = createStationDot(geo.centroid[0], geo.centroid[1], colorVar);
          stationsRef.current.appendChild(dot);
          popInStation(dot, 200, immediate);
        }
        // 확정된 국가가 현재 타깃이면 타깃 하이라이트 해제(중복 점등 방지).
        if (targetIdRef.current === id) {
          clearLayer(targetRef.current);
          targetIdRef.current = null;
        }
      },
      markSkipped(id) {
        // 스킵은 축하 연출이 아니라 상태 표시다 — 회색(--map-skipped) 도형을 skipped 레이어에
        // 추가만 한다(fill 전이 없음, 클래스로만 채색 — 레이아웃 유발 속성 미사용, §3.3·§4.5).
        const shape = createCountryShape(index, id);
        if (!shape || !skippedRef.current) return;
        shape.setAttribute('class', 'wt-map__skipped');
        skippedRef.current.appendChild(shape);
        // 스킵된 국가가 현재 타깃이면 타깃 하이라이트 해제.
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
        // §11-D63: 세그먼트당 2-스트로크 — 아래 흰 케이싱(굵게) + 위 대륙색 라인. 색은 도착국(to)의
        // 대륙색. 둘 다 non-scaling-stroke + 동일 dash 드로잉(원작 노선 2-스트로크 감성).
        const colorVar = `var(--continent-${b.continent})`;
        for (const d of ds) {
          const casing = document.createElementNS(SVG_NS, 'path');
          casing.setAttribute('d', d);
          casing.setAttribute('class', 'wt-map__route-casing');
          casing.setAttribute('vector-effect', 'non-scaling-stroke');
          routeRef.current.appendChild(casing);
          animateDash(casing, 300, immediate);

          const line = document.createElementNS(SVG_NS, 'path');
          line.setAttribute('d', d);
          line.setAttribute('class', 'wt-map__route-line');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          line.style.setProperty('--continent-color', colorVar);
          routeRef.current.appendChild(line);
          animateDash(line, 300, immediate);
        }
      },
      flyTo(ids, opts?: FlyToOptions) {
        if (!cameraRef.current) return;
        // §11-D63: computeLegCamera — 비-래핑 집합은 computeCamera와 동일, 날짜변경선을 걸치는
        // 집합(대륙/일주 leg의 seam 교차, 티어/데일리 전 지구 세트, 일주 완주 리빌)은 월드 폴백.
        const cam = computeLegCamera(index, ids, opts?.padding ?? 40);
        cameraKRef.current = cam.k;
        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        applyCamera(cameraRef.current, cam, {
          durationMs: opts?.durationMs ?? 800,
          immediate,
        });
      },
      reset() {
        clearLayer(routeRef.current);
        clearLayer(solvedRef.current);
        clearLayer(skippedRef.current);
        clearLayer(targetRef.current);
        clearLayer(stationsRef.current);
        clearLayer(checkpointRef.current); // WT-DC-04(③): 진행 중 남은 링 제거
        targetIdRef.current = null;
        cameraKRef.current = 1;
        // 이동체 숨김 + 웨이포인트 라벨 비우기(§11-D63).
        if (vehicleRef.current) {
          vehicleRef.current.style.display = 'none';
          vehicleRef.current.style.opacity = '1';
        }
        for (const el of [labelPrevRef.current, labelCurRef.current, labelNextRef.current]) {
          if (el) {
            el.textContent = '';
            el.style.display = 'none';
          }
        }
        if (cameraRef.current) applyCamera(cameraRef.current, WORLD_CAMERA, { immediate: true });
      },
      setJuiceLevel(level) {
        juiceRef.current = level;
        svgRef.current?.setAttribute('data-juice', String(level));
      },
      moveVehicle(from, to, opts?: MoveVehicleOptions) {
        const a = index.byCountry.get(from);
        const b = index.byCountry.get(to);
        const g = vehicleRef.current;
        if (!a || !b || !g) return;
        g.style.display = ''; // 호출 시 자동 표시.
        g.style.opacity = '1';
        const k = cameraKRef.current || 1;
        const s = VEHICLE_BASE_SCALE / k;

        // 출발역(from===to)은 이동 없이 스냅만.
        if (from === to) {
          g.setAttribute('transform', vehicleTransform(b.centroid[0], b.centroid[1], 0, s));
          return;
        }

        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        const measure = measurePathRef.current;
        const ds = routeSegmentPaths(a.centroid, b.centroid);
        // 각 하위 path(날짜변경선 2-패스)마다 프레임 수집 + 각도 연속화.
        const segFrames: ReturnType<typeof unwrapAngles>[] = [];
        if (measure) {
          for (const d of ds) {
            measure.setAttribute('d', d);
            const f = samplePathFrames(measure, VEHICLE_SAMPLES);
            if (f.length >= 2) segFrames.push(unwrapAngles(f));
          }
        }
        const lastSeg = segFrames[segFrames.length - 1];
        const lastFrame = lastSeg ? lastSeg[lastSeg.length - 1] : undefined;
        const finalAngle = lastFrame ? lastFrame.angle : 0;

        // 샘플 불가(jsdom/미지원)·즉시(reduced-motion/juice 강등)·WAAPI 미지원 → 종점 스냅.
        if (immediate || segFrames.length === 0 || typeof g.animate !== 'function') {
          g.setAttribute(
            'transform',
            vehicleTransform(b.centroid[0], b.centroid[1], finalAngle, s),
          );
          return;
        }

        // 키프레임: 단일 패스는 등간격 보간. 다중 패스는 패스 사이에 opacity 0 프레임을 넣어
        // "첫 패스 종점에서 사라지고 둘째 패스 시점에서 재등장"(화면 밖 텔레포트 은폐)을 표현.
        const keyframes: Keyframe[] = [];
        segFrames.forEach((frames, si) => {
          if (si > 0) {
            const prevSeg = segFrames[si - 1];
            const prevLast = prevSeg ? prevSeg[prevSeg.length - 1] : undefined;
            const first = frames[0];
            if (prevLast && first) {
              keyframes.push({
                transform: vehicleTransform(prevLast.x, prevLast.y, prevLast.angle, s),
                opacity: 0,
              });
              keyframes.push({
                transform: vehicleTransform(first.x, first.y, first.angle, s),
                opacity: 0,
              });
            }
          }
          for (const fr of frames) {
            keyframes.push({ transform: vehicleTransform(fr.x, fr.y, fr.angle, s), opacity: 1 });
          }
        });
        g.animate(keyframes, {
          duration: opts?.durationMs ?? VEHICLE_DURATION_MS,
          easing: 'ease-in-out',
          fill: 'none',
        });
        // 최종 확정(fill:none이므로 애니메이션 종료 후 이 attribute 값으로 안착).
        g.setAttribute('transform', vehicleTransform(b.centroid[0], b.centroid[1], finalAngle, s));
      },
      setVehicleVisible(visible) {
        const g = vehicleRef.current;
        if (!g) return;
        g.style.display = visible ? '' : 'none';
      },
      setWaypointLabels(labels) {
        const k = cameraKRef.current || 1;
        const fontSize = LABEL_BASE_PX / k;
        const offsetY = LABEL_OFFSET_PX / k;
        const apply = (el: SVGTextElement | null, wp: Waypoint | null): void => {
          if (!el) return;
          const geo = wp ? index.byCountry.get(wp.id) : undefined;
          if (!wp || !geo) {
            el.textContent = '';
            el.style.display = 'none';
            return;
          }
          el.textContent = wp.label;
          el.setAttribute('x', String(round(geo.centroid[0], 2)));
          el.setAttribute('y', String(round(geo.centroid[1] - offsetY, 2)));
          el.style.fontSize = `${round(fontSize, 2)}px`;
          el.style.display = '';
        };
        apply(labelPrevRef.current, labels.prev);
        apply(labelCurRef.current, labels.cur);
        apply(labelNextRef.current, labels.next);
      },
      pulseCheckpointRing(id) {
        // WT-DC-04(③): 앰버 링 scale .5→3 + fade 700ms 후 자동 제거. reduced-motion·juice 강등·
        // WAAPI 미지원이면 잔상 방지를 위해 링을 아예 표시하지 않는다.
        const geo = index.byCountry.get(id);
        const layer = checkpointRef.current;
        if (!geo || !layer) return;
        const immediate = juiceRef.current > 0 || prefersReducedMotion();
        if (immediate) return;
        const ring = document.createElementNS(SVG_NS, 'circle');
        ring.setAttribute('cx', String(round(geo.centroid[0], 2)));
        ring.setAttribute('cy', String(round(geo.centroid[1], 2)));
        ring.setAttribute('r', String(CIRCLE_RADIUS));
        ring.setAttribute('vector-effect', 'non-scaling-stroke');
        // 색·형태는 인라인(토큰 --grade-s = 앰버). scale은 자기 중심 기준(fill-box).
        ring.style.fill = 'none';
        ring.style.stroke = 'var(--grade-s)';
        ring.style.strokeWidth = '3';
        ring.style.transformBox = 'fill-box';
        ring.style.transformOrigin = 'center';
        if (typeof ring.animate !== 'function') return;
        layer.appendChild(ring);
        const anim = ring.animate(
          [
            { transform: 'scale(0.5)', opacity: 0.9 },
            { transform: 'scale(3)', opacity: 0 },
          ],
          { duration: 700, easing: 'ease-out', fill: 'none' },
        );
        const remove = (): void => {
          if (ring.parentNode === layer) layer.removeChild(ring);
        };
        anim.onfinish = remove;
        anim.oncancel = remove;
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
          <g ref={skippedRef} data-layer="skipped" />
          <g ref={targetRef} data-layer="target" />
          <g data-layer="dots">{dots}</g>
          {/* §11-D63 여정 무대 레이어(전부 명령형 갱신 — 마운트 후 리렌더 0). 노선 위에 도트,
              그 위에 라벨·이동체 순으로 겹친다. */}
          <g ref={stationsRef} data-layer="stations" />
          {/* WT-DC-04(③): 경유지 체크포인트 앰버 링(펄스 후 자동 제거 — 마운트 후 리렌더 0). */}
          <g ref={checkpointRef} data-layer="checkpoint" aria-hidden="true" />
          <g data-layer="labels" aria-hidden="true">
            <text
              ref={labelPrevRef}
              className="wt-map__label wt-map__label--prev"
              textAnchor="middle"
              style={{ display: 'none' }}
            />
            <text
              ref={labelNextRef}
              className="wt-map__label wt-map__label--next"
              textAnchor="middle"
              style={{ display: 'none' }}
            />
            <text
              ref={labelCurRef}
              className="wt-map__label wt-map__label--cur"
              textAnchor="middle"
              style={{ display: 'none' }}
            />
          </g>
          <g ref={vehicleRef} data-layer="vehicle" aria-hidden="true" style={{ display: 'none' }}>
            {/* 동쪽(+x)을 향하는 비행기 실루엣 — moveVehicle의 rotate가 진행 방향에 정렬한다. */}
            <path
              className="wt-map__vehicle"
              vectorEffect="non-scaling-stroke"
              d="M9 0 L-7 -6 L-3 0 L-7 6 Z"
            />
          </g>
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
