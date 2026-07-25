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
//
// ── WT-CH-DEV-1(§11-D108) 시인성 디벨롭 4건 — 전부 이 표시 계층에서만 처리(shared/engine 무수정) ──
// A. **대표 좌표 단일 소스 확정.** chase의 모든 마커·앵커·연결선·레이더 화살표는 chaseAnchor() 한
//    함수만 통해 좌표를 얻는다. 그 원천은 `GlobeIndex.anchor` = countries.json의 `latlng`이고, 이는
//    chase-graph(packages/data/src/build/chase-graph.ts)가 nearest-12·전쌍 km 행렬을 계산할 때 쓰는
//    것과 **완전히 동일한 점**이다(폴리곤 centroid 계열이 아님 — 실측 확인: FR[2,46]·US[-97,38]·
//    RU[100,60]·NZ[174,-41] 전부 본토). 따라서 "시각 앵커 ↔ 심 거리"가 구조적으로 정합한다.
//    데이터에 앵커가 없는 국가(초소국 등 방어 경로)에서만 최대 면적 폴리곤 centroid로 폴백한다
//    (largestPolygonCentroid — 모듈 WeakMap 캐시로 1회 계산). **또한 후보 앵커 도트가 reprojectAll에
//    빠져 있어 홉 회전 후 옛 화면 좌표에 남던 회귀를 수정한다** — 사용자 리포트 "연결선이 정확한
//    위치에 안 붙음"의 실제 원인(리더 라인은 라이브 projectAnchor를, 도트는 홉 이전 좌표를 쓰고
//    있었다).
// B. **전 국가(un195) 노드 도트 레이어.** setCountryNodes(ids)로 1회 생성, 현재국/홈/후보만 강조.
//    재투영은 기존 reproject* 계열과 동일하게 카메라가 움직이는 구간(홉 미러 rAF)에서만 돈다 —
//    상시 rAF 신설 없음(파일 헤더 설계 결정 2 계약 승계).
// C. **후보 대권 연결선.** 현재국 → 후보 3국을 great-circle 아크(sampleArc + geoPath — 코어와 동일
//    수학 재사용)로 SVG path에 그린다. 칩과 동일한 슬롯 번호(data-candidate-slot)를 연결선·앵커에
//    부여해 "몇 번 칩이 어느 나라인지"가 즉시 읽힌다. 프리하이라이트 후보의 선만 굵게/발광.
// D. **경찰 배지 아이콘.** 3종 전부 원형 배지(대비 배경 + 테두리) + 순수 SVG path 실루엣으로 개편
//    (chaser=경광등 경찰차 / interceptor=방패 / heli=헬기+로터+서치라이트). 점멸·회전은 배지 테두리·
//    로터 CSS 애니메이션으로 유지하고 기존 juice/reduced-motion 강등 표를 그대로 따른다.
//
// ── WT-CH-DEV-2(§11-D111) 시인성 잔여 2건 + 목표 강조 — 역시 전부 이 표시 계층 ────────────────
// E. **phase 오버레이 은닉(D108 "알려진 잔여" 해소).** idle(브리핑)·finished(결과) 구간의 코어
//    idle spin(0.55°/s)은 canvas만 돌리고 이 파일의 미러 카메라는 따라가지 않으므로(미러는 홉
//    카메라 접점 3메서드로만 갱신 — 파일 헤더 설계 결정 1·2), 그 구간에서는 마커·노드·연결선이
//    돌아가는 지구본 위에 고정된 채 남아 좌표가 어긋난다. **미러를 상시 rAF로 spin에 물리는 것은
//    D67 "playing 중 canvas 재그리기 0 / 상시 rAF 신설 금지" 계약과 정면 충돌**하므로, 리드 결정에
//    따라 해당 phase에서는 오버레이 자체를 은닉한다(브리핑·결과에 마커 정보는 불필요 — 필요한
//    정보는 브리핑 카드·결과 카드가 이미 전달한다). 은닉/표시는 opacity 트랜지션(tokens.css,
//    reduced-motion이면 즉시)으로만 처리하고 DOM은 유지한다 — 재표시 시 재구축 비용 0.
// F. **수배 발령 레이더 스윕 복원(CH-07 축소분, §7.6 "레이더 스윕 라인 1회전 600ms").** SVG 부채꼴
//    1회전을 이 오버레이(gRadar 레이어)에 그린다 — 사운드 로직(sequences.ts)은 무접점이며 그쪽은
//    playRadarSweep() 호출 1줄만 추가한다. reduced-motion/juice 강등이면 생략(immediate() 게이트).
// G. **배송 목표 강조.** 금 소지 중(setCarriedCount > 0)에는 홈 비컨과 홈 레이더 화살표에 강조
//    클래스를 건다 — "지금 어디로 가야 하는가"를 지구본에서 직접 읽히게 한다(HUD 목표 라벨과
//    동일 상태의 이중 부호화). 신규 메서드 없이 **기존 setCarriedCount 경로**에 얹었다: 그 메서드는
//    이미 ChaseGameRoot가 goldPicked/delivered마다 호출하고 있어 별도 배선이 불필요하다.
//
// ── WT-CH-DEV-3(§11-D114-A) 경찰 활공 연출 — 역시 표시 계층 전용(shared/engine 심 무접촉) ────────
// H. **경찰 이동 활공.** 경찰 마커가 국가 간을 순간이동하던 것을 플레이어 비행기 홉과 같은 대권
//    활공으로 잇는다. upsertPoliceMarker가 직전 at(entry.view.at)과 새 at을 비교해 변경일 때만
//    globe-hop.ts의 **기존 수학을 그대로 재사용**(geoInterpolate 대권 보간 + easeInOutCubic + 거리
//    가중 hopDurationMs)해 보간하며, 재구현·복제는 없다. 규약 4가지:
//    ① duration은 hopDurationMs(550~900ms)에 상한 클램프(POLICE_HOP_MAX_MS = 최단 경찰 틱의 80%)를
//       건다 — 연출이 다음 틱까지 이어지면 마커가 영영 목적지에 닿지 못한다.
//    ② 홉 도중 새 이동이 도착하면 **현재 보간점에서** 새 목표로 재시작한다(스냅·큐 누적 금지 —
//       유닛당 홉은 항상 0/1개).
//    ③ 카메라 회전(홉 미러)과 공존한다: 활공 좌표는 policePoint() 한 곳에서만 나오고 마커·추적선·
//       레이더 화살표가 전부 그것을 거치므로, 미러 rAF가 재투영해도 셋이 어긋나지 않는다. 활공용
//       rAF는 진행 중일 때만 도는 bounded 루프이며(설계 결정 2 계약 승계) 착지 즉시 정적 경로로
//       복귀한다. 뒷면 통과 구간은 기존 isFrontFacing 규약대로 은닉 + 레이더 화살표.
//    ④ reduced-motion·juice 강등·rAF 미지원에서는 종전과 동일한 즉시 스냅(강등 표 불변). 로터 회전·
//       배지 점멸 등 기존 연출은 그대로이고, 신규 연출은 진행 방향 미세 기울임(±8°) 하나뿐이다.
import {
  geoCentroid,
  geoDistance,
  geoInterpolate,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import { DEFAULT_CHASE_CONSTANTS } from '@wt/shared';
import type { CountryId } from '@wt/shared';
import type { FlyToOptions, JuiceLevel, MoveVehicleOptions } from '../map-handle';
import type { GeoFeature } from '../feature-binding';
import type { GlobeMapHandle } from './GlobeMap';
import type { GlobeIndex } from './globe-index';
import {
  bearingDeg,
  easeInOutCubic,
  hopDurationMs,
  isFrontFacing,
  sampleArc,
  type LngLat,
} from './globe-hop';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** GlobeMap.tsx의 LOGICAL_W/H·INITIAL_CENTER와 동일(코어가 export하지 않아 값만 복제 — 순수 치수
 * 상수이며 로직이 아니다. 코어와 값이 어긋나면 이 파일의 미러 좌표계가 어긋난다는 점만 유의). */
const LOGICAL_W = 960;
const LOGICAL_H = 500;
const INITIAL_CENTER: LngLat = [20, 20];
/** 레이더 에지 화살표 — 지구본 원판 반경 + 12px(§8.3). */
const RADAR_OFFSET = 12;
/** 후보국 앵커 배지 반경. §7.5 원안은 4px 도트였으나 §11-D108-C에서 슬롯 번호(1~3)를 얹는 배지로
 *  승격되어 6px로 확대했다(칩↔앵커 식별 일치가 목적 — 도트 자체의 역할·좌표 규약은 불변). */
const CANDIDATE_ANCHOR_R = 6;
/** 추적선 great-circle 샘플 점 수(경찰-플레이어 짧은 아크라 노선 원장의 64보다 적어도 충분). */
const TRAIL_ARC_SAMPLES = 48;
/** 후보 연결선 great-circle 샘플 점 수(인접국 짧은 아크 — 추적선 48보다 적어도 매끄럽다, D108-C). */
const LINK_ARC_SAMPLES = 32;
/** 전 국가 노드 도트 반경(D108-B) — 기본은 저채도·소형, 강조 상태만 확대. */
const NODE_R: Record<NodeState, number> = {
  idle: 1.6,
  candidate: 3.4,
  home: 4,
  current: 5,
};
/** 경찰 배지 반경(D108-D "r 8~9"). */
const POLICE_BADGE_R = 8.5;
/**
 * 경찰 활공(§11-D114-A) — 상한 산정의 기준이 되는 **최단 경찰 이동 주기**(3종 중 최소 = 헬기 틱,
 * 추격조는 ★5의 minTick이 최단). 심 상수의 단일 원천은 어디까지나 @wt/shared이고 여기서는 읽기만
 * 한다(복제·재정의 금지 — 상수를 올리면 이 상한도 자동으로 따라 올라간다). 클라 심은 KV 오버라이드
 * 없이 기본값(mergeChaseConstants() — ChaseGameRoot)으로 도는 것이 현행 계약이므로 기본값을 읽는다.
 */
const POLICE_MIN_TICK_MS = Math.min(
  DEFAULT_CHASE_CONSTANTS.police.heliTickMs,
  DEFAULT_CHASE_CONSTANTS.police.interceptorTickMs,
  DEFAULT_CHASE_CONSTANTS.police.chaserMinTickMs,
);
/**
 * 활공 지속 상한 = 최단 이동 주기의 80%. **연출이 다음 틱과 겹치면 안 된다** — 겹치는 순간 매 틱
 * 재타깃이 일어나 마커가 영구히 목적지에 도달하지 못하고(항상 이동 중) 실제 심 좌표보다 뒤처져
 * 보인다. 기본 상수에서는 거리 가중 duration의 상한(hopDurationMs = 900ms)이 이 값(1728ms)보다 훨씬
 * 작아 실제로 걸리는 일이 없고, KV로 틱을 크게 낮춘 경우의 안전망으로만 동작한다.
 */
const POLICE_HOP_MAX_MS = Math.floor(POLICE_MIN_TICK_MS * 0.8);
/** 진행 방향 기울임 최대각(도, §11-D114-A-4 "살짝"). 홉 중앙에서 최대 → 착지에서 0으로 복귀. */
const POLICE_TILT_MAX_DEG = 8;
/** 수배 발령 레이더 스윕 1회전(§7.6 "600ms" — sequences.ts WANTED_ISSUANCE_TIMELINE_MS.total과 동일
 *  값이나, 그 상수는 시퀀스 오프셋 테이블 소유라 이 파일이 import하지 않는다: 표시 계층 → 시퀀스
 *  계층 역참조를 만들지 않기 위함. 값 변경 시 양쪽을 함께 고쳐야 한다). */
const RADAR_SWEEP_MS = 600;
/** 스윕 부채꼴이 덮는 각도(도) — 좁으면 레이더 바늘, 넓으면 화면을 가린다. */
const RADAR_SWEEP_DEG = 42;
/** 금 광선 기둥 높이(§11-D115-C) — 마커에서 위로 뻗는 세로 빔. 지구본 곡면 위 소형 도트가
 *  "여기 금이 있다"로 읽히도록 수직 실루엣을 세운다(칩 인텔 행과 이중 부호화). */
const GOLD_BEAM_H = 26;
/** 금 광선 그라디언트 id(오버레이 SVG 로컬 defs — 문서 전역 충돌을 피해 접두사 고정). */
const GOLD_BEAM_GRADIENT_ID = 'wt-chase-gold-beam';
/** 경찰 위협 반경 글로우 반경(§11-D115-C). 배지(r8.5)를 감싸는 후광 — 실제 사거리가 아니라
 *  "여기 있으면 위험"의 시각 반경이며 강도는 setThreatLevel의 nearestHops로 3단 조절된다. */
const POLICE_THREAT_R = 20;

/** 노드 도트 강조 상태(D108-B). 우선순위: current > home > candidate > idle. */
type NodeState = 'idle' | 'candidate' | 'home' | 'current';

/**
 * 경찰 3종 실루엣(D108-D) — 배지(r=POLICE_BADGE_R) 안에 들어가는 12×12 논리 박스 기준 순수 path.
 * 확대해도 뭉개지지 않도록 비트맵·이모지를 쓰지 않는다(§8.7 아이콘 규약).
 *   chaser      = 경광등 바 + 순찰차 측면 실루엣
 *   interceptor = 방패(기존 실루엣 확대·중심 정렬)
 *   heli        = 마스트 + 캐빈 + 테일붐 + 수직 미익(로터는 회전이 필요해 별도 <line>)
 */
const POLICE_GLYPH_D: Record<PoliceKind, string> = {
  chaser:
    'M-1.4 -4.9 h2.8 v1.5 h-2.8 Z ' +
    'M-5.2 1.7 L-5.2 0.2 Q-5.2 -0.5 -4.5 -0.7 L-3.1 -1.0 L-2.0 -2.7 Q-1.8 -3.0 -1.4 -3.0 ' +
    'L1.8 -3.0 Q2.2 -3.0 2.4 -2.7 L3.5 -1.0 L4.6 -0.7 Q5.3 -0.5 5.3 0.2 L5.3 1.7 Z',
  interceptor: 'M0 -5.6 L4.8 -3.4 V0.4 Q4.8 4.4 0 5.8 Q-4.8 4.4 -4.8 0.4 V-3.4 Z',
  heli:
    'M-2.9 -4.6 h1.8 v1.6 h-1.8 Z ' +
    'M-5.6 -3.0 h3.4 q3.0 0 3.0 2.0 v0.9 q0 1.4 -1.6 1.4 h-4.8 q-1.6 0 -1.6 -1.5 v-1.3 ' +
    'q0 -1.5 1.6 -1.5 Z ' +
    'M0.6 -0.8 h4.4 v1.1 h-4.4 Z ' +
    'M4.4 -2.2 h1.1 v3.4 h-1.1 Z',
};

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
  /** 경찰 유닛 추가/갱신(id로 upsert). 소속국(at)이 바뀐 갱신은 **대권 활공**으로 이어진다
   *  (§11-D114-A — 아래 헤더 H. 스폰·동일국 갱신은 종전대로 정적 1회 DOM 갱신이며, 활공 구간에만
   *  bounded rAF가 돈다. canvas는 여전히 무접촉). */
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
  /** 후보국 앵커 배지(리더 라인 시작점 + 슬롯 번호) — 매 홉 착지 후 CH-06이 새 후보 3개로 호출.
   *  전달 순서 = 칩 슬롯 순서이며 앵커 번호·연결선 data-candidate-slot이 그 순서를 그대로 쓴다
   *  (§11-D108-C 식별 일치). 호출 즉시 현재국→후보 대권 연결선도 갱신된다. */
  setCandidateAnchors(ids: readonly CountryId[]): void;
  /** matching 폴리곤 금색 프리하이라이트(SVG 오버레이 — canvas 재그리기 0 유지). null이면 해제.
   *  해당 후보의 대권 연결선도 선두 강조(굵게·발광)로 전환된다(§11-D108-C). */
  setCandidatePrehighlight(id: CountryId | null): void;
  /** 전 국가(un195) 노드 도트 레이어 구축(§11-D108-B). 세션당 1회 호출(ChaseGameRoot가 chase-graph의
   *  `ids`를 그대로 전달 — un195 정확 일치). 강조 상태(현재국/홈/후보)는 이 핸들이 자체 추적한다. */
  setCountryNodes(ids: readonly CountryId[]): void;
  /** chase 오버레이 전체(마커·노드·연결선·비네트) 표시/은닉(§11-D111 ②-a — 위 헤더 E). idle(브리핑)·
   *  finished(결과)의 코어 idle spin 구간에서 좌표가 어긋난 채 남는 문제를 은닉으로 해소한다.
   *  DOM은 유지하고 CSS 클래스만 토글하므로 재표시 비용은 0이며, 은닉 중 호출된 갱신도 그대로
   *  반영돼(계산은 계속 정상) 복귀 즉시 최신 상태가 보인다. */
  setOverlayVisible(visible: boolean): void;
  /** 수배 발령(최초 ★1) 레이더 스윕 1회전(§7.6 "600ms" — §11-D111 ②-b, 위 헤더 F). reduced-motion·
   *  juice 강등이면 아무 것도 그리지 않는다. sequences.ts의 WANTED 타임라인이 0ms 오프셋에 호출한다. */
  playRadarSweep(): void;
}

