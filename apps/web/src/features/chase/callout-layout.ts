// spec: docs/09-chase-mode-goldrunner.md §8.5(콜아웃 배치 알고리즘 5단계 — 표시 전용, 결정적),
//       docs/09a-chase-ui-ux-globe-centric.md §5.2, docs/00 §11-D90~D97, WT-CH-06.
//
// 콜아웃 칩 3개의 화면 배치를 계산하는 순수 함수 모음. 좌표계는 전부 GlobeChaseHandle.projectAnchor가
// 반환하는 것과 동일한 지구본 오버레이 viewBox(960×500) 논리 단위다 — canvas/실제 컨테이너 픽셀이
// 아니다(§7.5 "viewBox 960×500 기준"). React/DOM 의존 0 — CandidateCallouts.tsx가 이 함수들의
// 결과를 컨테이너 실픽셀로 변환(fitViewBoxToContainer)해 절대 위치 스타일로 반영한다.
//
// [배치 알고리즘 5단계, §8.5]
//  1. 기본 위치 = 후보국 투영 좌표에서 지구본 중심 반대 방향(방사상)으로 88px.
//  2. 3개 칩의 방위각 차 32° 미만 → 등각 분산(가까운 순서 유지).
//  3. 칩 AABB 겹침 → 바깥으로 24px씩 추가 밀어내기(최대 2회).
//  4. 뷰포트 클램프 최후 적용.
//  5. 홉 카메라 회전 중에는 재배치하지 않음 — 이 규칙은 시점(호출 타이밍)의 문제라 이 순수 함수의
//     책임 밖이다. CandidateCallouts가 onHopLifecycle('start'|'land')로 이 함수의 호출 시점 자체를
//     게이팅한다(회전 중엔 호출하지 않고 고스트만 표시, 착지 후 1회 호출).
//
// [등각 분산 해석 — 문서 미세부 결정, 최종 보고 기재] "가까운 순서 유지"를 "방위각 오름차순(=상대적
// 시계/반시계 순서)을 바꾸지 않는다"로 해석했다(거리 순서가 아니라 각 순서). 위반 시 재분배 각도는
// 정확히 MIN_ANGLE_SEP_DEG(32°) 간격으로 원 평균각 중심 대칭 배치한다(결정적·최소 수정).
import type { CountryId } from '@wt/shared';

export interface Point {
  x: number;
  y: number;
}

/** GlobeMap/globe-chase.ts와 동일한 논리 좌표계(§7.5). 코어가 export하지 않아 값만 복제(기존 관례). */
export const GLOBE_VIEWBOX = { w: 960, h: 500 } as const;
const GLOBE_CENTER: Point = { x: GLOBE_VIEWBOX.w / 2, y: GLOBE_VIEWBOX.h / 2 };

/** 칩 규격(§8.5 해부도 "chip 176×64"). */
export const CHIP_W = 176;
export const CHIP_H = 64;

const RADIAL_OFFSET = 88;
const MIN_ANGLE_SEP_DEG = 32;
const PUSH_STEP = 24;
const MAX_PUSH_ITERATIONS = 2;

export interface CalloutAnchor {
  id: CountryId;
  x: number;
  y: number;
}

export interface CalloutPosition {
  id: CountryId;
  x: number;
  y: number;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
/** [0,360) 정규화. */
function normDeg(d: number): number {
  let r = d % 360;
  if (r < 0) r += 360;
  return r;
}

interface Polar {
  index: number;
  id: CountryId;
  angleDeg: number;
  dist: number;
}

/**
 * 3개(또는 그 이하) 후보 앵커의 콜아웃 칩 배치를 계산한다(§8.5 1~4단계, 5단계는 호출부 게이팅).
 * 입력 배열 순서를 그대로 보존해 반환(슬롯 인덱스 안정성 — CandidateCallouts가 슬롯 i를
 * candidates[i]에 고정 매핑하는 계약의 전제).
 */
export function computeCalloutLayout(anchors: readonly CalloutAnchor[]): CalloutPosition[] {
  const n = anchors.length;
  if (n === 0) return [];

  const polar: Polar[] = anchors.map((a, index) => {
    const dx = a.x - GLOBE_CENTER.x;
    const dy = a.y - GLOBE_CENTER.y;
    const dist = Math.hypot(dx, dy);
    // 앵커가 정확히 중심과 겹치는 축퇴 케이스(실전 발생 안 함 — 후보는 항상 플레이어 인접국이라
    // 중심에서 떨어져 있음, §8.5 "구조적으로 없음")는 인덱스 기반 각도로 결정적 폴백.
    const angleDeg = dist < 1e-6 ? normDeg(index * (360 / Math.max(1, n))) : normDeg(toDeg(Math.atan2(dy, dx)));
    return { index, id: a.id, angleDeg, dist };
  });

  const angleByIndex = resolveAngularClumping(polar);

  // 1) 기본 위치 = center + unit(angle) × (dist + RADIAL_OFFSET)
  let positions: Point[] = polar.map((p) => {
    const r = p.dist + RADIAL_OFFSET;
    const rad = toRad(angleByIndex.get(p.index)!);
    return { x: GLOBE_CENTER.x + Math.cos(rad) * r, y: GLOBE_CENTER.y + Math.sin(rad) * r };
  });

  // 3) AABB 겹침 → 바깥으로 24px씩(최대 2회)
  for (let iter = 0; iter < MAX_PUSH_ITERATIONS; iter++) {
    let anyOverlap = false;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (boxesOverlap(positions[a]!, positions[b]!)) {
          anyOverlap = true;
          positions[a] = pushOutward(positions[a]!, angleByIndex.get(a)!);
          positions[b] = pushOutward(positions[b]!, angleByIndex.get(b)!);
        }
      }
    }
    if (!anyOverlap) break;
  }

  // 4) 뷰포트 클램프
  positions = positions.map(clampToViewport);

  return polar.map((p, i) => ({ id: p.id, x: positions[i]!.x, y: positions[i]!.y }));
}

