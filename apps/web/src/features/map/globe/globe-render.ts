// spec: docs/03 §3.7(지구본 canvas 1패스 렌더, 00 §11-D67), docs/02 §7(중립 feature),
//       docs/00 §11-D62(브랜드 원색 = 지도 fill 전용, 텍스트 금지), WT-DC-08.
//
// canvas 1패스로 지구본을 그린다: 바다 원판→림→경위선→중립→기본 폴리곤→skipped→solved(알파
// 램프)→target(밝기)→노선 아크(완주=대륙색, progress<1 홉은 비드로잉)→활성 홉 트레일(앰버 점선/
// 글로우 3-패스)→스테이션 도트. projection은 호출부(GlobeMap)가 매 프레임 rotate해 넘긴다.
// orthographic은 뒷면 폴리곤/아크를 자동 클립한다.
//
// [Tweak E §11-D73] 진행 홉의 대륙색 프리픽스 표시는 폐기(트레일과 이중 표시 방지) — 완주 노선
// (progress=1)만 대륙색 아크로 확정 표시하고, 비행 중 경로는 앰버 트레일이 그린다. 트레일 글로우는
// blur/shadowBlur(핫루프 크래시 회귀 이력) 대신 폭 계층 3-패스로 에뮬레이트한다.
//
// **팔레트는 사전 해석된 색 문자열 객체로 주입한다** — 루프 내 getComputedStyle/문자열 SVG d
// 재생성/레이아웃 유발 속성 금지(docs/03 §4.5 핫패스 규약). ctx는 fit transform(logical 960×500)
// 이 이미 적용된 상태로 들어온다.

import { geoGraticule10, geoPath, type GeoProjection } from 'd3-geo';
import type { Continent, CountryId } from '@wt/shared';
import type { GlobeIndex } from './globe-index';
import { isFrontFacing, type LngLat } from './globe-hop';

/** solved 대륙색 fill 0→1 알파 램프 시간(ms). markSolved solvedAt 기준. */
export const SOLVED_RAMP_MS = 300;
/** 스테이션 도트 반경(logical px). */
const STATION_RADIUS = 3;

/** 사전 해석된 색 문자열 팔레트(GlobeMap이 getComputedStyle로 1회 해석·테마 변경 시 재해석). */
export interface GlobePalette {
  ocean: string;
  rim: string;
  graticule: string;
  neutral: string;
  idle: string;
  border: string;
  skipped: string;
  stationFill: string;
  routeCasing: string;
  /** 활성 홉 트레일 코어(앰버 점선, --globe-trail). */
  trail: string;
  /** 활성 홉 트레일 글로우(--globe-trail-glow). */
  trailGlow: string;
  continent: Record<Continent, string>;
}

/** 노선 원장 세그먼트 — 아크는 사전 샘플(globe-hop.sampleArc). progress<1(진행 홉)은 앰버 트레일이
 *  대신 그리고, 완주(progress=1)만 대륙색 아크로 그린다(§11-D73). */
export interface RouteEntry {
  from: CountryId;
  to: CountryId;
  arc: LngLat[];
  continent: Continent;
  /** 0..1 진행 비율(진행 홉이 구동, 완성=1). 렌더는 완주(=1)만 그린다 — 진행 중은 트레일이 담당. */
  progress: number;
}

/** drawGlobe 입력 상태(전부 GlobeMap ref가 소유하는 가변 컨테이너의 읽기 뷰). */
export interface GlobeRenderState {
  index: GlobeIndex;
  /** CountryId → solvedAt(ms). 대륙색 fill, (now-solvedAt)/RAMP 알파. */
  solved: ReadonlyMap<CountryId, number>;
  skipped: ReadonlySet<CountryId>;
  /** 방문 완료 스테이션 도트(홉 도착 시 등록). */
  stations: ReadonlySet<CountryId>;
  targetId: CountryId | null;
  route: readonly RouteEntry[];
  /** 활성 홉 트레일(비행 위치 점 + 페이드 알파). null=트레일 없음(Tweak E §11-D73). */
  trail: { pts: readonly LngLat[]; alpha: number } | null;
  now: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 지구본 1패스 렌더. ctx는 fit transform 적용 완료(logical 960×500 좌표). projection은 현재
 * 카메라로 rotate된 orthographic. palette는 사전 해석 색.
 */
export function drawGlobe(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  palette: GlobePalette,
  state: GlobeRenderState,
): void {
  const path = geoPath(projection, ctx);
  const { index } = state;
  const contOf = (id: CountryId): Continent => index.continent.get(id) ?? 'asia';

  // 1) 바다 원판 + 2) 림.
  ctx.beginPath();
  path({ type: 'Sphere' } as never);
  ctx.fillStyle = palette.ocean;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.rim;
  ctx.stroke();

  // 3) 경위선(극옅음).
  ctx.beginPath();
  path(geoGraticule10() as never);
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.32;
  ctx.strokeStyle = palette.graticule;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 4) 중립 feature(속령·미승인).
  ctx.fillStyle = palette.neutral;
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 0.5;
  for (const f of index.neutralFeatures) {
    ctx.beginPath();
    path(f as never);
    ctx.fill();
    ctx.stroke();
  }

