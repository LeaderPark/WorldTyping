// spec: docs/03 §3.7(지구본 여정 무대 — canvas 베이스 + SVG 오버레이, 00 §11-D67), §3.2(핸들
//       계약·리렌더 0)·§3.6(성능 가드·juice)·§4.5(고빈도 값 규약)·§7.3(reduced-motion), WT-DC-08.
//
// 계약(§3.6, WorldMap 승계): 마운트 후 React 커밋 0회. props(index/className/onReady)는 마운트
// 상수이며 게임 진행은 전부 GlobeMapHandle로만 처리한다. 핸들 메서드는 canvas 재그리기(rAF) +
// SVG DOM/WAAPI만 조작(React state 미경유). idle spin은 보딩/결과 배경에서만 ON — playing 중에는
// 홉(moveVehicle)이 없으면 재그리기 0(입력 핫패스 무비용, 리드 지시 ②).
//
// canvas: 바다·경위선·전 폴리곤·노선 아크·스테이션 도트(재투영). SVG 오버레이(.wt-map): 숨김
// ledger([data-layer=solved|skipped]로 e3 셀렉터 보존) · 타깃 펄스 링 · 체크포인트 링 · 라벨 ·
// 비행기 · 파티클. 카메라는 projection.rotate가 홉 보간 위치를 추적한다(easeInOutCubic).

import { memo, useEffect, useRef } from 'react';
import { geoCentroid, geoInterpolate, geoOrthographic, type GeoProjection } from 'd3-geo';
import type { Continent, CountryId } from '@wt/shared';
import type {
  FlyToOptions,
  JuiceLevel,
  MoveVehicleOptions,
  Waypoint,
  WaypointLabels,
  WorldMapHandle,
} from '../map-handle';
import type { GlobeIndex } from './globe-index';
import {
  bearingDeg,
  easeInOutCubic,
  hopDurationMs,
  isFrontFacing,
  sampleArc,
  type LngLat,
} from './globe-hop';
import { drawGlobe, SOLVED_RAMP_MS, type GlobePalette, type RouteEntry } from './globe-render';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 기준 좌표계(고정) — canvas fit transform·SVG viewBox 공통. */
const LOGICAL_W = 960;
const LOGICAL_H = 500;
/** great-circle 아크 샘플 점 수(노선 원장·진행 홉 프리픽스 소스). */
const ARC_SAMPLES = 64;
/** idle spin 각속도 ~0.55°/s(보딩/결과 배경 은은한 드리프트, 홉·juice 강등·reduced-motion 시 자동 정지).
 *  [WT-UI 후속] 1.2°/s가 "확확 도는" 느낌이라 리드 요청으로 절반↓ — 더 자연스러운 배경 회전. */
const SPIN_DEG_PER_MS = 0.55 / 1000;
/** idle spin 재그리기 스로틀(~25fps). 배경 연출은 저프레임으로 충분하고, 상시 60fps 전-폴리곤
 * 재투영이 헤드리스/저사양·백그라운드에서 렌더러를 넘기던 회귀(E1 크래시·cheat-suite 실패)를 막는다. */
const IDLE_MIN_DT = 40;
const TARGET_RING_R = 10;
const CHECKPOINT_RING_R = 10;
/** 라벨을 앵커 위로 띄우는 오프셋(logical px). */
const LABEL_OFFSET = 14;
/** 마운트/리셋 카메라 중심(경도, 위도). idle spin이 곧 전 경도를 순회한다. */
const INITIAL_CENTER: LngLat = [20, 20];
const DPR_MAX = 2;

const CONTINENTS: readonly Continent[] = [
  'asia',
  'europe',
  'africa',
  'north-america',
  'south-america',
  'oceania',
];

/** WorldMapHandle 전 시그니처 승계 + 지구본 전용 setIdleSpin. */
export type GlobeMapHandle = WorldMapHandle & { setIdleSpin(on: boolean): void };

