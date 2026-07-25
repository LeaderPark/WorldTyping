// spec: docs/01 §8.2(레이스 중 UX — 상대 진행 실시간 표시)·§10.2(S11), docs/03 §3.2(핸들 계약·
//       리렌더 0)·§3.6(juice 강등)·§3.7(지구본 여정 무대)·§4.5(고빈도 값 규약)·§7.3(reduced-motion),
//       docs/00 §11-D63(이동체)·D67(canvas 재그리기 0 — 정지 시 rAF 0)·D73(제트 실루엣 불변),
//       WT-RACE-GLOBE.
//
// 멀티 레이스용 "상대 비행기 N대" 오버레이. GlobeMap 코어(GlobeMap.tsx/globe-render.ts/globe-hop.ts)는
// 이 파일에서 **무수정**이다 — WT-CH-05(globe-chase.ts)가 확립한 "base 무접촉 additive 확장 핸들"
// 선례를 그대로 따른다: 코어 핸들을 래핑(조합)하고 컨테이너에 형제 <svg>를 추가하는 것 외에는
// 아무것도 하지 않는다. 내 비행기·노선·스테이션·타깃 링은 전부 코어(base vehicle)가 그대로 그리고,
// 이 파일은 그 위에 상대 기체만 얹는다.
//
// 설계 결정(globe-chase.ts 헤더의 1·2와 동일한 제약·동일한 해법 — 중복 서술 대신 요지만):
//  1. **좌표계 미러링.** 코어는 카메라 회전을 외부에 노출하지 않는다(projectionRef/cameraRef는
//     GlobeMap.tsx 클로저 전용). 코어 카메라가 바뀌는 경로는 handle의 moveVehicle/flyTo/reset뿐이므로
//     이 파일은 자체 geoOrthographic()을 두고 그 세 메서드를 래핑해 "코어에 그대로 위임 + 코어와
//     100% 동일한 수학(globe-hop의 easeInOutCubic/hopDurationMs/bearingDeg + d3-geo geoInterpolate —
//     재구현이 아니라 같은 함수 import)으로 미러 카메라도 동기 갱신"한다.
//  2. **rAF는 "상시 루프 신설 금지"로만 해석.** 정지 상태(홉 없음)에서는 프레임을 한 번도 돌리지
//     않는다. 오직 (a) 내 비행기 홉/flyTo가 진행 중이거나 (b) 상대 비행기 홉이 진행 중인 구간에만
//     bounded 루프를 돈다 — (a)는 코어가 이미 rAF를 도는 구간과 100% 겹치고, (b)는 250ms 코얼레싱된
//     progress-tick당 최대 ~0.9초짜리 유한 구간이다. 전부 끝나면 스스로 종료한다(D67 유지).
//  3. **idle spin은 미러 대상이 아니다**(레이스는 setIdleSpin을 켜지 않는다 — 켜면 코어 카메라만
//     돌아 이 오버레이 좌표가 어긋난다). setIdleSpin은 코어에 그대로 위임만 한다.
//
// 렌더 원칙: 상대 기체는 SVG 오버레이 + attribute 갱신만 사용한다 — 이 파일은 canvas를 **한 번도**
// 건드리지 않는다. 오버레이 <svg class="wt-race__overlay">는 컨테이너의 마지막 자식으로 추가되며
// 코어 canvas+svg와 동일 viewBox(0 0 960 500)·preserveAspectRatio="xMidYMid meet"로 완전히 겹친다.
// z-순서는 DOM 삽입 순서로 성립한다(코어 canvas < 코어 오버레이(내 비행기) < 이 오버레이).
import { geoCentroid, geoInterpolate, geoOrthographic } from 'd3-geo';
import type { CountryId } from '@wt/shared';
import type { FlyToOptions, JuiceLevel, MoveVehicleOptions } from '../map-handle';
import type { GlobeMapHandle } from './GlobeMap';
import type { GlobeIndex } from './globe-index';
import { bearingDeg, easeInOutCubic, hopDurationMs, isFrontFacing, type LngLat } from './globe-hop';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** GlobeMap.tsx의 LOGICAL_W/H·INITIAL_CENTER와 동일(코어가 export하지 않아 값만 복제 — 순수 치수
 *  상수이며 로직이 아니다. globe-chase.ts와 동일한 사유·동일한 값). */
