// spec: docs/00 §11-D45(홈 히어로 지도 로딩 전략 — HeroMap을 React.lazy 청크로 분리하고 즉시
//       페인트되는 경량 플레이스홀더가 LCP 요소가 되도록 설계, 레이아웃 시프트 없이 동일 크기
//       예약), docs/03 §8.5(LCP<2.5s 예산), WT-M5-01b
//
// HeroMap.tsx(WorldMap + d3-geo/topojson/geo-index 의존)를 React.lazy(() => import('./HeroMap'))
// 청크로 분리한 뒤 HomePage가 Suspense fallback으로 쓰는 컴포넌트. HeroMap 청크 자체가 아직
// 도착하지 않은 상태에도, HeroMap 내부가 지도 위상 데이터(countries-110m.json) fetch 중일 때
// 보여주는 상태(index===null)와 **완전히 동일한 마크업**(같은 className·data-testid)을 렌더한다
// — 두 "로딩 중" 단계 사이에 아무 시각적 차이도 없어야 청크 도착 시점의 스왑이 레이아웃 시프트
// 없이 매끈하다(HeroMap.tsx의 placeholder는 일부러 이 컴포넌트를 재사용하지 않고 자체
// 유지한다 — 이미 그린 HeroMap.test.tsx/HomePage.test.tsx가 이 두 testid를 동기적으로
// 검증하므로, 마크업이 어긋나면 즉시 회귀로 드러난다).
export function HeroMapPlaceholder() {
  return (
    <div className="wt-home-hero__map" data-testid="hero-map">
      <div className="wt-home-hero__map-placeholder" data-testid="hero-map-loading" />
    </div>
  );
}