export interface GlobeMapProps {
  /** 마운트 시점 상수(getGlobeIndex/useGlobeIndex). 이후 변경 금지. */
  index: GlobeIndex;
  className?: string;
  /** 마운트 후 1회 호출 — 이후 모든 지도 변화는 이 핸들로만. */
  onReady?: (handle: GlobeMapHandle) => void;
}

interface HopState {
  from: CountryId;
  to: CountryId;
  interp: (t: number) => [number, number];
  start: number;
  duration: number;
  routeEntry: RouteEntry | null;
  pos: LngLat;
  heading: number;
  raw: number;
}

interface FlyState {
  interp: (t: number) => [number, number];
  start: number;
  duration: number;
}

interface CheckpointEntry {
  el: SVGCircleElement;
  id: CountryId;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
/** tokens.css의 --map-·--continent- 토큰을 1회 해석(테마 변경 시 재호출). 루프 내 호출 금지(§4.5). */
function resolvePalette(): GlobePalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  const continent = {} as Record<Continent, string>;
  for (const c of CONTINENTS) continent[c] = v(`--continent-${c}`);
  return {
    ocean: v('--map-ocean'),
    rim: v('--map-rim'),
    graticule: v('--map-graticule'),
    neutral: v('--map-neutral'),
    idle: v('--map-idle'),
    border: v('--map-border'),
    skipped: v('--map-skipped'),
    stationFill: v('--map-station-fill'),
    routeCasing: v('--map-route-casing'),
    continent,
  };
}