/**
 * 최대 면적 폴리곤의 대표점(§11-D108-A ② 폴백 — GlobeIndex.anchor에 좌표가 없는 국가 전용).
 * 결과는 feature 객체 키의 모듈 WeakMap에 캐시해 1회만 계산한다(홉 루프 재진입 비용 0).
 *
 * 면적은 d3의 구면 geoArea가 아니라 **winding 무관 shoelace(위도 보정)**로 잰다: d3-geo의 구면
 * 폴리곤은 링 감김 방향으로 내부/외부가 뒤집히는데(GeoJSON RFC7946 반시계 ↔ d3 시계 관례 충돌),
 * 이 폴백은 어떤 출처의 feature가 들어올지 보장할 수 없어 감김에 의존하면 "작은 섬의 여집합"을
 * 최대 폴리곤으로 골라 대척점을 반환하는 사고가 난다. 대표점도 같은 이유로 geoCentroid(Polygon)
 * 대신 외곽 링 정점들의 구면 평균(MultiPoint centroid)을 쓴다 — 감김 무관·항상 그 덩어리 근처.
 */
export function largestPolygonCentroid(feature: GeoFeature): LngLat | null {
  const cached = centroidCache.get(feature);
  if (cached !== undefined) return cached;
  const geom = (feature as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
  let best: LngLat | null = null;
  if (geom?.type === 'Polygon') {
    best = ringCentroid((geom.coordinates as number[][][])[0]);
  } else if (geom?.type === 'MultiPolygon') {
    let bestArea = -1;
    for (const poly of geom.coordinates as number[][][][]) {
      const ring = poly[0];
      if (!ring) continue;
      const area = ringArea(ring);
      if (area > bestArea) {
        bestArea = area;
        best = ringCentroid(ring);
      }
    }
  }
  centroidCache.set(feature, best);
  return best;
}
const centroidCache = new WeakMap<GeoFeature, LngLat | null>();
/** 위도 보정 shoelace 면적(절댓값 — 감김 무관). 상대 비교 전용이라 단위는 무의미하다. */
function ringArea(ring: readonly number[][]): number {
  let sum = 0;
  let latSum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
    latSum += a[1]!;
  }
  const meanLat = ring.length > 0 ? latSum / ring.length : 0;
  return Math.abs(sum / 2) * Math.cos((meanLat * Math.PI) / 180);
}
function ringCentroid(ring: readonly number[][] | undefined): LngLat | null {
  if (!ring || ring.length === 0) return null;
  const c = geoCentroid({ type: 'MultiPoint', coordinates: ring } as never) as [number, number];
  return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0], c[1]] : null;
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
/** 노드 레이어 전용 저정밀 반올림 — 195개 × 매 홉 프레임의 문자열 생성 비용을 줄인다(0.1px는
 * r=1.6 도트에 충분히 과잉 정밀). */
