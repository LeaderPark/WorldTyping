// spec: docs/03 §3.4(카메라 — 자체 구현, d3-zoom 미사용, computeCamera 산식·WAAPI 800ms·
//       reduced-motion 0·모드별 정책), WT-M2-04
//
// 카메라는 <g data-layer="camera">의 transform: translate(x,y) scale(k) 하나만 조작한다.
// React 미개입 — flyTo가 computeCamera → WAAPI(element.animate)로 전이한다.

import type { CountryId } from '@wt/shared';
import { MAP_HEIGHT, MAP_WIDTH, type GeoIndex } from './geo-index';

/** viewBox 좌표계 카메라 상태. transform = translate(x,y) scale(k). */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

/** 월드 전체 고정(티어/데일리/멀티 기본 · reset 복귀 지점). docs/03 §3.4. */
export const WORLD_CAMERA: Readonly<Camera> = { x: 0, y: 0, k: 1 };

/** 줌 상한. docs/03 §3.4 "k = min(..., K_MAX=8)". 초소국 단일 타깃이 과확대되지 않게. */
export const K_MAX = 8;

/**
 * docs/03 §3.4: 국가 집합의 projected bounds 합집합을 viewBox 960×500에 맞추는 카메라 산출.
 * k = min((960-2p)/bw, (500-2p)/bh, K_MAX), 중심 정렬. 빈 집합/영차원 bounds는 안전 폴백.
 */
export function computeCamera(index: GeoIndex, ids: readonly CountryId[], padding = 40): Camera {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = 0;

  for (const id of ids) {
    const geo = index.byCountry.get(id);
    if (!geo) continue;
    found++;
    const [[x0, y0], [x1, y1]] = geo.bounds;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }

  // 유효한 국가가 없으면 월드 고정으로 폴백(멀미·NaN transform 방지).
  if (found === 0) return { ...WORLD_CAMERA };

  const bw = maxX - minX;
  const bh = maxY - minY;

  // 영차원(단일 점/circle 폴백 하나) → 해당 축 비율은 무한대로 두어 min이 다른 축·K_MAX를 택한다.
  const kx = bw > 0 ? (MAP_WIDTH - 2 * padding) / bw : Infinity;
  const ky = bh > 0 ? (MAP_HEIGHT - 2 * padding) / bh : Infinity;
  let k = Math.min(kx, ky, K_MAX);
  if (!Number.isFinite(k) || k <= 0) k = K_MAX; // 양축 모두 영차원.

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // 스케일 후 중심(cx,cy)이 viewBox 중앙(480,250)에 오도록 translate.
  const x = MAP_WIDTH / 2 - k * cx;
  const y = MAP_HEIGHT / 2 - k * cy;
  return { x, y, k };
}

/** transform 문자열. SVG는 vector-effect:non-scaling-stroke로 국경선 두께를 보정한다(§3.4). */
export function cameraTransform(cam: Camera): string {
  return `translate(${cam.x} ${cam.y}) scale(${cam.k})`;
}

export interface ApplyCameraOptions {
  durationMs?: number;
  /** true면 즉시 스냅(전이 없음). prefers-reduced-motion / juice 강등 / 초기 배치. */
  immediate?: boolean;
}

/**
 * 카메라 그룹에 transform을 적용한다. WAAPI(element.animate) 지원 시 800ms ease-in-out 전이,
 * 미지원(jsdom 등)·immediate·durationMs<=0 이면 즉시 스냅. 최종 transform은 항상 세팅되어
 * 애니메이션 종료 후에도 유지된다.
 */
export function applyCamera(
  cameraEl: SVGGraphicsElement,
  cam: Camera,
  opts: ApplyCameraOptions = {},
): void {
  const target = cameraTransform(cam);
  const duration = opts.immediate ? 0 : opts.durationMs ?? 800;
  const canAnimate = duration > 0 && typeof cameraEl.animate === 'function';

  if (canAnimate) {
    const from = cameraEl.getAttribute('transform') ?? cameraTransform(WORLD_CAMERA);
    cameraEl.animate(
      [{ transform: from }, { transform: target }],
      { duration, easing: 'ease-in-out', fill: 'none' },
    );
  }
  // 애니메이션은 시각 전이일 뿐 — 최종 상태는 attribute로 확정(fill:none이므로 종료 시 이 값 유지).
  cameraEl.setAttribute('transform', target);
}