function GlobeMapImpl({ index, className, onReady }: GlobeMapProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const solvedLedgerRef = useRef<SVGGElement>(null);
  const skippedLedgerRef = useRef<SVGGElement>(null);
  const checkpointRef = useRef<SVGGElement>(null);
  const targetRingRef = useRef<SVGCircleElement>(null);
  const labelPrevRef = useRef<SVGTextElement>(null);
  const labelCurRef = useRef<SVGTextElement>(null);
  const labelNextRef = useRef<SVGTextElement>(null);
  const planeRef = useRef<SVGGElement>(null);
  const particleRef = useRef<SVGGElement>(null);

  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const projectionRef = useRef<GeoProjection | null>(null);
  const paletteRef = useRef<GlobePalette | null>(null);
  const dprRef = useRef(1);
  const cssWRef = useRef(0);
  const cssHRef = useRef(0);

  // 게임 상태(전부 ref — React state 미경유, 마운트 후 리렌더 0).
  const solvedRef = useRef<Map<CountryId, number>>(new Map());
  const skippedRef = useRef<Set<CountryId>>(new Set());
  const stationsRef = useRef<Set<CountryId>>(new Set());
  const pendingStationRef = useRef<Set<CountryId>>(new Set());
  const routeRef = useRef<RouteEntry[]>([]);
  const targetIdRef = useRef<CountryId | null>(null);
  const labelsRef = useRef<WaypointLabels>({ prev: null, cur: null, next: null });
  const checkpointsRef = useRef<CheckpointEntry[]>([]);

  const cameraRef = useRef<{ lng: number; lat: number }>({
    lng: INITIAL_CENTER[0],
    lat: INITIAL_CENTER[1],
  });
  const hopRef = useRef<HopState | null>(null);
  const flyToRef = useRef<FlyState | null>(null);
  const idleSpinRef = useRef(false);
  const rampUntilRef = useRef(0);
  const lastTsRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const needsDrawRef = useRef(false);
  const juiceRef = useRef<JuiceLevel>(0);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom 등 canvas 미지원 환경에서 getContext가 throw할 수 있다 — null 폴백(렌더는 no-op).
    try {
      ctxRef.current = canvas ? canvas.getContext('2d') : null;
    } catch {
      ctxRef.current = null;
    }

    const projection = geoOrthographic();
    projection.fitSize([LOGICAL_W, LOGICAL_H], { type: 'Sphere' } as never);
    projection.rotate([-cameraRef.current.lng, -cameraRef.current.lat]);
    projectionRef.current = projection;
    paletteRef.current = resolvePalette();
    // 백그라운드 탭(document.hidden)에서는 rAF를 정지한다 — 2-페이지/비가시 상황에서 idle spin의
    // 상시 재투영이 렌더러를 넘기던 회귀 방지(schedule 가드 + visibilitychange에서 취소/재개).
    let hidden = typeof document !== 'undefined' && !!document.hidden;

    const immediate = (): boolean =>
      juiceRef.current > 0 ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame !== 'function';

    const applyCameraRotation = (): void => {
      const p = projectionRef.current;
      if (p) p.rotate([-cameraRef.current.lng, -cameraRef.current.lat]);
    };

    // ── canvas 렌더 ────────────────────────────────────────────────────────
    const render = (now: number): void => {
      const ctx = ctxRef.current;
      const proj = projectionRef.current;
      const pal = paletteRef.current;
      if (!ctx || !proj || !pal) return;
      const cw = cssWRef.current;
      const ch = cssHRef.current;
      const dpr = dprRef.current;
      if (cw <= 0 || ch <= 0) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw * dpr, ch * dpr);
      // SVG "xMidYMid meet"와 동일한 contain 매핑(logical 960×500 → 컨테이너, 중앙 정렬) × dpr.
      const scale = Math.min(cw / LOGICAL_W, ch / LOGICAL_H);
      const tx = (cw - LOGICAL_W * scale) / 2;
      const ty = (ch - LOGICAL_H * scale) / 2;
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr);
      drawGlobe(ctx, proj, pal, {
        index,
        solved: solvedRef.current,
        skipped: skippedRef.current,
        stations: stationsRef.current,
        targetId: targetIdRef.current,
        route: routeRef.current,
        now,
      });
    };

    // ── 오버레이 재투영(홉/스핀 rAF 안에서만 — 정지 시 0, §D67) ──────────────
    const projectAnchor = (id: CountryId): LngLat | null => {
      const a = index.anchor.get(id);
      const p = projectionRef.current;
      if (!a || !p) return null;
      const center: LngLat = [cameraRef.current.lng, cameraRef.current.lat];
      if (!isFrontFacing(a, center)) return null;
      const proj = p(a);
      return proj ? [proj[0], proj[1]] : null;
    };
    const applyLabel = (el: SVGTextElement | null, wp: Waypoint | null): void => {
      if (!el) return;
      const proj = wp ? projectAnchor(wp.id) : null;
      if (!wp || !proj) {
        el.style.display = 'none';
        return;
      }
      el.textContent = wp.label;
      el.setAttribute('x', String(round(proj[0])));
      el.setAttribute('y', String(round(proj[1] - LABEL_OFFSET)));
      el.style.display = '';
    };
    const reprojectLabels = (): void => {
      applyLabel(labelPrevRef.current, labelsRef.current.prev);
      applyLabel(labelCurRef.current, labelsRef.current.cur);
      applyLabel(labelNextRef.current, labelsRef.current.next);
    };
    const reprojectTargetRing = (): void => {
      const ring = targetRingRef.current;
      if (!ring) return;
      const id = targetIdRef.current;
      const proj = id ? projectAnchor(id) : null;
      if (!id || !proj) {
        ring.style.display = 'none';
        return;
      }
      ring.setAttribute('cx', String(round(proj[0])));
      ring.setAttribute('cy', String(round(proj[1])));
      ring.style.display = '';
    };
    const reprojectCheckpoints = (): void => {
      for (const cp of checkpointsRef.current) {
        const proj = projectAnchor(cp.id);
        if (!proj) {
          cp.el.style.display = 'none';
          continue;
        }
        cp.el.setAttribute('cx', String(round(proj[0])));
        cp.el.setAttribute('cy', String(round(proj[1])));
        cp.el.style.display = '';
      }
    };
    const positionPlaneFromHop = (): void => {
      const h = hopRef.current;
      const g = planeRef.current;
      const p = projectionRef.current;
      if (!h || !g || !p) return;
      const proj = p(h.pos);
      if (!proj) return;
      // 카메라가 h.pos를 추적하므로 proj ≈ 화면 중심 — 비행기는 중심에서 lift 스케일·bearing 회전.
      const scale = 1 + Math.sin(Math.PI * h.raw) * 0.85;
      g.style.display = '';
      g.setAttribute(
        'transform',
        `translate(${round(proj[0])} ${round(proj[1])}) rotate(${round(h.heading)}) scale(${round(
          scale,
        )})`,
      );
    };
    const reprojectMovingOverlays = (): void => {
      if (hopRef.current) positionPlaneFromHop();
      reprojectLabels();
      reprojectTargetRing();
      reprojectCheckpoints();
    };

    // ── 도착 연출(스테이션 도트 + pop + 파티클) ──────────────────────────────
    const spawnStationPop = (id: CountryId): void => {
      const layer = particleRef.current;
      const proj = projectAnchor(id);
      if (!layer || !proj) return;
      const cont = index.continent.get(id) ?? 'asia';
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'wt-globe__pop-dot');
      dot.setAttribute('cx', String(round(proj[0])));
      dot.setAttribute('cy', String(round(proj[1])));
      dot.setAttribute('r', '3');
      dot.style.setProperty('--continent-color', `var(--continent-${cont})`);
      if (typeof dot.animate !== 'function') return;
      layer.appendChild(dot);
      const anim = dot.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.7, 0.6)' },
          { transform: 'scale(0.75, 1.5)' },
          { transform: 'scale(1.25, 0.85)' },
          { transform: 'scale(1)' },
        ],
        { duration: 400, easing: 'ease-out', fill: 'none' },
      );
      const remove = (): void => {
        if (dot.parentNode === layer) layer.removeChild(dot);
      };
      anim.onfinish = remove;
      anim.oncancel = remove;
    };
    const spawnParticles = (id: CountryId): void => {
      const layer = particleRef.current;
      const proj = projectAnchor(id);
      if (!layer || !proj) return;
      const cont = index.continent.get(id) ?? 'asia';
      const count = 9;
      for (let i = 0; i < count; i++) {
        const p = document.createElementNS(SVG_NS, 'circle');
        p.setAttribute('class', 'wt-globe__particle');
        p.setAttribute('cx', String(round(proj[0])));
        p.setAttribute('cy', String(round(proj[1])));
        p.setAttribute('r', '2');
        // 색: 대륙색 ↔ 앰버(--grade-s) 교차(축하감).
        p.style.fill = i % 2 === 0 ? `var(--continent-${cont})` : 'var(--grade-s)';
        if (typeof p.animate !== 'function') break;
        layer.appendChild(p);
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        const dist = 14 + Math.random() * 16;
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        const anim = p.animate(
          [
            { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
            { transform: `translate(${round(dx)}px, ${round(dy)}px) scale(0.2)`, opacity: 0 },
          ],
          { duration: 500, easing: 'ease-out', fill: 'none' },
        );
        const remove = (): void => {
          if (p.parentNode === layer) layer.removeChild(p);
        };
        anim.onfinish = remove;
        anim.oncancel = remove;
      }
    };
    const arriveStation = (id: CountryId): void => {
      pendingStationRef.current.delete(id);
      stationsRef.current.add(id);
      if (!immediate()) {
        spawnStationPop(id);
        spawnParticles(id);
      }
      requestDraw();
    };

    // ── rAF 루프 ─────────────────────────────────────────────────────────────
    const finishHop = (h: HopState): void => {
      hopRef.current = null;
      if (h.routeEntry) h.routeEntry.progress = 1;
      arriveStation(h.to); // 도착 시 스테이션 도트 + pop + 파티클(홉 도착 이연 규칙).
    };
    const advance = (now: number): boolean => {
      const cam = cameraRef.current;
      let moved = false;
      const h = hopRef.current;
      if (h) {
        const raw = h.duration > 0 ? clamp((now - h.start) / h.duration, 0, 1) : 1;
        const t = easeInOutCubic(raw);
        const pos = h.interp(t);
        cam.lng = pos[0];
        cam.lat = pos[1];
        h.pos = [pos[0], pos[1]];
        h.raw = raw;
        const ahead = h.interp(Math.min(1, t + 0.02));
        h.heading = bearingDeg([pos[0], pos[1]], [ahead[0], ahead[1]]) - 90;
        if (h.routeEntry) h.routeEntry.progress = raw;
        moved = true;
        if (raw >= 1) finishHop(h);
      } else if (flyToRef.current) {
        const f = flyToRef.current;
        const raw = f.duration > 0 ? clamp((now - f.start) / f.duration, 0, 1) : 1;
        const t = easeInOutCubic(raw);
        const pos = f.interp(t);
        cam.lng = pos[0];
        cam.lat = pos[1];
        moved = true;
        if (raw >= 1) flyToRef.current = null;
      } else if (idleSpinRef.current && !immediate()) {
        // idle spin은 IDLE_MIN_DT(~25fps)로 스로틀 — 상시 60fps 재투영이 아님(CPU 절감·크래시 방지).
        const last = lastTsRef.current;
        if (!last || now - last >= IDLE_MIN_DT) {
          const dt = last ? Math.min(64, now - last) : 16;
          cam.lng = wrapLng(cam.lng + SPIN_DEG_PER_MS * dt);
          lastTsRef.current = now;
          moved = true;
        }
      }
      applyCameraRotation();
      return moved;
    };
    const running = (now: number): boolean => {
      if (hopRef.current || flyToRef.current) return true;
      if (idleSpinRef.current && !immediate()) return true;
      return rampUntilRef.current > now;
    };
    const frame = (): void => {
      rafRef.current = null;
      const now = nowMs();
      const moved = advance(now);
      // moved(카메라 이동)·상태변화(needsDraw)·solved 램프 중에만 재그리기 — idle spin 스로틀 프레임은 스킵.
      if (moved || needsDrawRef.current || rampUntilRef.current > now) {
        needsDrawRef.current = false;
        render(now);
        if (moved) reprojectMovingOverlays();
      }
      if (running(now)) schedule();
    };
    function schedule(): void {
      if (hidden) return;
      if (rafRef.current == null && typeof requestAnimationFrame === 'function') {
        rafRef.current = requestAnimationFrame(frame);
      }
    }
    // 상태 변화 반영용 1프레임 요청(구동기 없으면 그린 뒤 자기 종료 — 상시 루프 아님).
    function requestDraw(): void {
      needsDrawRef.current = true;
      schedule();
      if (typeof requestAnimationFrame !== 'function') render(nowMs());
    }

    // ── 리사이즈(DPR≤2) ──────────────────────────────────────────────────────
    const resize = (): void => {
      const el = containerRef.current;
      const cv = canvasRef.current;
      if (!el || !cv) return;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      cssWRef.current = cw;
      cssHRef.current = ch;
      const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, DPR_MAX);
      dprRef.current = dpr;
      cv.width = Math.max(1, Math.round(cw * dpr));
      cv.height = Math.max(1, Math.round(ch * dpr));
      requestDraw();
    };

    // ── 노선/스테이션 원장 헬퍼 ──────────────────────────────────────────────
    const appendLedger = (group: SVGGElement | null, id: CountryId, cls: string): void => {
      if (!group) return;
      // "d 없는 path" — 시각적으로 비어 있고 e3 셀렉터([data-layer] [data-country])만 보존한다.
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('data-country', id);
      path.setAttribute('class', cls);
      group.appendChild(path);
    };
    const clearChildren = (el: Element | null): void => {
      if (!el) return;
      while (el.firstChild) el.removeChild(el.firstChild);
    };
    const releaseTargetIf = (id: CountryId): void => {
      if (targetIdRef.current !== id) return;
      targetIdRef.current = null;
      const ring = targetRingRef.current;
      if (ring) {
        ring.style.display = 'none';
        ring.removeAttribute('data-country');
      }
    };
    // 현 홉이 소유한 노선(선점 시) 즉시 완성 + 팝 없이 스테이션 확정(pending 고아 방지).
    const completeActiveHop = (): void => {
      const h = hopRef.current;
      if (!h) return;
      if (h.routeEntry) h.routeEntry.progress = 1;
      pendingStationRef.current.delete(h.to);
      stationsRef.current.add(h.to);
    };
    const claimLastRoute = (from: CountryId, to: CountryId): RouteEntry | null => {
      const r = routeRef.current;
      const last = r[r.length - 1];
      if (last && last.from === from && last.to === to) {
        last.progress = 0;
        return last;
      }
      return null;
    };
    const completeLastRoute = (from: CountryId, to: CountryId): void => {
      const r = routeRef.current;
      const last = r[r.length - 1];
      if (last && last.from === from && last.to === to) last.progress = 1;
    };
    const showPlaneAtCenter = (): void => {
      const g = planeRef.current;
      const p = projectionRef.current;
      if (!g || !p) return;
      const c = p([cameraRef.current.lng, cameraRef.current.lat]);
      const x = c ? c[0] : LOGICAL_W / 2;
      const y = c ? c[1] : LOGICAL_H / 2;
      g.style.display = '';
      g.setAttribute('transform', `translate(${round(x)} ${round(y)}) rotate(0) scale(1)`);
    };

    // ── 핸들 ─────────────────────────────────────────────────────────────────
    const handle: GlobeMapHandle = {
      setTarget(id) {
        targetIdRef.current = id;
        const ring = targetRingRef.current;
        if (ring) {
          if (id === null) {
            ring.style.display = 'none';
            ring.removeAttribute('data-country');
          } else {
            const cont = index.continent.get(id) ?? 'asia';
            ring.style.setProperty('--continent-color', `var(--continent-${cont})`);
            ring.setAttribute('data-country', id);
            reprojectTargetRing();
          }
        }
        requestDraw();
      },
      markSolved(id, _colorVar) {
        const imm = immediate();
        solvedRef.current.set(id, imm ? nowMs() - SOLVED_RAMP_MS : nowMs());
        appendLedger(solvedLedgerRef.current, id, 'wt-map__solved');
        releaseTargetIf(id);
        if (imm) {
          stationsRef.current.add(id);
        } else {
          pendingStationRef.current.add(id);
          rampUntilRef.current = Math.max(rampUntilRef.current, nowMs() + SOLVED_RAMP_MS);
          // 홉 도착 이연: 뒤이은 moveVehicle(prev,id)가 홉을 걸면 그 도착이 처리한다. 홉이 없으면
          // (출발국 index 0 등) 동기 핸들러 종료 직후 이 마이크로태스크가 즉시 도착 처리한다.
          queueMicrotask(() => {
            if (pendingStationRef.current.has(id) && hopRef.current?.to !== id) arriveStation(id);
          });
        }
        requestDraw();
      },
      markSkipped(id) {
        skippedRef.current.add(id);
        appendLedger(skippedLedgerRef.current, id, 'wt-map__skipped');
        releaseTargetIf(id);
        requestDraw();
      },
      drawRouteSegment(from, to) {
        const a = index.anchor.get(from);
        const b = index.anchor.get(to);
        if (!a || !b) return;
        const cont = index.continent.get(to) ?? 'asia';
        routeRef.current.push({
          from,
          to,
          arc: sampleArc([a[0], a[1]], [b[0], b[1]], ARC_SAMPLES),
          continent: cont,
          progress: 1,
        });
        requestDraw();
      },
      moveVehicle(from, to, opts?: MoveVehicleOptions) {
        void opts; // duration은 각거리 가중(hopDurationMs)으로 자동 산출 — 표시 전용.
        const g = planeRef.current;
        const b = index.anchor.get(to);
        if (!b || !g) return;
        g.setAttribute('data-country', to);

        // 출발역(from===to): 카메라 스냅 + 비행기 중심 표시(홉·노선 없음).
        if (from === to) {
          completeActiveHop();
          hopRef.current = null;
          cameraRef.current = { lng: b[0], lat: b[1] };
          applyCameraRotation();
          showPlaneAtCenter();
          requestDraw();
          return;
        }

        const a = index.anchor.get(from);
        if (immediate()) {
          completeActiveHop();
          hopRef.current = null;
          completeLastRoute(from, to);
          cameraRef.current = { lng: b[0], lat: b[1] };
          applyCameraRotation();
          pendingStationRef.current.delete(to);
          stationsRef.current.add(to);
          showPlaneAtCenter();
          requestDraw();
          return;
        }

        // 애니 홉. 선점(홉 중 재호출) 시 현 보간 위치에서 리타깃(큐잉 없음).
        let startPos: LngLat;
        const active = hopRef.current;
        if (active) {
          completeActiveHop();
          startPos = active.pos;
        } else {
          startPos = a ? [a[0], a[1]] : [b[0], b[1]];
        }
        const routeEntry = claimLastRoute(from, to);
        hopRef.current = {
          from,
          to,
          interp: geoInterpolate([startPos[0], startPos[1]], [b[0], b[1]]),
          start: nowMs(),
          duration: hopDurationMs([startPos[0], startPos[1]], [b[0], b[1]]),
          routeEntry,
          pos: startPos,
          heading: 0,
          raw: 0,
        };
        g.style.display = '';
        schedule();
      },
      flyTo(ids, opts?: FlyToOptions) {
        const pts = ids
          .map((id) => index.anchor.get(id))
          .filter((a): a is [number, number] => Boolean(a));
        const first = pts[0];
        if (!first) return;
        const target: LngLat =
          pts.length === 1
            ? [first[0], first[1]]
            : (geoCentroid({ type: 'MultiPoint', coordinates: pts } as never) as LngLat);
        if (immediate()) {
          cameraRef.current = { lng: target[0], lat: target[1] };
          applyCameraRotation();
          requestDraw();
          return;
        }
        const from: LngLat = [cameraRef.current.lng, cameraRef.current.lat];
        flyToRef.current = {
          interp: geoInterpolate([from[0], from[1]], [target[0], target[1]]),
          start: nowMs(),
          duration: opts?.durationMs ?? 1200,
        };
        schedule();
      },
      setWaypointLabels(labels) {
        labelsRef.current = labels;
        reprojectLabels();
      },
      pulseCheckpointRing(id) {
        if (immediate()) return;
        const layer = checkpointRef.current;
        if (!layer) return;
        const ring = document.createElementNS(SVG_NS, 'circle');
        ring.setAttribute('class', 'wt-globe__cp-ring');
        ring.setAttribute('r', String(CHECKPOINT_RING_R));
        const proj = projectAnchor(id);
        if (proj) {
          ring.setAttribute('cx', String(round(proj[0])));
          ring.setAttribute('cy', String(round(proj[1])));
        } else {
          ring.style.display = 'none';
        }
        if (typeof ring.animate !== 'function') return;
        layer.appendChild(ring);
        const entry: CheckpointEntry = { el: ring, id };
        checkpointsRef.current.push(entry);
        const anim = ring.animate(
          [
            { transform: 'scale(0.5)', opacity: 0.9 },
            { transform: 'scale(3)', opacity: 0 },
          ],
          { duration: 700, easing: 'ease-out', fill: 'none' },
        );
        const remove = (): void => {
          if (ring.parentNode === layer) layer.removeChild(ring);
          checkpointsRef.current = checkpointsRef.current.filter((e) => e !== entry);
        };
        anim.onfinish = remove;
        anim.oncancel = remove;
      },
      setVehicleVisible(visible) {
        const g = planeRef.current;
        if (g) g.style.display = visible ? '' : 'none';
      },
      setJuiceLevel(level) {
        juiceRef.current = level;
        svgRef.current?.setAttribute('data-juice', String(level));
      },
      setIdleSpin(on) {
        idleSpinRef.current = on;
        if (on && !immediate()) {
          lastTsRef.current = 0;
          schedule();
        }
      },
      reset() {
        if (rafRef.current != null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = null;
        hopRef.current = null;
        flyToRef.current = null;
        idleSpinRef.current = false;
        rampUntilRef.current = 0;
        lastTsRef.current = 0;
        solvedRef.current.clear();
        skippedRef.current.clear();
        stationsRef.current.clear();
        pendingStationRef.current.clear();
        routeRef.current = [];
        targetIdRef.current = null;
        labelsRef.current = { prev: null, cur: null, next: null };
        clearChildren(solvedLedgerRef.current);
        clearChildren(skippedLedgerRef.current);
        clearChildren(checkpointRef.current);
        clearChildren(particleRef.current);
        checkpointsRef.current = [];
        const ring = targetRingRef.current;
        if (ring) {
          ring.style.display = 'none';
          ring.removeAttribute('data-country');
        }
        for (const el of [labelPrevRef.current, labelCurRef.current, labelNextRef.current]) {
          if (el) {
            el.textContent = '';
            el.style.display = 'none';
          }
        }
        const g = planeRef.current;
        if (g) {
          g.style.display = 'none';
          g.removeAttribute('data-country');
        }
        cameraRef.current = { lng: INITIAL_CENTER[0], lat: INITIAL_CENTER[1] };
        applyCameraRotation();
        requestDraw();
      },
    };

    resize();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function' && containerRef.current) {
      ro = new ResizeObserver(() => resize());
      ro.observe(containerRef.current);
    }
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(() => {
        paletteRef.current = resolvePalette();
        requestDraw();
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-contrast'],
      });
    }

    const onVisibility = (): void => {
      hidden = typeof document !== 'undefined' && !!document.hidden;
      if (hidden) {
        if (rafRef.current != null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = null;
      } else {
        lastTsRef.current = 0; // dt 누적 리셋 후 재개.
        if (running(nowMs())) {
          needsDrawRef.current = true;
          schedule();
        }
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    onReadyRef.current?.(handle);

    return () => {
      ro?.disconnect();
      mo?.disconnect();
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (rafRef.current != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
    };
    // 마운트 1회만(빈 deps). index는 마운트 상수(§3.2) — 재실행되지 않아야 "리렌더 0"이 성립한다
    // (WorldMap.tsx와 동일 패턴). onReady는 onReadyRef로 최신값을 읽어 재구독을 피한다.
  }, []);

  return (
    <div ref={containerRef} className={className}>
      <canvas ref={canvasRef} className="wt-globe__canvas" aria-hidden="true" />
      <svg
        ref={svgRef}
        className="wt-map wt-globe__overlay"
        viewBox={`0 0 ${LOGICAL_W} ${LOGICAL_H}`}
        role="img"
        aria-hidden="true"
        data-juice="0"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 숨김 ledger(시각 없음 — e3 셀렉터 .wt-map [data-layer=solved|skipped] [data-country] 보존). */}
        <g ref={solvedLedgerRef} data-layer="solved" />
        <g ref={skippedLedgerRef} data-layer="skipped" />
        <g ref={checkpointRef} data-layer="checkpoint" aria-hidden="true" />
        <circle
          ref={targetRingRef}
          className="wt-globe__target-ring"
          r={TARGET_RING_R}
          style={{ display: 'none' }}
        />
        <g data-layer="labels" aria-hidden="true">
          <text
            ref={labelPrevRef}
            className="wt-globe__label wt-globe__label--prev"
            textAnchor="middle"
            style={{ display: 'none' }}
          />
          <text
            ref={labelNextRef}
            className="wt-globe__label wt-globe__label--next"
            textAnchor="middle"
            style={{ display: 'none' }}
          />
          <text
            ref={labelCurRef}
            className="wt-globe__label wt-globe__label--cur"
            textAnchor="middle"
            style={{ display: 'none' }}
          />
        </g>
        <g ref={planeRef} data-layer="vehicle" aria-hidden="true" style={{ display: 'none' }}>
          {/* 동쪽(+x)을 향하는 비행기 실루엣 — bearing-90 회전이 진행 방향에 정렬한다. */}
          <path className="wt-globe__plane" d="M9 0 L-7 -6 L-3 0 L-7 6 Z" />
        </g>
        <g ref={particleRef} data-layer="particles" aria-hidden="true" />
      </svg>
    </div>
  );
}

/**
 * React.memo — props(index/className/onReady)가 마운트 상수인 한 리렌더되지 않는다(§3.6 계약).
 * 부모(GamePage)는 이 props를 마운트 후 바꾸지 않을 책임이 있다.
 */
export const GlobeMap = memo(GlobeMapImpl);