function px(v: number): number {
  return Math.round(v * 10) / 10;
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

/**
 * 진행 중인 경찰 활공(§11-D114-A). 플레이어 비행기 홉과 **동일한 수학**을 재사용한다 —
 * geoInterpolate 대권 보간 + easeInOutCubic + 거리 가중 hopDurationMs(globe-hop.ts). 복제 없음.
 */
interface PoliceHop {
  interp: (t: number) => [number, number];
  start: number;
  duration: number;
  /** 기울임 계수 = sin(대권 초기 방위각) — 동/서 이동에서 ±1, 남북 이동에서 0. */
  lean: number;
}
interface PoliceMarkerEntry {
  el: SVGGElement;
  view: PoliceView;
  /** 활공 중 현재 좌표(대권 보간점). null이면 정적 = `view.at`의 chaseAnchor. */
  pos: LngLat | null;
  hop: PoliceHop | null;
  /** 현재 프레임 기울임(도). 0이면 transform에 rotate를 아예 붙이지 않는다(정적 시 문자열 동일). */
  tiltDeg: number;
}
interface GoldMarkerEntry {
  /** §11-D115-C에서 단일 <circle>에서 "광선 기둥 + 도트" 그룹으로 승격(위치는 transform으로 이동). */
  el: SVGGElement;
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

  // 금 광선 기둥용 그라디언트(§11-D115-C) — 아래(마커)에서 위로 사라지는 세로 페이드. 색은
  // currentColor(=CSS --chase-gold)를 상속받아 테마 토큰 규약을 지킨다.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const beamGrad = document.createElementNS(SVG_NS, 'linearGradient');
  beamGrad.setAttribute('id', GOLD_BEAM_GRADIENT_ID);
  beamGrad.setAttribute('x1', '0');
  beamGrad.setAttribute('y1', '1');
  beamGrad.setAttribute('x2', '0');
  beamGrad.setAttribute('y2', '0');
  const stopA = document.createElementNS(SVG_NS, 'stop');
  stopA.setAttribute('offset', '0%');
  stopA.setAttribute('stop-color', 'currentColor');
  stopA.setAttribute('stop-opacity', '0.75');
  const stopB = document.createElementNS(SVG_NS, 'stop');
  stopB.setAttribute('offset', '100%');
  stopB.setAttribute('stop-color', 'currentColor');
  stopB.setAttribute('stop-opacity', '0');
  beamGrad.append(stopA, stopB);
  defs.appendChild(beamGrad);

  const gPrehighlight = document.createElementNS(SVG_NS, 'g');
  gPrehighlight.setAttribute('data-layer', 'chase-prehighlight');
  const gLinks = document.createElementNS(SVG_NS, 'g');
  gLinks.setAttribute('data-layer', 'chase-links');
  const gNodes = document.createElementNS(SVG_NS, 'g');
  gNodes.setAttribute('data-layer', 'chase-nodes');
  const gTrails = document.createElementNS(SVG_NS, 'g');
  gTrails.setAttribute('data-layer', 'chase-trails');
  const gRadar = document.createElementNS(SVG_NS, 'g');
  gRadar.setAttribute('data-layer', 'chase-radar');
  const gHome = document.createElementNS(SVG_NS, 'g');
  gHome.setAttribute('data-layer', 'chase-home');
  // 클래스는 §11-D111 ③ 배송 강조(.is-delivering)의 CSS 앵커 — 레이어 자체의 시각 규칙은 없다.
  gHome.setAttribute('class', 'wt-chase__home');
  gHome.style.display = 'none';
  const gGold = document.createElementNS(SVG_NS, 'g');
  gGold.setAttribute('data-layer', 'chase-gold');
  const gPolice = document.createElementNS(SVG_NS, 'g');
  gPolice.setAttribute('data-layer', 'chase-police');
  const gCandidates = document.createElementNS(SVG_NS, 'g');
  gCandidates.setAttribute('data-layer', 'chase-candidates');
  const gPop = document.createElementNS(SVG_NS, 'g');
  gPop.setAttribute('data-layer', 'chase-pop');
  // z-순서(§8.3 개정 + §11-D108 신규 2개 레이어 삽입 — DOM 삽입 순서로 성립): 프리하이라이트(폴리곤)
  // < 후보 대권 연결선 < 전 국가 노드 도트 < 추적선 < 레이더 화살표 < 홈 < 금 < 경찰(위협 정보 >
  // 후보 정보, §8.5) < 후보 앵커 배지 < 팝 이펙트/가방 배지. 신규 2종은 "지도 가구"라 기존 마커류
  // 아래에 깔린다(09a §4 "지구본 canvas < 추적선/마커 < 리더 라인 < 콜아웃 칩" 위계 유지).
  svg.append(defs, gPrehighlight, gLinks, gNodes, gTrails, gRadar, gHome, gGold, gPolice, gCandidates, gPop);

  const vignette = document.createElement('div');
  vignette.setAttribute('class', 'wt-chase__vignette');
  vignette.setAttribute('aria-hidden', 'true');
  vignette.style.setProperty('--chase-vignette-alpha', '0');

  container.append(svg, vignette);

  // ── 상태 ──────────────────────────────────────────────────────────────────
  let homeId: CountryId | null = null;
  const policeMarkers = new Map<number, PoliceMarkerEntry>();
  const goldMarkers = new Map<CountryId, GoldMarkerEntry>();
  const candidateAnchors = new Map<CountryId, SVGGElement>();
  const radarArrows = new Map<string, SVGGElement>();
  // §11-D108-B/C 신규 상태: 전 국가 노드 · 현재국(연결선 기점) · 후보 슬롯 순서 · 선두 후보.
  const nodeEls = new Map<CountryId, SVGCircleElement>();
  const candidateSlot = new Map<CountryId, number>();
  let currentId: CountryId | null = null;
  let prehighlightId: CountryId | null = null;
  let carriedBadge: SVGGElement | null = null;
  let carriedCount = 0;
  /** §11-D111 ②-a 오버레이 표시 상태. 기본 true(기존 소비자 무영향) — ChaseGameRoot가 phase에 따라
   *  토글한다. */
  let overlayVisible = true;
  /** 진행 중인 레이더 스윕 노드(재발령 시 중복 방지 — 항상 1개만 존재). */
  let sweepEl: SVGGElement | null = null;

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
  /**
   * §11-D108-A: chase 표시 계층의 **유일한** 국가 대표 좌표 접근자. 원천은 GlobeIndex.anchor
   * (= countries.json `latlng`)이며 chase-graph의 거리 계산 기준점과 완전히 동일하다 —
   * 시각(마커/앵커/연결선/레이더)과 심(거리·nearest)이 같은 점을 쓰므로 어긋날 수 없다.
   * 앵커가 없는 국가에서만 최대 면적 폴리곤 centroid로 폴백한다(다권역 국가의 전체 centroid가
   * 바다에 찍히는 문제를 폴백 경로에서도 만들지 않기 위함).
   */
  function chaseAnchor(id: CountryId): LngLat | null {
    const a = index.anchor.get(id);
    if (a) return [a[0], a[1]];
    const f = index.featureByCountry.get(id);
    return f ? largestPolygonCentroid(f) : null;
  }

  function project(id: CountryId): { p: [number, number]; front: boolean } | null {
    const a = chaseAnchor(id);
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

  /** §11-D111 ③(위 헤더 G): 금 소지 중이면 홈 비컨·홈 레이더 화살표를 강조 상태로 전환한다 —
   *  HUD 목표 라벨("🏠 홈으로 배송하세요")과 같은 상태를 지구본에서도 읽히게 하는 이중 부호화.
   *  클래스 토글뿐이라 좌표 계산·재투영 비용은 0. */
  function applyHomeEmphasis(): void {
    const on = carriedCount > 0;
    gHome.classList.toggle('is-delivering', on);
    radarArrows.get('home')?.classList.toggle('is-emphasis', on);
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
      const a = chaseAnchor(homeId);
      if (a) upsertRadarArrow('home', 'wt-chase__radar-arrow--home', a, geoDistance(a, [camera.lng, camera.lat]));
    }
    applyHomeEmphasis();
  }

  /** 경찰 마커의 **현재 표시 좌표**(§11-D114-A) — 활공 중이면 대권 보간점, 정적이면 소속국 앵커.
   *  마커·추적선·레이더 화살표가 전부 이 한 함수를 거치므로 활공 중에도 셋이 어긋나지 않는다. */
  function policePoint(entry: PoliceMarkerEntry): LngLat | null {
    return entry.pos ?? chaseAnchor(entry.view.at);
  }

  function reprojectPolice(): void {
    const cam: LngLat = [camera.lng, camera.lat];
    for (const [id, entry] of policeMarkers) {
      const a = policePoint(entry);
      if (!a) continue;
      const p = projection(a);
      if (!p) continue;
      if (isFrontFacing(a, cam)) {
        entry.el.style.display = '';
        const xy = `translate(${round(p[0])} ${round(p[1])})`;
        entry.el.setAttribute(
          'transform',
          entry.tiltDeg === 0 ? xy : `${xy} rotate(${round(entry.tiltDeg)})`,
        );
        removeRadarArrow(`police:${id}`);
      } else {
        // 활공 중 지구 뒷면을 지나가는 구간도 정적 규약과 동일하게 은닉 + 레이더 화살표로 대체한다.
        entry.el.style.display = 'none';
        upsertRadarArrow(`police:${id}`, 'wt-chase__radar-arrow--police', a, geoDistance(a, cam));
      }
    }
  }

  // ── 경찰 활공 루프(§11-D114-A) ──────────────────────────────────────────
  // 홉이 하나라도 진행 중일 때만 도는 bounded rAF다(파일 헤더 설계 결정 2의 "상시/유휴 루프 금지"
  // 계약 승계). 유닛마다 rAF를 띄우지 않고 한 루프가 전 유닛을 함께 전진시킨다.
  let policeRaf: number | null = null;

  function cancelPoliceRaf(): void {
    if (policeRaf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(policeRaf);
    policeRaf = null;
  }
  function ensurePoliceRaf(): void {
    if (policeRaf != null || typeof requestAnimationFrame !== 'function') return;
    policeRaf = requestAnimationFrame(policeHopFrame);
  }
  function policeHopFrame(now: number): void {
    policeRaf = null;
    let active = false;
    for (const entry of policeMarkers.values()) {
      const h = entry.hop;
      if (!h) continue;
      const raw = h.duration > 0 ? clamp01((now - h.start) / h.duration) : 1;
      const pos = h.interp(easeInOutCubic(raw));
      entry.pos = [pos[0], pos[1]];
      // 기울임 봉투 sin(π·raw): 출발 0 → 중앙 최대 → 착지 0(코어 홉의 lift 봉투와 같은 형태).
      entry.tiltDeg = POLICE_TILT_MAX_DEG * h.lean * Math.sin(Math.PI * raw);
      if (raw >= 1) clearPoliceHop(entry);
      else active = true;
    }
    reprojectPolice();
    reprojectTrails(); // 추적선 기점도 활공 좌표를 따른다(policePoint 단일 출구).
    if (active) policeRaf = requestAnimationFrame(policeHopFrame);
  }
  /** 활공 종료/취소 — 정적 경로(`view.at` 앵커)로 복귀시킨다(좌표 이중 보관 금지). */
  function clearPoliceHop(entry: PoliceMarkerEntry): void {
    entry.hop = null;
    entry.pos = null;
    entry.tiltDeg = 0;
  }
  /** 진행 중인 홉이 하나도 없으면 루프를 끊는다(누수 = 유휴 rAF = 계약 위반). */
  function stopPoliceRafIfIdle(): void {
    for (const entry of policeMarkers.values()) if (entry.hop) return;
    cancelPoliceRaf();
  }
  /** 전 유닛 활공 즉시 종료(강등 전환·reset). 목적지로 스냅된다. */
  function snapAllPoliceHops(): void {
    let had = false;
    for (const entry of policeMarkers.values()) {
      if (!entry.hop) continue;
      clearPoliceHop(entry);
      had = true;
    }
    cancelPoliceRaf();
    if (had) reprojectPolice();
  }
  /**
   * 경찰 이동 활공 시작(§11-D114-A). 진행 중인 홉이 있으면 **현재 보간점에서** 새 목표로 재시작한다
   * (스냅 금지 + 큐 누적 금지 — 유닛당 홉은 항상 0개 또는 1개). immediate() 강등(reduced-motion·
   * juice≥1·rAF 미지원)에서는 연출 없이 즉시 스냅(기존 강등 표 준수).
   */
  function beginPoliceHop(entry: PoliceMarkerEntry, from: CountryId, to: CountryId): void {
    if (immediate()) {
      clearPoliceHop(entry);
      stopPoliceRafIfIdle();
      return;
    }
    const a = entry.pos ?? chaseAnchor(from);
    const b = chaseAnchor(to);
    if (!a || !b) {
      clearPoliceHop(entry);
      stopPoliceRafIfIdle();
      return;
    }
    // duration = 코어와 동일한 거리 가중 공식 + 다음 틱과 겹치지 않게 상한 클램프(POLICE_HOP_MAX_MS).
    const duration = Math.min(hopDurationMs(a, b), POLICE_HOP_MAX_MS);
    entry.hop = {
      interp: geoInterpolate(a, b),
      start: nowMs(),
      duration,
      lean: Math.sin((bearingDeg(a, b) * Math.PI) / 180),
    };
    entry.pos = [a[0], a[1]];
    entry.tiltDeg = 0;
    ensurePoliceRaf();
  }

  function reprojectGold(): void {
    for (const [countryId, entry] of goldMarkers) {
      const r = project(countryId);
      if (!r) continue;
      if (r.front) {
        entry.el.style.display = '';
        // 그룹 전체를 translate — 광선 기둥(로컬 y 0→−GOLD_BEAM_H)이 도트와 항상 붙어 다닌다.
        entry.el.setAttribute('transform', `translate(${round(r.p[0])} ${round(r.p[1])})`);
        removeRadarArrow(`gold:${countryId}`);
      } else {
        entry.el.style.display = 'none';
        const a = chaseAnchor(countryId);
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
    for (const entry of policeMarkers.values()) {
      const a = policePoint(entry); // 활공 중이면 보간점에서 선이 뻗는다(§11-D114-A).
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

  /** 전 국가 노드 도트 재투영(§11-D108-B). 뒷면은 display 토글로 은닉(기존 isFrontFacing 재사용).
   *  노드가 없으면(setCountryNodes 미호출 — 브리핑 등) 즉시 반환해 비용 0. */
  function reprojectNodes(): void {
    if (nodeEls.size === 0) return;
    const cam: LngLat = [camera.lng, camera.lat];
    for (const [id, el] of nodeEls) {
      const a = chaseAnchor(id);
      if (!a || !isFrontFacing(a, cam)) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      const p = projection(a);
      if (!p) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      if (el.style.display === 'none') el.style.display = '';
      el.setAttribute('cx', String(px(p[0])));
      el.setAttribute('cy', String(px(p[1])));
    }
  }

  /** 노드 강조 상태 반영(§11-D108-B) — 위치는 건드리지 않고 상태·반경만 갱신(값이 같으면 no-op). */
  function applyNodeStates(): void {
    if (nodeEls.size === 0) return;
    for (const [id, el] of nodeEls) {
      const state: NodeState =
        id === currentId ? 'current' : id === homeId ? 'home' : candidateSlot.has(id) ? 'candidate' : 'idle';
      if (el.getAttribute('data-node-state') === state) continue;
      el.setAttribute('data-node-state', state);
      el.setAttribute('r', String(NODE_R[state]));
    }
  }

  /** 후보 앵커 배지 재투영(§11-D108-A 회귀 수정 — 이전 구현은 reprojectAll에 빠져 있어 홉 회전 후
   *  옛 좌표에 남아 리더 라인 끝점과 어긋났다). */
  function reprojectCandidates(): void {
    for (const [id, el] of candidateAnchors) {
      const r = project(id);
      if (!r) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = r.front ? '' : 'none';
      el.setAttribute('transform', `translate(${round(r.p[0])} ${round(r.p[1])})`);
    }
  }

  /** 현재국 → 후보 3국 대권 연결선(§11-D108-C). 직선이 아니라 great-circle 아크(sampleArc + geoPath)
   *  라서 지구본 곡률과 어긋나지 않는다. 매 호출 전량 재구성(최대 3개 — 비용 무시 가능). */
  function reprojectLinks(): void {
    gLinks.replaceChildren();
    if (!currentId || candidateSlot.size === 0) return;
    const from = chaseAnchor(currentId);
    if (!from) return;
    const cam: LngLat = [camera.lng, camera.lat];
    for (const [id, slot] of candidateSlot) {
      const to = chaseAnchor(id);
      if (!to) continue;
      // 양 끝이 모두 뒷면이면 그릴 것이 없다(후보는 구조적으로 항상 정면 — 방어적 가드).
      if (!isFrontFacing(to, cam) && !isFrontFacing(from, cam)) continue;
      const d = pathGen({ type: 'LineString', coordinates: sampleArc(from, to, LINK_ARC_SAMPLES) } as never);
      if (!d) continue;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute(
        'class',
        id === prehighlightId ? 'wt-chase__link wt-chase__link--lead' : 'wt-chase__link',
      );
      path.setAttribute('d', d);
      path.setAttribute('data-candidate-link', id);
      path.setAttribute('data-candidate-slot', String(slot));
      gLinks.appendChild(path);
    }
  }

  /** 선두(프리하이라이트) 후보 연결선만 굵게·발광 — path 재계산 없이 클래스만 토글(§11 p95<16ms). */
  function applyLinkLead(): void {
    for (const child of Array.from(gLinks.children)) {
      const id = child.getAttribute('data-candidate-link');
      child.classList.toggle('wt-chase__link--lead', id !== null && id === prehighlightId);
    }
  }

  function reprojectAll(): void {
    reprojectNodes();
    reprojectCandidates();
    reprojectLinks();
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
    const b = chaseAnchor(to);
    if (!b) return;
    // 현재국 = 연결선 기점 + 노드 강조 기준(§11-D108-B/C). 도착지를 즉시 반영해 홉 회전 중에도
    // 새 후보 팬이 목적지에서 뻗어 나온다.
    currentId = to;
    applyNodeStates();
    const target: LngLat = [b[0], b[1]];
    if (from === to || immediate()) {
      fireHop('start');
      snapCameraTo(target);
      fireHop('land');
      return;
    }
    const a = chaseAnchor(from);
    const startPos: LngLat = mirrorHop ? [camera.lng, camera.lat] : a ?? target;
    const duration = opts?.durationMs ?? hopDurationMs(startPos, target);
    fireHop('start');
    beginMirrorHop(startPos, target, duration);
  }

  function wrappedFlyTo(ids: CountryId[], opts?: FlyToOptions): void {
    core.flyTo(ids, opts);
    // chase는 flyTo를 쓰지 않는다(docs/09 무언급) — 호출되더라도(카메라) 정밀 미러 대신 스냅 근사만
    // 수행한다(알려진 단순화, 최종 보고 기재).
    const pts = ids.map((id) => chaseAnchor(id)).filter((a): a is LngLat => a !== null);
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
    currentId = null;
    prehighlightId = null;
    cancelPoliceRaf(); // 진행 중인 활공 루프 해제(§11-D114-A — 세션 종료 후 유휴 rAF 금지).
    for (const { el } of policeMarkers.values()) el.remove();
    policeMarkers.clear();
    for (const { el } of goldMarkers.values()) el.remove();
    goldMarkers.clear();
    for (const el of candidateAnchors.values()) el.remove();
    candidateAnchors.clear();
    candidateSlot.clear();
    nodeEls.clear();
    for (const el of radarArrows.values()) el.remove();
    radarArrows.clear();
    sweepEl?.remove();
    sweepEl = null;
    gHome.replaceChildren();
    gHome.classList.remove('is-delivering');
    gHome.style.display = 'none';
    gPrehighlight.replaceChildren();
    gLinks.replaceChildren();
    gNodes.replaceChildren();
    gTrails.replaceChildren();
    gPop.replaceChildren();
    gPolice.removeAttribute('data-threat'); // §11-D115-C 글로우 강도 초기화
    carriedBadge = null;
    carriedCount = 0;
    vignette.style.setProperty('--chase-vignette-alpha', '0');
  }

  function wrappedSetJuiceLevel(level: JuiceLevel): void {
    core.setJuiceLevel(level);
    juice = level;
    svg.setAttribute('data-juice', String(level));
    // 강등으로 전환되면 진행 중이던 경찰 활공도 즉시 중단·스냅한다(§11-D114-A 강등 표 준수).
    if (immediate()) snapAllPoliceHops();
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
    applyNodeStates();
    reprojectHome();
  }

  /**
   * 경찰 유닛 마커(§11-D108-D 배지형 개편) — 3종 공통으로 "대비 배경 + 테두리 원형 배지(r 8.5) 안의
   * 또렷한 실루엣"이다. 이전 구현(작은 색 도트/그림자 없는 방패)이 무엇을 뜻하는지 읽히지 않는다는
   * 사용자 리포트에 대응한다. 배지·실루엣 전부 순수 SVG path라 확대해도 뭉개지지 않는다.
   *   chaser      = 경광등 경찰차 실루엣 + 적청 점멸(배지 테두리) + 확산 링
   *   interceptor = 방패 실루엣(확대·중심 정렬)
   *   heli        = 헬기 실루엣 + 회전 로터 + 서치라이트 콘(배지 아래로 뻗음)
   * 점멸·로터 회전은 기존 juice/reduced-motion 강등 표(tokens.css)를 그대로 따른다.
   */
  function policeShape(kind: PoliceKind): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `wt-chase__police wt-chase__police--${kind}`);
    g.setAttribute('data-police-kind', kind);

    // §11-D115-C 위협 반경 글로우 — 가장 뒤(먼저 삽입)에 깔리는 후광. 강도는 gPolice의
    // data-threat(setThreatLevel 파생)로 CSS가 3단 조절한다(요소는 항상 존재, 비용 0).
    const threat = document.createElementNS(SVG_NS, 'circle');
    threat.setAttribute('class', 'wt-chase__police-threat');
    threat.setAttribute('r', String(POLICE_THREAT_R));
    g.appendChild(threat);

    if (kind === 'heli') {
      // 서치라이트 콘은 배지 뒤(먼저 삽입)에서 아래로 뻗는다.
      const cone = document.createElementNS(SVG_NS, 'path');
      cone.setAttribute('class', 'wt-chase__police-cone');
      cone.setAttribute('d', 'M0 5 L-9 22 L9 22 Z');
      g.appendChild(cone);
    }

    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('class', 'wt-chase__police-badge');
    badge.setAttribute('r', String(POLICE_BADGE_R));
    g.appendChild(badge);

    const glyph = document.createElementNS(SVG_NS, 'path');
    glyph.setAttribute('class', `wt-chase__police-glyph wt-chase__police-glyph--${kind}`);
    glyph.setAttribute('d', POLICE_GLYPH_D[kind]);
    g.appendChild(glyph);

    if (kind === 'chaser') {
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('class', 'wt-chase__police-ring');
      ring.setAttribute('r', String(POLICE_BADGE_R));
      g.appendChild(ring);
    } else if (kind === 'heli') {
      // 로터는 마스트 중심(x=-2, y=-5.2)에서 회전한다(CSS rotate 0.5s linear infinite).
      const rotor = document.createElementNS(SVG_NS, 'line');
      rotor.setAttribute('class', 'wt-chase__police-rotor');
      rotor.setAttribute('x1', '-9');
      rotor.setAttribute('y1', '-5.2');
      rotor.setAttribute('x2', '5');
      rotor.setAttribute('y2', '-5.2');
      g.appendChild(rotor);
    }
    return g;
  }

  function upsertPoliceMarker(u: PoliceView): void {
    let entry = policeMarkers.get(u.id);
    const prevAt = entry ? entry.view.at : null;
    if (!entry) {
      const el = policeShape(u.kind);
      el.setAttribute('data-police-id', String(u.id));
      gPolice.appendChild(el);
      entry = { el, view: u, pos: null, hop: null, tiltDeg: 0 };
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
    // §11-D114-A: 소속국이 바뀐 갱신은 순간이동 대신 대권 활공으로 잇는다. 스폰(첫 upsert)과 동일국
    // 재갱신(policeUpdated는 이동하지 않은 유닛도 함께 싣는다)은 정적 — 불필요한 애니메이션 없음.
    if (prevAt !== null && prevAt !== u.at) beginPoliceHop(entry, prevAt, u.at);
    reprojectPolice();
    reprojectTrails();
  }

  function removePoliceMarker(id: number): void {
    const entry = policeMarkers.get(id);
    if (!entry) return;
    entry.el.remove();
    policeMarkers.delete(id);
    removeRadarArrow(`police:${id}`);
    stopPoliceRafIfIdle(); // 마지막 활공 유닛이 사라졌으면 루프 종료(누수 금지).
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
        // §11-D115-C: 광선 기둥(아래→위 페이드) + 도트. 클래스·data-gold-ring은 종전대로 최상위
        // 노드에 유지해 기존 셀렉터(.wt-chase__gold[data-gold-ring])가 그대로 성립한다.
        const el = document.createElementNS(SVG_NS, 'g');
        el.setAttribute('class', 'wt-chase__gold');
        el.setAttribute('data-gold-ring', g.ring);
        const beam = document.createElementNS(SVG_NS, 'rect');
        beam.setAttribute('class', 'wt-chase__gold-beam');
        beam.setAttribute('x', '-1.6');
        beam.setAttribute('y', String(-GOLD_BEAM_H));
        beam.setAttribute('width', '3.2');
        beam.setAttribute('height', String(GOLD_BEAM_H));
        beam.setAttribute('fill', `url(#${GOLD_BEAM_GRADIENT_ID})`);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'wt-chase__gold-dot');
        dot.setAttribute('r', '5');
        el.append(beam, dot);
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
    applyHomeEmphasis(); // §11-D111 ③ — 소지 상태 전환 시 홈 비컨/레이더 화살표 강조 토글.
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
    // §11-D115-C 위협 반경 글로우 강도 — 이미 계산 중인 nearestHops를 재사용한다(신규 데이터 0).
    // 비네트가 "화면 전체의 압박"이라면 이 글로우는 "그 위협의 위치"를 지도 위에 국소화한다.
    gPolice.setAttribute('data-threat', nearestHops <= 1 ? 'high' : nearestHops <= 2 ? 'mid' : 'low');
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

  /** 전 국가(un195) 노드 도트 레이어 구축(§11-D108-B). 세션당 1회 — 이후는 강조 상태·재투영만. */
  function setCountryNodes(ids: readonly CountryId[]): void {
    gNodes.replaceChildren();
    nodeEls.clear();
    const frag = document.createDocumentFragment();
    for (const id of ids) {
      if (!chaseAnchor(id)) continue;
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('class', 'wt-chase__node');
      el.setAttribute('data-node', id);
      el.setAttribute('data-node-state', 'idle');
      el.setAttribute('r', String(NODE_R.idle));
      nodeEls.set(id, el);
      frag.appendChild(el);
    }
    gNodes.appendChild(frag);
    applyNodeStates();
    reprojectNodes();
  }

  function setCandidateAnchors(ids: readonly CountryId[]): void {
    candidateSlot.clear();
    ids.forEach((id, i) => candidateSlot.set(id, i));
    const keep = new Set(ids);
    for (const [id, el] of candidateAnchors) {
      if (!keep.has(id)) {
        el.remove();
        candidateAnchors.delete(id);
      }
    }
    for (const id of ids) {
      if (!chaseAnchor(id)) continue;
      let el = candidateAnchors.get(id);
      if (!el) {
        el = document.createElementNS(SVG_NS, 'g');
        el.setAttribute('class', 'wt-chase__candidate');
        el.setAttribute('data-candidate-anchor', id);
        const ring = document.createElementNS(SVG_NS, 'circle');
        ring.setAttribute('class', 'wt-chase__candidate-anchor');
        ring.setAttribute('r', String(CANDIDATE_ANCHOR_R));
        // 슬롯 번호(1~3) — 콜아웃 칩의 동일 번호와 짝을 이룬다(§11-D108-C 식별 일치).
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'wt-chase__candidate-index');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dy', '2.6');
        el.append(ring, label);
        gCandidates.appendChild(el);
        candidateAnchors.set(id, el);
      }
      const slot = candidateSlot.get(id) ?? 0;
      el.setAttribute('data-candidate-slot', String(slot));
      const label = el.querySelector('text');
      if (label) label.textContent = String(slot + 1);
    }
    reprojectCandidates();
    applyNodeStates();
    reprojectLinks();
  }

  /** §11-D111 ②-a — 오버레이 표시/은닉. DOM은 그대로 두고 클래스만 토글한다(재표시 비용 0).
   *  트랜지션·reduced-motion 즉시 전환은 tokens.css `.wt-chase__overlay.is-hidden` 규칙 소관. */
  function setOverlayVisible(visible: boolean): void {
    if (overlayVisible === visible) return;
    overlayVisible = visible;
    svg.classList.toggle('is-hidden', !visible);
    vignette.classList.toggle('is-hidden', !visible);
  }

  /** 부채꼴 path(원점 기준, +x축에서 시계방향으로 RADAR_SWEEP_DEG). r은 지구본 원판 반경. */
  function sweepWedgePath(r: number): string {
    const rad = (RADAR_SWEEP_DEG * Math.PI) / 180;
    const x = round(r * Math.cos(rad));
    const y = round(r * Math.sin(rad));
    return `M0 0 L${round(r)} 0 A${round(r)} ${round(r)} 0 0 1 ${x} ${y} Z`;
  }

  /** §11-D111 ②-b — 수배 발령 레이더 스윕 1회전(§7.6, 600ms). 지구본 중심을 축으로 부채꼴이 한 바퀴
   *  돌고 사라진다. 회전은 WAAPI transform(리플로우 0), 미지원 환경(jsdom 등)에서는 동일 시간 뒤
   *  제거하는 폴백만 건다 — 어느 쪽이든 노드는 즉시 삽입되므로 "스윕이 그려졌다"는 관찰 가능하다. */
  function playRadarSweep(): void {
    if (immediate()) return; // reduced-motion/juice 강등 시 생략(§7 헤더 강등표).
    sweepEl?.remove();
    const c = center();
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'wt-chase__sweep');
    g.setAttribute('transform', `translate(${round(c[0])} ${round(c[1])})`);
    const wedge = document.createElementNS(SVG_NS, 'path');
    wedge.setAttribute('class', 'wt-chase__sweep-wedge');
    wedge.setAttribute('d', sweepWedgePath(projection.scale()));
    g.appendChild(wedge);
    gRadar.appendChild(g);
    sweepEl = g;

    const cleanup = (): void => {
      g.remove();
      if (sweepEl === g) sweepEl = null;
    };
    if (typeof wedge.animate !== 'function') {
      setTimeout(cleanup, RADAR_SWEEP_MS);
      return;
    }
    const anim = wedge.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: RADAR_SWEEP_MS,
      easing: 'linear',
      fill: 'none',
    });
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  }

  function setCandidatePrehighlight(id: CountryId | null): void {
    prehighlightId = id;
    applyLinkLead();
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
    setCountryNodes,
    setOverlayVisible,
    playRadarSweep,
  };

  return handle;
}
