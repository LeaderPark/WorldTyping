// spec: docs/00 §11-D45(lazy 청크 경계는 즉시 페인트되는 경량 플레이스홀더가 LCP 요소가 되도록
//       설계 — HomeGlobe에도 동일 원칙 적용)·D67-⑦·D68-⑦, docs/03 §3.7, WT-AUTH-07(이 태스크).
//
// HomeGlobe.tsx(GlobeMap+d3-geo/topojson-client 의존, vendor-geo 청크)를
// React.lazy(() => import('./HomeGlobe'))로 분리한 뒤 HomePage가 Suspense fallback으로 쓰는
// 컴포넌트. HomeGlobe 청크 자체가 아직 도착하지 않은 상태에도, HomeGlobe 내부가 지구본 인덱스
// (useGlobeIndex — topology fetch) 대기 중일 때 보여주는 상태(index===null)와 **완전히 동일한
// 마크업**(같은 className·data-testid)을 렌더한다 — 두 "로딩 중" 단계 사이에 시각적 차이가
// 없어야 청크 도착 시점의 스왑이 레이아웃 시프트 없이 매끈하다(HeroMap.tsx/HeroMapPlaceholder.tsx
// 의 동일 패턴 — D45).
export function HomeGlobePlaceholder(): JSX.Element {
  return (
    <div className="wt-home__globe" aria-hidden="true" data-testid="home-globe">
      <div className="wt-home__globe-placeholder" data-testid="home-globe-loading" />
    </div>
  );
}