  // 5) 기본 국가 폴리곤(idle). solved/skipped/target은 아래에서 덧칠(불투명/반투명 램프).
  ctx.fillStyle = palette.idle;
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 0.5;
  for (const f of index.featureByCountry.values()) {
    ctx.beginPath();
    path(f as never);
    ctx.fill();
    ctx.stroke();
  }

  // 6) skipped(회색 불투명).
  ctx.fillStyle = palette.skipped;
  ctx.strokeStyle = palette.border;
  for (const id of state.skipped) {
    const f = index.featureByCountry.get(id);
    if (!f) continue;
    ctx.beginPath();
    path(f as never);
    ctx.fill();
    ctx.stroke();
  }

  // 7) solved(대륙색 + solvedAt 300ms 알파 램프).
  for (const [id, solvedAt] of state.solved) {
    const f = index.featureByCountry.get(id);
    if (!f) continue;
    const alpha = clamp01((state.now - solvedAt) / SOLVED_RAMP_MS);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    path(f as never);
    ctx.fillStyle = palette.continent[contOf(id)];
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    path(f as never);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = palette.border;
    ctx.stroke();
  }

  // 8) target(대륙색 + 밝기). stationFill(테마별 밝은 색)을 저알파로 덧칠해 밝힌다(원색 하드코딩 회피).
  if (state.targetId) {
    const f = index.featureByCountry.get(state.targetId);
    if (f) {
      const cont = contOf(state.targetId);
      ctx.beginPath();
      path(f as never);
      ctx.fillStyle = palette.continent[cont];
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      path(f as never);
      ctx.fillStyle = palette.stationFill;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      path(f as never);
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.continent[cont];
      ctx.stroke();
    }
  }

  // 9) 노선 아크(케이싱 4px + 대륙색 2.5px). 진행 홉(progress<1)은 앰버 트레일이 대신 그리므로
  // 비드로잉 — 완주(progress=1) 노선만 대륙색 아크로 확정(§11-D73). orthographic이 뒷면 클립.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const seg of state.route) {
    if (seg.progress < 1) continue;
    const n = seg.arc.length;
    if (n < 2) continue;
    const line = { type: 'LineString', coordinates: seg.arc };
    ctx.beginPath();
    path(line as never);
    ctx.lineWidth = 4;
    ctx.strokeStyle = palette.routeCasing;
    ctx.stroke();
    ctx.beginPath();
    path(line as never);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = palette.continent[seg.continent];
    ctx.stroke();
  }

  // 9b) 활성 홉 트레일(참조 앰버 점선+글로우). blur/shadowBlur 금지 → 폭 계층 3-패스 에뮬레이트(§11-D73).
  //     alpha = 페이드 알파(순항 1 → 도착 후 0). 노선 아크 뒤·스테이션 도트 앞.
  const trail = state.trail;
  if (trail && trail.pts.length >= 2) {
    const a = trail.alpha;
    const line = { type: 'LineString', coordinates: trail.pts };
    // glow A(넓은 저알파).
    ctx.beginPath();
    path(line as never);
    ctx.lineWidth = 10;
    ctx.strokeStyle = palette.trailGlow;
    ctx.globalAlpha = 0.12 * a;
    ctx.stroke();
    // glow B(중간).
    ctx.beginPath();
    path(line as never);
    ctx.lineWidth = 6;
    ctx.strokeStyle = palette.trailGlow;
    ctx.globalAlpha = 0.18 * a;
    ctx.stroke();
    // core(앰버 점선).
    ctx.setLineDash([2.4, 4.8]);
    ctx.beginPath();
    path(line as never);
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.trail;
    ctx.globalAlpha = 0.95 * a;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  // 10) 스테이션 도트(정면 반구만). 흰 fill + 대륙색 ring.
  const rot = projection.rotate();
  const center: LngLat = [-rot[0], -rot[1]];
  for (const id of state.stations) {
    const a = index.anchor.get(id);
    if (!a || !isFrontFacing(a, center)) continue;
    const p = projection(a);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], STATION_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = palette.stationFill;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.continent[contOf(id)];
    ctx.stroke();
  }
}
