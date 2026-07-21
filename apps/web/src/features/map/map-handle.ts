// spec: docs/03 §3.2(WorldMapHandle 전문 — 명령형 핸들 계약), §3.6(리렌더 0 계약),
//       docs/00 §11-D19(경로), WT-M2-04
//
// 지도는 마운트 후 React 리렌더로 폴리곤을 다시 그리지 않는다(§3.6 불변식). 게임 진행에 따른
// 모든 변화는 이 핸들의 메서드로만 일어나며 각 메서드는 SVG 노드의 attribute/classList/WAAPI만
// 건드린다(React state 미경유). 고빈도 값(콤보·CPM·경과시간)은 애초에 이 핸들을 통하지 않는다.

import type { CountryId } from '@wt/shared';

/** 저사양 강등 레벨(docs/03 §3.6). 0=풀, 1=펄스/파티클 off·카메라 스냅, 2=최소(예약). */
export type JuiceLevel = 0 | 1 | 2;

export interface FlyToOptions {
  /** viewBox(960×500) 좌표계 기준 여백. computeCamera 기본 40. */
  padding?: number;
  /** WAAPI 전이 시간(ms). reduced-motion/juice 강등 시 0(즉시 스냅). 기본 800. */
  durationMs?: number;
}

/**
 * docs/03 §3.2 전문. WorldMap 마운트 시 onReady로 1회 전달된다.
 * 모든 메서드는 동기이며 SVG DOM만 조작한다(엔진 이벤트 루프에서 초당 수 회 호출 가능).
 */
export interface WorldMapHandle {
  /** 이전 타깃 해제 + 신규 국가 점등(펄스 CSS). null이면 타깃 해제만. */
  setTarget(id: CountryId | null): void;
  /** solved 레이어에 해당 국가 도형 추가 + fill 0→1 전이(300ms). colorVar 예: 'var(--continent-asia)'. */
  markSolved(id: CountryId, colorVar: string): void;
  /** from→to centroid 사이 노선 세그먼트 드로잉(300ms dash). 날짜변경선 교차 시 2-패스(§3.5). */
  drawRouteSegment(from: CountryId, to: CountryId): void;
  /** 주어진 국가 집합의 bounds에 카메라를 맞춘다(WAAPI 800ms, §3.4). */
  flyTo(ids: CountryId[], opts?: FlyToOptions): void;
  /** target/solved/route 레이어를 비우고 카메라를 월드 고정으로 되돌린다(리트라이/모드 전환). */
  reset(): void;
  /** juice 레벨 하향 — svg 루트 data-juice 속성으로 CSS 펄스/파티클/드로잉을 제어(§3.6). */
  setJuiceLevel(level: JuiceLevel): void;
}