const LOGICAL_W = 960;
const LOGICAL_H = 500;
const INITIAL_CENTER: LngLat = [20, 20];
/** 코어 flyTo 기본 지속(GlobeMap.tsx flyTo의 `opts?.durationMs ?? 1200`)과 동일 — 미러 정합용. */
const FLY_DEFAULT_MS = 1200;
/** 상대 기체 지상 스케일. 코어 내 비행기(지상 0.8·정점 1.65, D73)보다 항상 작게 유지해 시각 우선
 *  순위를 낮춘다(0.42 → 정점 0.72 < 0.8). globe-chase 마커가 코어 기체보다 작은 것과 동일 취지. */
const RIVAL_GROUND_SCALE = 0.42;
/** 상대 기체 lift 진폭(sin(π·raw) 가중) — 위 스케일과 합쳐 최대 0.72. */
const RIVAL_LIFT_SCALE = 0.3;
/** 진행 방향(heading) 샘플 전방 오프셋 — 코어 advance()의 `t + 0.02`와 동일. */
const HEADING_LOOKAHEAD = 0.02;
/** 참조 제트 실루엣(24×24, 노즈 (12,3)) — GlobeMap.tsx의 .wt-globe__plane path와 동일 문자열.
 *  순수 기하 상수(로직 아님)라 코어를 수정하지 않고 값만 복제한다(globe-chase의 치수 상수 복제와
 *  동일 사유). 정적 `rotate(90) translate(-12 -12)`로 원점 중심·노즈 +x 정렬 규약도 그대로 승계 —
 *  회전 각도는 코어와 같은 `bearing - 90` 규약이다(D73 시각 불변). */
const PLANE_PATH_D =
  'M21.5 15.5v-2l-8-5v-5.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5v5.5l-2 1.5v1.5l3.5-1 3.5 1V20l-2-1.5V13z';

/** 로스터 1행 — 상대 1명의 기체 식별자와 색. 색은 CSS 변수 문자열(`var(--grade-b)`) 또는 hex. */
export interface RacePlaneView {
  /** 플레이어 식별자(멀티 스토어 playerId) — upsert/remove 키. */
  id: string;
  /** 기체 fill 색. tokens.css 변수 참조를 권장한다(원색 하드코딩 금지 관례). */
  color: string;
}

/**
 * GlobeMap 코어 위에 조합되는 레이스 전용 확장 핸들. GlobeMapHandle 전 시그니처를 그대로 승계하므로
 * (내 비행기·노선·타깃 링은 코어 그대로) 호출부는 이 핸들 하나만 들고 싱글과 동일한 배선을 쓸 수 있다.
 */
export interface GlobeRaceHandle extends GlobeMapHandle {
  /** 상대 기체 로스터 치환(목록에 없는 기체는 제거, 있는 기체는 색만 갱신). 방 인원 변동당 1회. */
  setRoster(players: readonly RacePlaneView[]): void;
  /** 기체를 해당 국가에 즉시 배치(애니메이션 없음). 최초 배치·되감기·2칸 이상 점프의 앞 구간용. */
  snapPlane(id: string, at: CountryId): void;
  /**
   * from→to great-circle 홉(코어 moveVehicle과 동일 수학·동일 이징·동일 거리 가중 duration).
   * **진행 1칸당 1회만** 호출(상시 rAF 금지). 홉 중 재호출 시 현 보간 위치에서 리타깃한다.
   * from===to·reduced-motion·juice 강등·rAF 미지원이면 종점 스냅.
   */
  movePlane(id: string, from: CountryId, to: CountryId, opts?: MoveVehicleOptions): void;
  /** 기체 1대 제거(퇴장). */
  removePlane(id: string): void;
  /** 상대 기체 전부 제거 + 진행 중인 오버레이 프레임 해제(언마운트/리매치). 코어는 건드리지 않는다. */
  clearRace(): void;
}

