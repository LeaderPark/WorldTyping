// spec: docs/03 §3.5(노선 라인 — quadratic Bézier 중점 법선 12% 오프셋, 300ms dash 드로잉,
//       날짜변경선 2-패스 분할, 완주 리트레이스 합성 path 1.2s), WT-M2-04.
//       §11-D63(WT-UI-02): 세그먼트 2-스트로크(흰 케이싱 + 대륙색) + 방문국 스테이션 도트 +
//       이동체 경로 샘플링 헬퍼(getPointAtLength → transform 키프레임 소스).
//
// 순수 path 수학 + 얇은 WAAPI dash 헬퍼 + SVG 노드 팩토리(스테이션 도트) + 경로 샘플러.
// 좌표는 전부 viewBox(960×500) projected 좌표계다. DOM API는 함수 호출 시에만 접근하므로(모듈
// 최상위 부작용 없음) node 환경 테스트(route-layer.test.ts)는 이 파일을 부작용 없이 import한다.

import { MAP_WIDTH } from './geo-index';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 방문국 스테이션 도트 반경(px, viewBox 좌표계). 흰 fill + 대륙색 stroke(§11-D63). */
export const STATION_RADIUS = 3;

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

// ── 스테이션 도트(§11-D63) ─────────────────────────────────────────────────
/**
 * 방문국 centroid에 놓을 스테이션 도트(흰 fill + 대륙색 stroke). colorVar 예: 'var(--continent-asia)'.
 * 채색은 CSS 클래스(.wt-map__station) + 인라인 `--continent-color` 변수로만 — 색을 직접 쓰지 않아
 * 테마 전환에 무수정 대응한다(§3.3와 동일 규약). 팝인 애니메이션은 popInStation이 담당.
 */
export function createStationDot(cx: number, cy: number, colorVar: string): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', String(cx));
  el.setAttribute('cy', String(cy));
  el.setAttribute('r', String(STATION_RADIUS));
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  el.setAttribute('class', 'wt-map__station');
  el.style.setProperty('--continent-color', colorVar);
  return el;
}

/**
 * 스테이션 도트 팝인(WAAPI scale 0→1 1회). immediate(juice 강등/reduced-motion)·animate 미지원 시
 * 애니메이션 없이 즉시 표시(도형은 이미 최종 상태). transform만 사용 — 레이아웃 불변(§4.5).
 * scale 원점은 CSS(transform-box:fill-box; transform-origin:center)가 도트 중심으로 고정한다.
 */
export function popInStation(el: SVGCircleElement, durationMs = 200, immediate = false): void {
  if (immediate || durationMs <= 0 || typeof el.animate !== 'function') return;
  el.animate(
    [
      { transform: 'scale(0)', opacity: 0 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: durationMs, easing: 'ease-out', fill: 'none' },
  );
}

// ── 이동체 경로 샘플링(§11-D63) ────────────────────────────────────────────
/** 이동체 프레임: 위치 + 진행 접선각(deg, +x 기준). transform=translate·rotate 소스. */
export interface VehicleFrame {
  x: number;
  y: number;
  angle: number;
}

/**
 * path를 count개 지점으로 등분해 위치 + 접선각을 샘플한다(이동체 WAAPI 키프레임 소스). 접선은
 * 전후 미세 지점 차분으로 산출한다. getPointAtLength/getTotalLength 미지원(jsdom)·영길이·throw 시
 * 빈 배열을 반환하며, 호출부(moveVehicle)는 이를 종점 스냅 폴백 신호로 쓴다.
 */
export function samplePathFrames(pathEl: SVGPathElement, count = 12): VehicleFrame[] {
  if (
    typeof pathEl.getTotalLength !== 'function' ||
    typeof pathEl.getPointAtLength !== 'function'
  ) {
    return [];
  }
  const total = safeLength(pathEl);
  if (total <= 0) return [];
  const n = Math.max(2, Math.min(24, count));
  const eps = Math.max(0.5, total / 200);
  const frames: VehicleFrame[] = [];
  for (let i = 0; i < n; i++) {
    const len = (total * i) / (n - 1);
    const p = pathEl.getPointAtLength(len);
    const ahead = pathEl.getPointAtLength(Math.min(total, len + eps));
    const behind = pathEl.getPointAtLength(Math.max(0, len - eps));
    const angle = (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
    frames.push({ x: p.x, y: p.y, angle });
  }
  return frames;
}

/**
 * 인접 프레임 각도차가 ±180°를 넘어 이동체가 역회전(스핀)하지 않도록 각도열을 연속화한다.
 * 원 프레임 배열을 변형하지 않고 각도만 보정한 새 배열을 돌려준다.
 */
export function unwrapAngles(frames: readonly VehicleFrame[]): VehicleFrame[] {
  const out: VehicleFrame[] = [];
  let prev = 0;
  frames.forEach((f, i) => {
    let a = f.angle;
    if (i > 0) {
      while (a - prev > 180) a -= 360;
      while (a - prev < -180) a += 360;
    }
    prev = a;
    out.push({ x: f.x, y: f.y, angle: a });
  });
  return out;
}