/** 방위각 차 32° 미만 쌍이 있으면(등각 분산 조건) 전부 원 평균각 중심으로 32° 간격 재배치. */
function resolveAngularClumping(polar: readonly Polar[]): Map<number, number> {
  const result = new Map<number, number>();
  if (polar.length < 2) {
    for (const p of polar) result.set(p.index, p.angleDeg);
    return result;
  }
  const order = [...polar].sort((a, b) => a.angleDeg - b.angleDeg);
  let clumped = false;
  for (let k = 0; k < order.length; k++) {
    const cur = order[k]!;
    const next = order[(k + 1) % order.length]!;
    const gap = k === order.length - 1 ? normDeg(next.angleDeg - cur.angleDeg) : next.angleDeg - cur.angleDeg;
    if (gap < MIN_ANGLE_SEP_DEG) {
      clumped = true;
      break;
    }
  }
  if (!clumped) {
    for (const p of polar) result.set(p.index, p.angleDeg);
    return result;
  }
  // 원형 평균각(circular mean) — 클러스터 중심.
  let sx = 0;
  let sy = 0;
  for (const p of order) {
    sx += Math.cos(toRad(p.angleDeg));
    sy += Math.sin(toRad(p.angleDeg));
  }
  const meanAngle = normDeg(toDeg(Math.atan2(sy, sx)));
  const mid = (order.length - 1) / 2;
  order.forEach((p, k) => {
    result.set(p.index, normDeg(meanAngle + (k - mid) * MIN_ANGLE_SEP_DEG));
  });
  return result;
}

function boxesOverlap(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < CHIP_W && Math.abs(a.y - b.y) < CHIP_H;
}

function pushOutward(p: Point, angleDeg: number): Point {
  const rad = toRad(angleDeg);
  return { x: p.x + Math.cos(rad) * PUSH_STEP, y: p.y + Math.sin(rad) * PUSH_STEP };
}

function clampToViewport(p: Point): Point {
  const hw = CHIP_W / 2;
  const hh = CHIP_H / 2;
  return {
    x: Math.min(GLOBE_VIEWBOX.w - hw, Math.max(hw, p.x)),
    y: Math.min(GLOBE_VIEWBOX.h - hh, Math.max(hh, p.y)),
  };
}

/**
 * 칩 중심(chipCenter)에서 anchor 방향으로 칩 AABB(CHIP_W×CHIP_H) 경계까지의 교차점 — 리더 라인의
 * 칩 쪽 끝점(칩 중심이 아니라 가장자리에서 시작해야 시각적으로 자연스러움).
 */
export function chipEdgeTowardAnchor(chipCenter: Point, anchor: Point): Point {
  const dx = anchor.x - chipCenter.x;
  const dy = anchor.y - chipCenter.y;
  if (dx === 0 && dy === 0) return chipCenter;
  const hw = CHIP_W / 2;
  const hh = CHIP_H / 2;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(1, tx, ty);
  return { x: chipCenter.x + dx * t, y: chipCenter.y + dy * t };
}

export interface ViewportFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * viewBox(960×500) 논리 좌표 → 실 컨테이너 픽셀 매핑(SVG `preserveAspectRatio="xMidYMid meet"`와
 * 동일 공식 — GlobeMap/globe-chase.ts의 오버레이 SVG가 쓰는 것과 같은 letterbox 규칙). 컨테이너가
 * 아직 레이아웃되지 않았으면(0×0, 예: jsdom) scale=0을 반환한다.
 */
export function fitViewBoxToContainer(
  containerW: number,
  containerH: number,
  vbW: number = GLOBE_VIEWBOX.w,
  vbH: number = GLOBE_VIEWBOX.h,
): ViewportFit {
  if (containerW <= 0 || containerH <= 0 || vbW <= 0 || vbH <= 0) {
    return { scale: 0, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(containerW / vbW, containerH / vbH);
  const offsetX = (containerW - vbW * scale) / 2;
  const offsetY = (containerH - vbH * scale) / 2;
  return { scale, offsetX, offsetY };
}

export function toContainerPx(p: Point, fit: ViewportFit): Point {
  return { x: fit.offsetX + p.x * fit.scale, y: fit.offsetY + p.y * fit.scale };
}