export interface GlobeRaceDeps {
  /** GlobeMap onReady로 전달받은 코어 핸들 — 이 파일은 전량 이 핸들을 통해서만 코어와 통신한다. */
  core: GlobeMapHandle;
  /** GlobeMap이 마운트된 박스(코어 canvas+svg와 동일 치수). 이 함수가 형제 <svg>를 추가한다. */
  container: HTMLElement;
  /** 앵커(경도/위도) 조회 — GlobeMap과 동일 원천(useGlobeIndex/getGlobeIndex). */
  index: GlobeIndex;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
/** GlobeMap.tsx·globe-chase.ts의 동명 헬퍼와 동일 구현(코어가 export하지 않아 값만 복제). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface HopState {
  interp: (t: number) => [number, number];
  start: number;
  duration: number;
}

interface PlaneEntry {
  el: SVGGElement;
  color: string;
  /** 현재 위치(경도, 위도). null=아직 배치 전(숨김). */
  pos: LngLat | null;
  /** 화면 회전각(코어와 동일한 `bearing - 90` 규약). */
  heading: number;
  /** 홉 lift 게이지 0..1(sin(π·raw)) — 스케일에만 반영. */
  lift: number;
  hop: HopState | null;
}

/**
 * docs/03 §3.2 계약을 승계하는 레이스 확장 핸들을 구성한다. GlobeMap 코어는 무수정 — core 핸들을
 * 래핑하고 container에 형제 오버레이를 추가하는 조합만으로 확장한다(파일 헤더 설계 결정 1~3).
 */
