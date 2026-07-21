// spec: docs/03 §3.5(노선 라인 — quadratic Bézier 중점 법선 12% 오프셋, 300ms dash 드로잉,
//       날짜변경선 2-패스 분할, 완주 리트레이스 합성 path 1.2s), WT-M2-04
//
// 순수 path 수학 + 얇은 WAAPI dash 헬퍼. 좌표는 전부 viewBox(960×500) projected 좌표계다.

import { MAP_WIDTH } from './geo-index';

export type Point = readonly [number, number];

/** 중점 법선 오프셋 비율(항공 노선 감성). docs/03 §3.5 "거리의 12%". */
const BOW_RATIO = 0.12;
/** 2-패스 분할 시 화면 밖으로 내보내는 여유(px). 프레임을 확실히 벗어나게. */
const OVERSHOOT = 48;

/**
 * docs/03 §3.5: 두 centroid의 x 거리가 뷰포트 절반을 초과하면 날짜변경선(±180)을 가로지르는 것으로
 * 보고 2-패스로 분할한다. (예: 오세아니아 FJ→TO true, 인접 유럽 FR→DE false.)
 */
export function needsAntimeridianWrap(from: Point, to: Point, viewportWidth = MAP_WIDTH): boolean {
  return Math.abs(from[0] - to[0]) > viewportWidth / 2;
}

/** 중점을 진행 방향 법선으로 12% 밀어낸 제어점의 quadratic Bézier d 문자열. */
export function quadraticBezierPath(from: Point, to: Point): string {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  if (len === 0) return `M${x0} ${y0}`;
  // 좌수 법선(-dy,dx)/len 방향으로 거리의 12% 오프셋.
  const off = len * BOW_RATIO;
  const cx = mx + (-dy / len) * off;
  const cy = my + (dx / len) * off;
  return `M${x0} ${y0} Q${cx} ${cy} ${x1} ${y1}`;
}

/**
 * from→to 세그먼트의 d 문자열 배열. 일반은 1개, 날짜변경선 교차는 2개(화면 밖으로 나갔다 들어오는
 * 2-패스). docs/03 §3.5.
 */
export function routeSegmentPaths(from: Point, to: Point, viewportWidth = MAP_WIDTH): string[] {
  if (!needsAntimeridianWrap(from, to, viewportWidth)) {
    return [quadraticBezierPath(from, to)];
  }
  const [x0, y0] = from;
  const [x1, y1] = to;

  // 경계 교차 지점의 y를 "짧은 쪽" 수평 진행 비율로 보간한다.
  if (x0 > x1) {
    // 오른쪽 가장자리로 나갔다가 왼쪽에서 재진입(동진 래핑).
    const horiz = viewportWidth - x0 + x1; // 짧은 경로의 수평 길이
    const f = horiz > 0 ? (viewportWidth - x0) / horiz : 0.5;
    const yEdge = y0 + (y1 - y0) * f;
    return [
      quadraticBezierPath([x0, y0], [viewportWidth + OVERSHOOT, yEdge]),
      quadraticBezierPath([-OVERSHOOT, yEdge], [x1, y1]),
    ];
  }
  // 왼쪽 가장자리로 나갔다가 오른쪽에서 재진입(서진 래핑).
  const horiz = x0 + (viewportWidth - x1);
  const f = horiz > 0 ? x0 / horiz : 0.5;
  const yEdge = y0 + (y1 - y0) * f;
  return [
    quadraticBezierPath([x0, y0], [-OVERSHOOT, yEdge]),
    quadraticBezierPath([viewportWidth + OVERSHOOT, yEdge], [x1, y1]),
  ];
}

/**
 * 완주 리트레이스용 합성 path(전체 노선을 이어붙임). 인접쌍마다 래핑을 반영한다. docs/03 §3.5.
 * points 는 방문 순서 centroid 배열.
 */
export function compositeRoutePath(points: readonly Point[], viewportWidth = MAP_WIDTH): string {
  const segs: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) segs.push(...routeSegmentPaths(a, b, viewportWidth));
  }
  return segs.join(' ');
}

/**
 * dashoffset 드로잉 애니메이션(WAAPI). getTotalLength/animate 미지원(jsdom) 시 즉시 완성형으로
 * 세팅한다(테스트·저사양 폴백). immediate=true(juice 0) 또한 즉시 완성.
 */
export function animateDash(
  pathEl: SVGPathElement,
  durationMs = 300,
  immediate = false,
): void {
  const total =
    typeof pathEl.getTotalLength === 'function' ? safeLength(pathEl) : 0;
  if (total <= 0 || immediate || durationMs <= 0 || typeof pathEl.animate !== 'function') {
    // 완성형: dash 흔적 제거.
    pathEl.style.strokeDasharray = 'none';
    pathEl.style.strokeDashoffset = '0';
    return;
  }
  pathEl.style.strokeDasharray = String(total);
  pathEl.style.strokeDashoffset = String(total);
  pathEl.animate(
    [{ strokeDashoffset: String(total) }, { strokeDashoffset: '0' }],
    { duration: durationMs, easing: 'ease-out', fill: 'forwards' },
  );
  // 최종 확정(애니메이션 fill:forwards가 유지하지만, 조기 GC/재수화 대비 명시).
  pathEl.style.strokeDashoffset = '0';
}

function safeLength(pathEl: SVGPathElement): number {
  try {
    return pathEl.getTotalLength();
  } catch {
    return 0;
  }
}
