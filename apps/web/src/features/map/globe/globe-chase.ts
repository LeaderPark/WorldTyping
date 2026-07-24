// spec: docs/09-chase-mode-goldrunner.md §7.5(GlobeChaseHandle — globe-centric 개정판: 마커·추적선·
//       레이더 화살표·위협 앰비언스 + 콜아웃 지원 4메서드)·§7.6(연출 훅 — 마커 레벨 효과만, 전체
//       타임라인은 CH-07)·§8.3(레이더 링 +12px·z-순서 개정)·§8.5(콜아웃 배치 알고리즘 — 소비 계약
//       확인용)·§8.7(디자인 토큰 6종 — apps/web/src/styles/tokens.css·tailwind.config.ts 참조),
//       docs/09a §4(z-순서)·§5.2(배치 알고리즘), docs/00 §11-D67(canvas 재그리기 0)·D73(제트·트레일
//       시각 불변)·D90~D97(chase 채택), WT-CH-05.
//
// GlobeMap 코어(GlobeMap.tsx/globe-render.ts/globe-hop.ts)는 이 파일에서 **무수정**이다 — 전부
// 조합(핸들 래핑) + 형제 DOM 삽입으로 확장한다. 아래 3가지는 "코어 무수정 + 상시 rAF 신설 금지"
// 제약과 §7.5의 실시간 좌표 요구 사이에서 이 파일이 내린 설계 결정이다(§7.5/§8.5는 소비 계약만
// 규정하고 구현 방식은 "명명 재량" — 문서 미정의 세부이므로 §11 에스컬레이션 대상이 아니라고 판단해
// 진행했다. CH-02~04 병합 후 재검증 필요 접점으로 최종 보고에 기재):
//
// 1. **좌표계 미러링.** GlobeMapHandle은 코어의 현재 카메라 회전을 전혀 외부에 노출하지 않는다
//    (§3.2 계약 — projectionRef/cameraRef는 GlobeMap.tsx 클로저 전용). 코어가 카메라를 바꾸는 경로는
//    handle의 moveVehicle/flyTo/reset 세 메서드뿐이므로, 이 파일은 자체 geoOrthographic()을 두고
//    이 세 메서드를 래핑해 "코어에 그대로 전달(코어의 실제 동작·canvas 재그리기는 무변경) + 코어와
//    100% 동일한 수학(globe-hop.ts의 easeInOutCubic/hopDurationMs, d3-geo의 geoInterpolate — 코어가
//    쓰는 것과 동일 함수 재사용, 재구현 아님)으로 이 파일의 카메라도 동기 갱신"한다.
// 2. **"추가 rAF 루프 신설 금지"는 "상시/유휴 루프 금지"로 해석했다.** 정적 상태에서는 rAF를 전혀
//    돌리지 않고(핸들 호출은 1회성 DOM 갱신), 오직 moveVehicle이 만든 애니메이션 홉이 진행 중인
//    구간에만 코어와 정확히 같은 시간창(같은 from/to/duration)으로 bounded 루프를 돈다 — 이 구간은
//    코어도 이미 rAF를 돌리고 있는 구간과 100% 겹치므로 "새 상시 루프"가 아니라 "코어 rAF 활성
//    구간에 한정된 부수 계산"이다. 코어의 실제 프레임 콜백에 물리적으로 편승하는 것은 코어가 이를
//    노출하지 않는 한 불가능하다 — 이 재량은 최종 보고에 명시한다.
// 3. **표시 계층 타입(PoliceKind/PoliceView/GoldRing/GoldView)은 이 파일 소유.** CH-02(shared/chase)·
//    CH-04(engine/chase-session)가 이 세션 시점에 아직 병합되지 않아(§7.5 헤더 "명명 재량") 자체
//    정의한다. 두 태스크 병합 후 필드 정합 재검증이 필요하다(최종 보고 참조).
//
// 렌더 원칙(§7.5 "레이어 배치 원칙" — D67 성능 계약 유지가 최우선): 마커·추적선·레이더 화살표·
// 프리하이라이트 전부 SVG 오버레이 + CSS @keyframes만 사용한다 — canvas는 이 파일에서 **한 번도**
// 건드리지 않는다. 이 파일이 만드는 <svg class="wt-chase__overlay">는 GlobeMap이 렌더한 canvas+svg의
// **형제 노드**로 컨테이너 마지막 자식에 추가되며(코어 마크업 무수정), 동일 viewBox(0 0 960 500)·
// preserveAspectRatio="xMidYMid meet"로 완전히 겹친다. z-순서(§8.3·09a §4: 지구본 canvas < 추적선/
// 마커 < 리더 라인 < 콜아웃 칩 < 플로팅 텍스트 < HUD)는 DOM 삽입 순서로 성립한다(GlobeMap core →
// 이 오버레이 → CH-06 콜아웃 레이어 순으로 마운트되어야 함 — 명시적 z-index 불요, 기존
// .wt-globe__canvas/.wt-globe__overlay와 동일 관례).
import {
  geoCentroid,
  geoDistance,
  geoInterpolate,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import type { CountryId } from '@wt/shared';
import type { FlyToOptions, JuiceLevel, MoveVehicleOptions } from '../map-handle';
import type { GlobeMapHandle } from './GlobeMap';
import type { GlobeIndex } from './globe-index';
import { easeInOutCubic, hopDurationMs, isFrontFacing, sampleArc, type LngLat } from './globe-hop';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** GlobeMap.tsx의 LOGICAL_W/H·INITIAL_CENTER와 동일(코어가 export하지 않아 값만 복제 — 순수 치수
 * 상수이며 로직이 아니다. 코어와 값이 어긋나면 이 파일의 미러 좌표계가 어긋난다는 점만 유의). */
const LOGICAL_W = 960;
const LOGICAL_H = 500;
const INITIAL_CENTER: LngLat = [20, 20];
/** 레이더 에지 화살표 — 지구본 원판 반경 + 12px(§8.3). */
const RADAR_OFFSET = 12;
/** 후보국 앵커 도트 반경(§7.5 "4px"). */
const CANDIDATE_ANCHOR_R = 4;
/** 추적선 great-circle 샘플 점 수(경찰-플레이어 짧은 아크라 노선 원장의 64보다 적어도 충분). */
const TRAIL_ARC_SAMPLES = 48;

/** 경찰 유닛 3종(docs/09 §3.4) — 표시 계층 타입(설계 결정 3, 파일 헤더 참조). */
export type PoliceKind = 'chaser' | 'interceptor' | 'heli';
/** 경찰 유닛 뷰(§7.5 upsertPoliceMarker). id로 upsert/remove를 식별한다. */
export interface PoliceView {
  id: number;
  kind: PoliceKind;
  at: CountryId;
}
/** 금 스폰 거리 링(docs/09 §3.5) — 표시 계층 타입. */
export type GoldRing = 'near' | 'mid' | 'far';
/** 금 마커 뷰(§7.5 setGoldMarkers). at(국가)로 식별 — 동일국 중복 스폰은 게임 규칙상 발생하지 않는다. */
export interface GoldView {
  at: CountryId;
  ring: GoldRing;
}

/**
 * docs/09 §7.5 전문(globe-centric 개정판) — GlobeMap 코어 위에 조합되는 chase 전용 확장 핸들.
 * playPickup/playDelivery/playArrest는 "훅 시그니처 + 마커 레벨 효과만" 제공한다(§7.6 전체 타임라인은
 * CH-07 소관 — sequences.ts가 이 메서드들을 호출하며 추가로 HUD 플로팅/사운드를 얹는다).
 */
export interface GlobeChaseHandle extends GlobeMapHandle {
  /** 홈 국가 지정 — 금색 비컨(SVG 오버레이 링 2겹 펄스 2.4s). */
  setHome(id: CountryId): void;
  /** 경찰 유닛 추가/갱신(id로 upsert). 위치 변경은 마커 속성 변경 + CSS transition뿐(§7.5 좌표 갱신
   *  규약 — 경찰 틱은 canvas·rAF 무관, 홉/스핀 중에만 아래 미러 카메라가 재투영한다). */
  upsertPoliceMarker(u: PoliceView): void;
  removePoliceMarker(id: number): void;
  /** 금 마커 전체 치환(획득/재스폰마다 호출, §3.5 "동시 4개 유지"). */
  setGoldMarkers(golds: readonly GoldView[]): void;
  /** 비행기 후미 금 가방 배지(×n) — D73 제트 실루엣 자체는 무변경, 배지만 이 파일이 부착. */
  setCarriedCount(n: number): void;
  /** 마커 레벨 효과(§7.6) — 국가 폴리곤 위 1회성 팝. 전체 타임라인은 CH-07. */
  playPickup(at: CountryId): void;
  playDelivery(payout: number, count: number): void;
  playArrest(at: CountryId, by: PoliceKind): void;
  /** 위협 앰비언스(§7.5) — 비네트 α = clamp(0.04×★+(nearestHops≤2?0.08:0), 0, 0.28). */
  setThreatLevel(stars: number, nearestHops: number): void;
  /** 하트비트 사운드 콜백 주입 인터페이스(§7.5 setThreatLevel 지시 — docs/09 §7.5 표에는 없는 순수
   *  추가 메서드, 기존 메서드 제거·변경 없음). setThreatLevel 호출마다 발화 — 사운드 구현은 CH-07,
   *  이 파일은 사운드 무접점(Gotcha 3 무관 영역). */
  onThreatLevelChange(cb: (stars: number, nearestHops: number) => void): () => void;
  // ── 콜아웃 지원(globe-centric 개정, §7.5 "콜아웃 분업") — CH-06 CandidateCallouts의 유일한
  //    지구본 접점. 칩·리더 라인 DOM 자체는 CH-06 소유(이 파일은 앵커 좌표·후보 도트·프리하이라이트·
  //    홉 라이프사이클 훅만 제공). ──
  /** 후보국 앵커의 현재 오버레이 좌표(viewBox 960×500 기준). 후보는 항상 플레이어 인접국 + 카메라는
   *  플레이어 중심이라(§8.5) 뒷면 케이스는 구조적으로 없다 — 방어적으로 앵커 부재/뒷면이어도 좌표를
   *  반환한다(문서 시그니처가 non-nullable). */
  projectAnchor(id: CountryId): { x: number; y: number };
  /** 회전(홉) 시작·착지 알림 — CH-06이 회전 중 고스트(opacity 0.3) → 착지 후 1회 재배치에 사용
   *  (§8.5 배치 알고리즘-5). from===to 스냅·immediate(reduced-motion/juice 강등)에서는 start 직후
   *  동기적으로 land가 따라온다(회전이 없으므로). */
  onHopLifecycle(cb: (phase: 'start' | 'land') => void): () => void;
  /** 후보국 도트 4px(리더 라인 시작점) — 매 홉 착지 후 CH-06이 새 후보 3개로 호출. */
  setCandidateAnchors(ids: readonly CountryId[]): void;
  /** matching 폴리곤 금색 프리하이라이트(SVG 오버레이 — canvas 재그리기 0 유지). null이면 해제. */
  setCandidatePrehighlight(id: CountryId | null): void;
}

export interface GlobeChaseDeps {
  /** GlobeMap onReady로 전달받은 코어 핸들 — 이 파일은 전량 이 핸들을 통해서만 코어와 통신한다. */
  core: GlobeMapHandle;
  /** GlobeMap이 마운트된 컨테이너(코어의 canvas+svg를 담은 부모 DOM). 이 함수가 형제 <svg>+비네트
   *  <div>를 마지막 자식으로 추가한다(코어 마크업 무수정 — 추가 삽입만). */
  container: HTMLElement;
  /** 앵커(경도/위도)·폴리곤 feature 조회 — GlobeMap과 동일 원천(useGlobeIndex/getGlobeIndex). */
  index: GlobeIndex;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
/** GlobeMap.tsx의 동명 헬퍼와 동일 구현(사소한 media-query 유틸 — 재구현 아님, 코어가 export하지
 * 않아 값만 복제). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface PoliceMarkerEntry {
  el: SVGGElement;
  view: PoliceView;
}
interface GoldMarkerEntry {
  el: SVGCircleElement;
  view: GoldView;
}

/**
 * docs/09 §7.5 GlobeChaseHandle을 구성한다. GlobeMap 코어는 무수정 — core 핸들을 래핑하고 컨테이너에
 * 형제 오버레이를 추가하는 조합만으로 확장한다(파일 헤더 설계 결정 1~3 참조).
 */
export function createGlobeChaseHandle(deps: GlobeChaseDeps): GlobeChaseHandle {
  const { core, container, index } = deps;

  // 재호출 안전성(테스트/재마운트 대비) — 이전 오버레이가 남아 있으면 제거 후 재구성.
  container.querySelectorAll('.wt-chase__overlay, .wt-chase__vignette').forEach((el) => el.remove());

  // ── 미러 좌표계(설계 결정 1) ────────────────────────────────────────────
  const projection = geoOrthographic();
  projection.fitSize([LOGICAL_W, LOGICAL_H], { type: 'Sphere' } as never);
  let camera: { lng: number; lat: number } = { lng: INITIAL_CENTER[0], lat: INITIAL_CENTER[1] };
  projection.rotate([-camera.lng, -camera.lat]);
  const pathGen = geoPath(projection);
  const center = (): [number, number] => {
    const t = projection.translate();
    return [t[0], t[1]];
  };

  let juice: JuiceLevel = 0;

  // ── DOM: 형제 오버레이(코어 마크업 무수정) ──────────────────────────────
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wt-chase__overlay');
  svg.setAttribute('viewBox', `0 0 ${LOGICAL_W} ${LOGICAL_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-juice', '0');

  const gPrehighlight = document.createElementNS(SVG_NS, 'g');
  gPrehighlight.setAttribute('data-layer', 'chase-prehighlight');
  const gTrails = document.createElementNS(SVG_NS, 'g');
  gTrails.setAttribute('data-layer', 'chase-trails');
  const gRadar = document.createElementNS(SVG_NS, 'g');
  gRadar.setAttribute('data-layer', 'chase-radar');
  const gHome = document.createElementNS(SVG_NS, 'g');
  gHome.setAttribute('data-layer', 'chase-home');
  gHome.style.display = 'none';
  const gGold = document.createElementNS(SVG_NS, 'g');
  gGold.setAttribute('data-layer', 'chase-gold');
  const gPolice = document.createElementNS(SVG_NS, 'g');
  gPolice.setAttribute('data-layer', 'chase-police');
  const gCandidates = document.createElementNS(SVG_NS, 'g');
  gCandidates.setAttribute('data-layer', 'chase-candidates');
  const gPop = document.createElementNS(SVG_NS, 'g');
  gPop.setAttribute('data-layer', 'chase-pop');
  // z-순서(§8.3 개정 — DOM 삽입 순서로 성립): 프리하이라이트(폴리곤) < 추적선 < 레이더 화살표 < 홈 <
  // 금 < 경찰(위협 정보 > 후보 정보, §8.5) < 후보 앵커 도트 < 팝 이펙트/가방 배지.
  svg.append(gPrehighlight, gTrails, gRadar, gHome, gGold, gPolice, gCandidates, gPop);

  const vignette = document.createElement('div');
  vignette.setAttribute('class', 'wt-chase__vignette');
  vignette.setAttribute('aria-hidden', 'true');
  vignette.style.setProperty('--chase-vignette-alpha', '0');

  container.append(svg, vignette);

  // ── 상태 ──────────────────────────────────────────────────────────────────
  let homeId: CountryId | null = null;
  const policeMarkers = new Map<number, PoliceMarkerEntry>();
  const goldMarkers = new Map<CountryId, GoldMarkerEntry>();
  const candidateAnchors = new Map<CountryId, SVGCircleElement>();
  const radarArrows = new Map<string, SVGGElement>();
  let carriedBadge: SVGGElement | null = null;
  let carriedCount = 0;

  let mirrorHop: { interp: (t: number) => [number, number]; start: number; duration: number } | null =
    null;
  let mirrorRaf: number | null = null;
  const hopCbs = new Set<(phase: 'start' | 'land') => void>();
  const threatCbs = new Set<(stars: number, nearestHops: number) => void>();

  function fireHop(phase: 'start' | 'land'): void {
    for (const cb of hopCbs) cb(phase);
  }
  function cancelMirrorRaf(): void {
    if (mirrorRaf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(mirrorRaf);
    mirrorRaf = null;
  }
  /** GlobeMap core의 immediate() 판정과 동일 경계(설계 결정 2) — juice>0(코드 스케일: 0=풀/1=강등,
   * docs/09 §7 헤더의 "level 2/1/0" 3단 서술은 이 앱의 실제 0/1 이진 강등에 매핑했다, tokens.css
   * 주석 참조) 또는 reduced-motion 또는 rAF 미지원이면 전부 즉시 스냅. */
  function immediate(): boolean {
    return juice > 0 || prefersReducedMotion() || typeof requestAnimationFrame !== 'function';
  }

  // ── 투영 ────────────────────────────────────────────────────────────────
  function project(id: CountryId): { p: [number, number]; front: boolean } | null {
    const a = index.anchor.get(id);
    if (!a) return null;
    const front = isFrontFacing(a, [camera.lng, camera.lat]);
    const p = projection(a);
    if (!p) return null;
    return { p: [p[0], p[1]], front };
  }

  function radarEdgePoint(p: [number, number]): { x: number; y: number; angle: number } {
    const c = center();
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const rr = projection.scale() + RADAR_OFFSET;
    return { x: c[0] + ux * rr, y: c[1] + uy * rr, angle: (Math.atan2(uy, ux) * 180) / Math.PI };
  }

  /** 뒷면/화면 밖 대상의 레이더 화살표 upsert. angularDist(라디안, isFrontFacing과 동일 척도)로
   * 크기 8→12px·불투명도 보간(§8.9) — "홉 수" 대신 각거리를 근접도 대체 신호로 쓴다(이 표시 계층은
   * chase-graph/BFS 홉 거리에 접근할 수 없다 — CH-01/02 소관 데이터라 이 파일이 그래프 의존을 지는
   * 대신 자기완결적 근사를 택했다, 최종 보고 기재). 가까울수록(호라이즌 바로 뒤) 크고 진하게. */
  function upsertRadarArrow(key: string, kindClass: string, lngLat: LngLat, angularDist: number): void {
    const proj = projection(lngLat);
    if (!proj) return;
    const edge = radarEdgePoint([proj[0], proj[1]]);
    let g = radarArrows.get(key);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `wt-chase__radar-arrow ${kindClass}`);
      g.setAttribute('data-radar-key', key);
      const shape = document.createElementNS(SVG_NS, 'path');
      shape.setAttribute('class', 'wt-chase__radar-arrow-shape');
      shape.setAttribute('d', 'M0 -5 L4 4 L-4 4 Z');
      g.appendChild(shape);
      radarArrows.set(key, g);
      gRadar.appendChild(g);
    }
    const t = clamp01(1 - (angularDist - Math.PI / 2) / (Math.PI / 2));
    const scale = 0.8 + t * 0.4; // 삼각형 기저 10px 기준 8→12px 근사
    const opacity = 0.5 + t * 0.5;
    g.setAttribute(
      'transform',
      `translate(${round(edge.x)} ${round(edge.y)}) rotate(${round(edge.angle + 90)}) scale(${round(scale)})`,
    );
    g.style.opacity = String(round(opacity));
    g.style.display = '';
  }
  function removeRadarArrow(key: string): void {
    const g = radarArrows.get(key);
    if (!g) return;
    g.remove();
    radarArrows.delete(key);
  }

  function reprojectHome(): void {
    if (!homeId) return;
    const r = project(homeId);
    if (!r) return;
    if (r.front) {
      gHome.style.display = '';
      gHome.setAttribute('transform', `translate(${round(r.p[0])} ${round(r.p[1])})`);
      removeRadarArrow('home');
    } else {
      gHome.style.display = 'none';
      const a = index.anchor.get(homeId);
      if (a) upsertRadarArrow('home', 'wt-chase__radar-arrow--home', a, geoDistance(a, [camera.lng, camera.lat]));
    }
  }

  function reprojectPolice(): void {
    for (const [id, entry] of policeMarkers) {
      const r = project(entry.view.at);
      if (!r) continue;
      if (r.front) {
        entry.el.style.display = '';
        entry.el.setAttribute('transform', `translate(${round(r.p[0])} ${round(r.p[1])})`);
        removeRadarArrow(`police:${id}`);
      } else {
        entry.el.style.display = 'none';
        const a = index.anchor.get(entry.view.at);
        if (a) {
          upsertRadarArrow(
            `police:${id}`,
            'wt-chase__radar-arrow--police',
            a,
            geoDistance(a, [camera.lng, camera.lat]),
          );
        }
      }
    }
  }

  function reprojectGold(): void {
    for (const [countryId, entry] of goldMarkers) {
      const r = project(countryId);
      if (!r) continue;
      if (r.front) {
        entry.el.style.display = '';
        entry.el.setAttribute('cx', String(round(r.p[0])));
        entry.el.setAttribute('cy', String(round(r.p[1])));
        removeRadarArrow(`gold:${countryId}`);
      } else {
        entry.el.style.display = 'none';
        const a = index.anchor.get(countryId);
        if (a) {
          upsertRadarArrow(
            `gold:${countryId}`,
            'wt-chase__radar-arrow--gold',
            a,
            geoDistance(a, [camera.lng, camera.lat]),
          );
        }
      }
    }
  }

  /** 경찰 추적선(§7.5) — great-circle 점선, juice 풀(코드 juice===0) + 비-reduced-motion에서만
   * 그린다(§11 "저사양(juice 1↓): 추적선 off"). 매 호출 전량 재구성(개수가 적어 비용 무시 가능). */
  function reprojectTrails(): void {
    gTrails.replaceChildren();
    if (immediate()) return;
    const playerLngLat: LngLat = [camera.lng, camera.lat];
    for (const { view } of policeMarkers.values()) {
      const a = index.anchor.get(view.at);
      if (!a || !isFrontFacing(a, playerLngLat)) continue; // 뒷면 자동 클립(§7.5)
      const arc = sampleArc(a, playerLngLat, TRAIL_ARC_SAMPLES);
      const d = pathGen({ type: 'LineString', coordinates: arc } as never);
      if (!d) continue;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'wt-chase__trail');
      path.setAttribute('d', d);
      gTrails.appendChild(path);
    }
  }

  function reprojectCarriedBadge(): void {
    if (!carriedBadge) return;
    const c = center();
    // 비행기는 항상 카메라 중심에 렌더된다(코어 — 카메라가 플레이어를 추적하므로 projection(camera)
    // 는 projection.translate()와 일치). 배지는 우하단 고정 오프셋으로 부착 — 코어 plane의 heading은
    // 핸들에 노출되지 않아 정밀 추종은 불가(알려진 단순화, 최종 보고 기재).
    carriedBadge.setAttribute('transform', `translate(${round(c[0] + 14)} ${round(c[1] + 10)})`);
    carriedBadge.style.display = carriedCount > 0 ? '' : 'none';
  }

  function reprojectAll(): void {
    reprojectHome();
    reprojectPolice();
    reprojectGold();
    reprojectTrails();
    reprojectCarriedBadge();
  }

  function applyCamera(): void {
    projection.rotate([-camera.lng, -camera.lat]);
    reprojectAll();
  }

  // ── 홉 카메라 미러(설계 결정 2) ─────────────────────────────────────────
  function mirrorFrame(now: number): void {
    mirrorRaf = null;
    const h = mirrorHop;
    if (!h) return;
    const raw = h.duration > 0 ? clamp01((now - h.start) / h.duration) : 1;
    const t = easeInOutCubic(raw);
    const pos = h.interp(t);
    camera = { lng: pos[0], lat: pos[1] };
    applyCamera();
    if (raw >= 1) {
      mirrorHop = null;
      fireHop('land');
      return;
    }
    mirrorRaf = requestAnimationFrame(mirrorFrame);
  }
  function snapCameraTo(lngLat: LngLat): void {
    cancelMirrorRaf();
    mirrorHop = null;
    camera = { lng: lngLat[0], lat: lngLat[1] };
    applyCamera();
  }
  function beginMirrorHop(from: LngLat, to: LngLat, durationMs: number): void {
    mirrorHop = { interp: geoInterpolate(from, to), start: nowMs(), duration: durationMs };
    cancelMirrorRaf();
    mirrorRaf = requestAnimationFrame(mirrorFrame);
  }

  // ── 코어 위임 + 카메라 미러링 개입(moveVehicle/flyTo/reset만, 나머지는 그대로 전달) ──────
  function wrappedMoveVehicle(from: CountryId, to: CountryId, opts?: MoveVehicleOptions): void {
    core.moveVehicle(from, to, opts);
    const b = index.anchor.get(to);
    if (!b) return;
    const target: LngLat = [b[0], b[1]];
    if (from === to || immediate()) {
      fireHop('start');
      snapCameraTo(target);
      fireHop('land');
      return;
    }
    const a = index.anchor.get(from);
    const startPos: LngLat = mirrorHop ? [camera.lng, camera.lat] : a ? [a[0], a[1]] : target;
    const duration = opts?.durationMs ?? hopDurationMs(startPos, target);
    fireHop('start');
    beginMirrorHop(startPos, target, duration);
  }

  function wrappedFlyTo(ids: CountryId[], opts?: FlyToOptions): void {
    core.flyTo(ids, opts);
    // chase는 flyTo를 쓰지 않는다(docs/09 무언급) — 호출되더라도(카메라) 정밀 미러 대신 스냅 근사만
    // 수행한다(알려진 단순화, 최종 보고 기재).
    const pts = ids.map((id) => index.anchor.get(id)).filter((a): a is [number, number] => Boolean(a));
    const first = pts[0];
    if (!first) return;
    const target: LngLat =
      pts.length === 1
        ? [first[0], first[1]]
        : (geoCentroid({ type: 'MultiPoint', coordinates: pts } as never) as LngLat);
    snapCameraTo(target);
  }

  function wrappedReset(): void {
    core.reset();
    cancelMirrorRaf();
    mirrorHop = null;
    camera = { lng: INITIAL_CENTER[0], lat: INITIAL_CENTER[1] };
    projection.rotate([-camera.lng, -camera.lat]);
    homeId = null;
    for (const { el } of policeMarkers.values()) el.remove();
    policeMarkers.clear();
    for (const { el } of goldMarkers.values()) el.remove();
    goldMarkers.clear();
    for (const el of candidateAnchors.values()) el.remove();
    candidateAnchors.clear();
    for (const el of radarArrows.values()) el.remove();
    radarArrows.clear();
    gHome.replaceChildren();
    gHome.style.display = 'none';
    gPrehighlight.replaceChildren();
    gTrails.replaceChildren();
    gPop.replaceChildren();
    carriedBadge = null;
    carriedCount = 0;
    vignette.style.setProperty('--chase-vignette-alpha', '0');
  }

  function wrappedSetJuiceLevel(level: JuiceLevel): void {
    core.setJuiceLevel(level);
    juice = level;
    svg.setAttribute('data-juice', String(level));
    reprojectTrails(); // juice 변경 즉시 추적선 표시/은닉 반영(강등 표, §11).
  }

  // ── chase 전용 메서드 ───────────────────────────────────────────────────
  function setHome(id: CountryId): void {
    homeId = id;
    if (gHome.childElementCount === 0) {
      const inner = document.createElementNS(SVG_NS, 'circle');
      inner.setAttribute('class', 'wt-chase__home-ring');
      inner.setAttribute('r', '10');
      const outer = document.createElementNS(SVG_NS, 'circle');
      outer.setAttribute('class', 'wt-chase__home-ring wt-chase__home-ring--outer');
      outer.setAttribute('r', '10');
      gHome.append(inner, outer);
    }
    reprojectHome();
  }

  function policeShape(kind: PoliceKind): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `wt-chase__police wt-chase__police--${kind}`);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'wt-chase__police-dot');
    dot.setAttribute('r', '4'); // 8px 도트(§7.5)
    g.appendChild(dot);
    if (kind === 'chaser') {
      // 적청 교대 점멸(CSS 애니메이션, wt-chase-chaser-blink) + 바깥 확산 링.
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('class', 'wt-chase__police-ring');
      ring.setAttribute('r', '4');
      g.appendChild(ring);
    } else if (kind === 'interceptor') {
      // 청색 단독 + 방패 아이콘(단순 방패 실루엣).
      const shield = document.createElementNS(SVG_NS, 'path');
      shield.setAttribute('class', 'wt-chase__police-dot');
      shield.setAttribute('d', 'M0 -6 L5 -3 V2 Q0 8 0 8 Q0 8 -5 2 V-3 Z');
      shield.setAttribute('transform', 'translate(0 -9)');
      g.appendChild(shield);
    } else {
      // 헬기: 회전 로터(CSS rotate 0.5s linear infinite) + 서치라이트 콘(opacity 0.12).
      const cone = document.createElementNS(SVG_NS, 'path');
      cone.setAttribute('class', 'wt-chase__police-cone');
      cone.setAttribute('d', 'M0 0 L-6 14 L6 14 Z');
      const rotor = document.createElementNS(SVG_NS, 'line');
      rotor.setAttribute('class', 'wt-chase__police-rotor');
      rotor.setAttribute('x1', '-8');
      rotor.setAttribute('y1', '0');
      rotor.setAttribute('x2', '8');
      rotor.setAttribute('y2', '0');
      g.append(cone, rotor);
    }
    return g;
  }

  function upsertPoliceMarker(u: PoliceView): void {
    let entry = policeMarkers.get(u.id);
    if (!entry) {
      const el = policeShape(u.kind);
      el.setAttribute('data-police-id', String(u.id));
      gPolice.appendChild(el);
      entry = { el, view: u };
      policeMarkers.set(u.id, entry);
    } else {
      if (entry.view.kind !== u.kind) {
        const el = policeShape(u.kind);
        el.setAttribute('data-police-id', String(u.id));
        entry.el.replaceWith(el);
        entry.el = el;
      }
      entry.view = u;
    }
    reprojectPolice();
    reprojectTrails();
  }

  function removePoliceMarker(id: number): void {
    const entry = policeMarkers.get(id);
    if (!entry) return;
    entry.el.remove();
    policeMarkers.delete(id);
    removeRadarArrow(`police:${id}`);
    reprojectTrails();
  }

  function setGoldMarkers(golds: readonly GoldView[]): void {
    const keep = new Set(golds.map((g) => g.at));
    for (const [at, entry] of goldMarkers) {
      if (!keep.has(at)) {
        entry.el.remove();
        goldMarkers.delete(at);
        removeRadarArrow(`gold:${at}`);
      }
    }
    for (const g of golds) {
      const entry = goldMarkers.get(g.at);
      if (!entry) {
        const el = document.createElementNS(SVG_NS, 'circle');
        el.setAttribute('class', 'wt-chase__gold');
        el.setAttribute('r', '5');
        el.setAttribute('data-gold-ring', g.ring);
        gGold.appendChild(el);
        goldMarkers.set(g.at, { el, view: g });
      } else {
        entry.el.setAttribute('data-gold-ring', g.ring);
        entry.view = g;
      }
    }
    reprojectGold();
  }

  function setCarriedCount(n: number): void {
    carriedCount = n;
    if (!carriedBadge) {
      carriedBadge = document.createElementNS(SVG_NS, 'g');
      carriedBadge.setAttribute('class', 'wt-chase__carried-badge');
      carriedBadge.setAttribute('data-layer', 'chase-carried');
      const bg = document.createElementNS(SVG_NS, 'circle');
      bg.setAttribute('class', 'wt-chase__carried-bg');
      bg.setAttribute('r', '7');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'wt-chase__carried-text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', '3');
      carriedBadge.append(bg, text);
      gPop.appendChild(carriedBadge);
    }
    const text = carriedBadge.querySelector('text');
    if (text) text.textContent = `×${n}`;
    reprojectCarriedBadge();
  }

  /** 마커 레벨 1회성 팝(§7.6 "타임라인 본체는 CH-07 — 여기서는 훅 시그니처와 마커 레벨 효과만").
   * dataAttrs는 CH-07/테스트가 이벤트 상세를 조회할 수 있게 이펙트 노드에 그대로 반영한다(값 자체를
   * 소비하는 로직은 CH-07 소관 — 여기서는 전달만). */
  function popEffect(at: CountryId, colorVar: string, dataAttrs?: Record<string, string>): void {
    const r = project(at);
    if (!r || !r.front || immediate()) return;
    const el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('class', 'wt-chase__pop');
    el.setAttribute('r', '6');
    el.setAttribute('fill', colorVar);
    el.setAttribute('cx', String(round(r.p[0])));
    el.setAttribute('cy', String(round(r.p[1])));
    if (dataAttrs) {
      for (const [k, v] of Object.entries(dataAttrs)) el.setAttribute(`data-${k}`, v);
    }
    if (typeof el.animate !== 'function') return;
    gPop.appendChild(el);
    const anim = el.animate(
      [
        { transform: 'scale(0.5)', opacity: 0.9 },
        { transform: 'scale(2.2)', opacity: 0 },
      ],
      { duration: 500, easing: 'ease-out', fill: 'none' },
    );
    const cleanup = (): void => {
      if (el.parentNode === gPop) gPop.removeChild(el);
    };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  }

  function playPickup(at: CountryId): void {
    popEffect(at, 'var(--chase-gold)', { event: 'pickup' });
  }

  function playDelivery(payout: number, count: number): void {
    if (immediate() || !homeId) return;
    const rings = gHome.querySelectorAll<SVGCircleElement>('.wt-chase__home-ring');
    rings.forEach((ring) => {
      if (typeof ring.animate !== 'function') return;
      ring.animate(
        [
          { transform: 'scale(0.5)', opacity: 1 },
          { transform: 'scale(3)', opacity: 0 },
        ],
        { duration: 400, easing: 'ease-out', fill: 'none' },
      );
    });
    popEffect(homeId, 'var(--chase-gold)', {
      event: 'delivery',
      payout: String(payout),
      count: String(count),
    });
  }

  function playArrest(at: CountryId, by: PoliceKind): void {
    popEffect(at, 'var(--chase-siren-red)', { event: 'arrest', by });
  }

  function setThreatLevel(stars: number, nearestHops: number): void {
    const alpha = clamp01(Math.min(0.28, 0.04 * stars + (nearestHops <= 2 ? 0.08 : 0)));
    vignette.style.setProperty('--chase-vignette-alpha', String(round(alpha)));
    for (const cb of threatCbs) cb(stars, nearestHops);
  }

  function onThreatLevelChange(cb: (stars: number, nearestHops: number) => void): () => void {
    threatCbs.add(cb);
    return () => threatCbs.delete(cb);
  }

  function projectAnchor(id: CountryId): { x: number; y: number } {
    const r = project(id);
    if (!r) {
      const c = center();
      return { x: round(c[0]), y: round(c[1]) };
    }
    return { x: round(r.p[0]), y: round(r.p[1]) };
  }

  function onHopLifecycle(cb: (phase: 'start' | 'land') => void): () => void {
    hopCbs.add(cb);
    return () => hopCbs.delete(cb);
  }

  function setCandidateAnchors(ids: readonly CountryId[]): void {
    const keep = new Set(ids);
    for (const [id, el] of candidateAnchors) {
      if (!keep.has(id)) {
        el.remove();
        candidateAnchors.delete(id);
      }
    }
    for (const id of ids) {
      const r = project(id);
      if (!r) continue;
      let el = candidateAnchors.get(id);
      if (!el) {
        el = document.createElementNS(SVG_NS, 'circle');
        el.setAttribute('class', 'wt-chase__candidate-anchor');
        el.setAttribute('r', String(CANDIDATE_ANCHOR_R));
        el.setAttribute('data-candidate-anchor', id);
        gCandidates.appendChild(el);
        candidateAnchors.set(id, el);
      }
      el.setAttribute('cx', String(round(r.p[0])));
      el.setAttribute('cy', String(round(r.p[1])));
    }
  }

  function setCandidatePrehighlight(id: CountryId | null): void {
    gPrehighlight.replaceChildren();
    if (!id) return;
    const feature = index.featureByCountry.get(id);
    if (!feature) return;
    const d = pathGen(feature as never);
    if (!d) return;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'wt-chase__prehighlight');
    path.setAttribute('d', d);
    path.setAttribute('data-country', id);
    gPrehighlight.appendChild(path);
  }

  const handle: GlobeChaseHandle = {
    // WorldMapHandle/GlobeMapHandle 그대로 위임(카메라 비접점 메서드 — canvas 재그리기는 코어 소관,
    // 이 파일은 절대 canvas를 건드리지 않는다).
    setTarget: (id) => core.setTarget(id),
    markSolved: (id, colorVar) => core.markSolved(id, colorVar),
    markSkipped: (id) => core.markSkipped(id),
    drawRouteSegment: (from, to) => core.drawRouteSegment(from, to),
    setVehicleVisible: (visible) => core.setVehicleVisible(visible),
    setWaypointLabels: (labels) => core.setWaypointLabels(labels),
    pulseCheckpointRing: (id) => core.pulseCheckpointRing(id),
    setIdleSpin: (on) => core.setIdleSpin(on),
    // 카메라 접점 — 미러링 개입(설계 결정 1).
    moveVehicle: wrappedMoveVehicle,
    flyTo: wrappedFlyTo,
    reset: wrappedReset,
    setJuiceLevel: wrappedSetJuiceLevel,
    // chase 전용.
    setHome,
    upsertPoliceMarker,
    removePoliceMarker,
    setGoldMarkers,
    setCarriedCount,
    playPickup,
    playDelivery,
    playArrest,
    setThreatLevel,
    onThreatLevelChange,
    projectAnchor,
    onHopLifecycle,
    setCandidateAnchors,
    setCandidatePrehighlight,
  };

  return handle;
}