export function createGlobeRaceHandle(deps: GlobeRaceDeps): GlobeRaceHandle {
  const { core, container, index } = deps;

  // 재호출 안전성(테스트/재마운트 대비) — 이전 오버레이가 남아 있으면 제거 후 재구성.
  container.querySelectorAll('.wt-race__overlay').forEach((el) => el.remove());

  // ── 미러 좌표계(설계 결정 1) ──────────────────────────────────────────────
  const projection = geoOrthographic();
  projection.fitSize([LOGICAL_W, LOGICAL_H], { type: 'Sphere' } as never);
  let camera: LngLat = [INITIAL_CENTER[0], INITIAL_CENTER[1]];
  projection.rotate([-camera[0], -camera[1]]);

  let juice: JuiceLevel = 0;

  // ── DOM: 형제 오버레이(코어 마크업 무수정) ────────────────────────────────
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wt-race__overlay');
  svg.setAttribute('viewBox', `0 0 ${LOGICAL_W} ${LOGICAL_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-juice', '0');
  const gPlanes = document.createElementNS(SVG_NS, 'g');
  gPlanes.setAttribute('data-layer', 'race-planes');
  svg.appendChild(gPlanes);
  container.appendChild(svg);

  // ── 상태 ──────────────────────────────────────────────────────────────────
  const planes = new Map<string, PlaneEntry>();
  /** 내 비행기(코어) 홉을 따라가는 미러 카메라 상태. null=정지. */
  let cameraHop: HopState | null = null;
  let raf: number | null = null;

  function immediate(): boolean {
    return juice > 0 || prefersReducedMotion() || typeof requestAnimationFrame !== 'function';
  }
  function cancelFrame(): void {
    if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = null;
  }
  function schedule(): void {
    if (raf == null && typeof requestAnimationFrame === 'function') {
      raf = requestAnimationFrame(frame);
    }
  }

  // ── 투영 ──────────────────────────────────────────────────────────────────
  function anchorOf(id: CountryId): LngLat | null {
    const a = index.anchor.get(id);
    return a ? [a[0], a[1]] : null;
  }

  function reprojectPlane(entry: PlaneEntry): void {
    const pos = entry.pos;
    if (!pos || !isFrontFacing(pos, camera)) {
      // 지구본 뒷면/미배치 — 오버레이는 orthographic 클립을 받지 않으므로 수동으로 숨긴다.
      entry.el.style.display = 'none';
      return;
    }
    const p = projection(pos);
    if (!p) {
      entry.el.style.display = 'none';
      return;
    }
    const scale = RIVAL_GROUND_SCALE + entry.lift * RIVAL_LIFT_SCALE;
    entry.el.style.display = '';
    entry.el.setAttribute(
      'transform',
      `translate(${round(p[0])} ${round(p[1])}) rotate(${round(entry.heading)}) scale(${round(scale)})`,
    );
  }

  function reprojectAll(): void {
    for (const entry of planes.values()) reprojectPlane(entry);
  }

  function applyCamera(): void {
    projection.rotate([-camera[0], -camera[1]]);
    reprojectAll();
  }

  // ── bounded rAF(설계 결정 2) ──────────────────────────────────────────────
  function frame(): void {
    raf = null;
    const now = nowMs();
    let active = false;

    if (cameraHop) {
      const raw = cameraHop.duration > 0 ? clamp01((now - cameraHop.start) / cameraHop.duration) : 1;
      const pos = cameraHop.interp(easeInOutCubic(raw));
      camera = [pos[0], pos[1]];
      if (raw >= 1) cameraHop = null;
      else active = true;
    }

    for (const entry of planes.values()) {
      const hop = entry.hop;
      if (!hop) continue;
      const raw = hop.duration > 0 ? clamp01((now - hop.start) / hop.duration) : 1;
      const t = easeInOutCubic(raw);
      const pos = hop.interp(t);
      const ahead = hop.interp(Math.min(1, t + HEADING_LOOKAHEAD));
      entry.pos = [pos[0], pos[1]];
      entry.heading = bearingDeg([pos[0], pos[1]], [ahead[0], ahead[1]]) - 90;
      entry.lift = Math.sin(Math.PI * raw);
      if (raw >= 1) {
        entry.hop = null;
        entry.lift = 0;
      } else {
        active = true;
      }
    }

    applyCamera();
    if (active) schedule();
  }

  function snapCamera(to: LngLat): void {
    cameraHop = null;
    camera = [to[0], to[1]];
    applyCamera();
  }

  // ── 코어 위임 + 카메라 미러 개입(moveVehicle/flyTo/reset/setJuiceLevel만) ──
  function wrappedMoveVehicle(from: CountryId, to: CountryId, opts?: MoveVehicleOptions): void {
    core.moveVehicle(from, to, opts);
    const target = anchorOf(to);
    if (!target) return;
    const a = anchorOf(from);
    if (from === to || immediate() || !a) {
      snapCamera(target);
      return;
    }
    // 선점(홉 중 재호출)이면 코어와 동일하게 현 보간 위치에서 리타깃한다.
    const startPos: LngLat = cameraHop ? [camera[0], camera[1]] : a;
    cameraHop = {
      interp: geoInterpolate(startPos, target),
      start: nowMs(),
      duration: opts?.durationMs ?? hopDurationMs(startPos, target),
    };
    schedule();
  }

  function wrappedFlyTo(ids: CountryId[], opts?: FlyToOptions): void {
    core.flyTo(ids, opts);
    const pts = ids.map((id) => index.anchor.get(id)).filter((a): a is [number, number] => Boolean(a));
    const first = pts[0];
    if (!first) return;
    const target: LngLat =
      pts.length === 1
        ? [first[0], first[1]]
        : (geoCentroid({ type: 'MultiPoint', coordinates: pts } as never) as LngLat);
    const duration = opts?.durationMs ?? FLY_DEFAULT_MS;
    if (immediate() || duration <= 0) {
      snapCamera(target);
      return;
    }
    cameraHop = {
      interp: geoInterpolate([camera[0], camera[1]], target),
      start: nowMs(),
      duration,
    };
    schedule();
  }

  function wrappedReset(): void {
    core.reset();
    clearRace();
    camera = [INITIAL_CENTER[0], INITIAL_CENTER[1]];
    projection.rotate([-camera[0], -camera[1]]);
  }

  function wrappedSetJuiceLevel(level: JuiceLevel): void {
    core.setJuiceLevel(level);
    juice = level;
    svg.setAttribute('data-juice', String(level));
  }

  // ── 레이스 전용 메서드 ────────────────────────────────────────────────────
  function createPlane(id: string, color: string): PlaneEntry {
    const el = document.createElementNS(SVG_NS, 'g');
    el.setAttribute('class', 'wt-race__plane');
    el.setAttribute('data-race-plane', id);
    el.style.display = 'none';
    el.style.setProperty('--wt-race-plane-color', color);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'wt-race__plane-shape');
    path.setAttribute('transform', 'rotate(90) translate(-12 -12)');
    path.setAttribute('d', PLANE_PATH_D);
    el.appendChild(path);
    gPlanes.appendChild(el);
    return { el, color, pos: null, heading: 0, lift: 0, hop: null };
  }

  function setRoster(players: readonly RacePlaneView[]): void {
    const keep = new Set(players.map((p) => p.id));
    for (const [id, entry] of planes) {
      if (keep.has(id)) continue;
      entry.el.remove();
      planes.delete(id);
    }
    for (const p of players) {
      const existing = planes.get(p.id);
      if (!existing) {
        planes.set(p.id, createPlane(p.id, p.color));
        continue;
      }
      if (existing.color !== p.color) {
        existing.color = p.color;
        existing.el.style.setProperty('--wt-race-plane-color', p.color);
      }
    }
    reprojectAll();
  }

  function snapPlane(id: string, at: CountryId): void {
    const entry = planes.get(id);
    const target = anchorOf(at);
    if (!entry || !target) return;
    entry.hop = null;
    entry.lift = 0;
    entry.pos = target;
    reprojectPlane(entry);
  }

  function movePlane(id: string, from: CountryId, to: CountryId, opts?: MoveVehicleOptions): void {
    const entry = planes.get(id);
    const target = anchorOf(to);
    if (!entry || !target) return;
    // 출발점은 "현재 위치 우선"(홉 선점 시 현 보간 위치 = 코어와 동일 규약), 없으면 from 앵커.
    const startPos = entry.pos ?? anchorOf(from);
    if (from === to || immediate() || !startPos) {
      entry.hop = null;
      entry.lift = 0;
      entry.pos = target;
      entry.heading = startPos ? bearingDeg(startPos, target) - 90 : entry.heading;
      reprojectPlane(entry);
      return;
    }
    entry.hop = {
      interp: geoInterpolate(startPos, target),
      start: nowMs(),
      duration: opts?.durationMs ?? hopDurationMs(startPos, target),
    };
    entry.heading = bearingDeg(startPos, target) - 90;
    schedule();
  }

  function removePlane(id: string): void {
    const entry = planes.get(id);
    if (!entry) return;
    entry.el.remove();
    planes.delete(id);
  }

  function clearRace(): void {
    cancelFrame();
    cameraHop = null;
    for (const entry of planes.values()) entry.el.remove();
    planes.clear();
  }

  const handle: GlobeRaceHandle = {
    // 카메라 비접점 메서드는 코어에 그대로 위임(canvas는 코어 소관 — 이 파일은 절대 만지지 않는다).
    setTarget: (id) => core.setTarget(id),
    markSolved: (id, colorVar) => core.markSolved(id, colorVar),
    markSkipped: (id) => core.markSkipped(id),
    drawRouteSegment: (from, to) => core.drawRouteSegment(from, to),
    setVehicleVisible: (visible) => core.setVehicleVisible(visible),
    setWaypointLabels: (labels) => core.setWaypointLabels(labels),
    pulseCheckpointRing: (id) => core.pulseCheckpointRing(id),
    // idle spin은 미러 대상이 아니다(설계 결정 3) — 레이스는 켜지 않는다.
    setIdleSpin: (on) => core.setIdleSpin(on),
    // 카메라 접점 — 미러 개입(설계 결정 1).
    moveVehicle: wrappedMoveVehicle,
    flyTo: wrappedFlyTo,
    reset: wrappedReset,
    setJuiceLevel: wrappedSetJuiceLevel,
    // 레이스 전용.
    setRoster,
    snapPlane,
    movePlane,
    removePlane,
    clearRace,
  };

  return handle;
}
