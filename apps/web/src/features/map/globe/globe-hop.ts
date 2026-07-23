// spec: docs/03 §3.7(지구본 여정 무대 — 홉 수학, 00 §11-D67), WT-DC-08. 리드 프로토타입 FEEL 이식:
//       great-circle 보간(slerp→geoInterpolate) + bearing 기체 회전 + easeInOutCubic + 거리 가중
//       duration + lift=sin(π·raw). maplibre 특정 API는 비이식 — 수학·타이밍만 재사용.
//
// 순수 수학 — DOM/canvas 무접촉(node 환경 테스트 가능). d3-geo(vendor-geo 청크)만 의존.

import { geoDistance, geoInterpolate } from 'd3-geo';

/** [경도, 위도] (도). d3-geo projection 입력·앵커 규약과 동일. */
export type LngLat = [number, number];

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** easeInOutCubic — 프로토타입 동일. 홉 raw(0..1) → 이징된 t. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 대권 초기 방위각(deg, 나침반: 0=북, +90=동, -90=서, ±180=남, 시계방향). 프로토타입 bearing 공식.
 * a,b = [경도,위도]. 화면(SVG) 회전으로 쓸 때는 -90(동쪽 +x 실루엣 기준) 보정한다(GlobeMap).
 */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const phi1 = a[1] * RAD;
  const phi2 = b[1] * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return Math.atan2(y, x) * DEG;
}

/** 홉 지속(ms) = clamp(550 + 400·(각거리/π), 550, 900). 먼 나라일수록 살짝 길게(기본 ~0.7s). */
export function hopDurationMs(a: LngLat, b: LngLat): number {
  const dist = geoDistance(a, b); // 라디안 각거리 0..π
  return clamp(550 + 400 * (dist / Math.PI), 550, 900);
}

/**
 * great-circle 아크 n(기본 64)점 샘플. geoInterpolate 결정적(동일 입력 → 동일 배열). 노선 아크
 * 드로잉·진행 홉 프리픽스의 좌표 소스. 첫 점=a, 끝 점=b.
 */
export function sampleArc(a: LngLat, b: LngLat, n = 64): LngLat[] {
  const interp = geoInterpolate(a, b);
  const last = Math.max(1, n - 1);
  const pts: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const p = interp(i / last);
    pts.push([p[0], p[1]]);
  }
  return pts;
}

/**
 * point가 지구본 정면 반구(카메라 중심 center 기준 각거리 < π/2)에 있으면 true. 뒷면(false)의
 * 오버레이(라벨·플레인·링)는 숨긴다 — orthographic 폴리곤 클립과 별개로 오버레이는 수동 판정.
 */
export function isFrontFacing(point: LngLat, center: LngLat): boolean {
  return geoDistance(point, center) < Math.PI / 2;
}
