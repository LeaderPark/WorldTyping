// spec: docs/01 §10.2(S1 홈 — "인터랙티브 세계지도, 대륙 호버 시 노선색 점등"), docs/03 §3.2
//       (WorldMapHandle 계약)·§3.6(리렌더 0), docs/00 §11-D45(홈 히어로 lazy 전환), WT-M2-07
//       구현 세부 지시 1, WT-M5-01b.
//
// [구현 세부 지시 1] "핸들 setTarget 유사 API 추가 없이 base 레이어 class 토글로" — 이 컴포넌트는
// WorldMapHandle에 새 메서드를 추가하지 않는다. WorldMap이 base 레이어에 렌더한 `[data-country]`
// path/circle을 pointerover/pointerout 이벤트 위임으로 직접 조회해 classList/style 커스텀
// 프로퍼티만 토글한다 — React 리렌더도, 지도 컴포넌트 수정도 없다(§3.6 계약 그대로 유지).
//
// [WT-M5-01b] HomePage가 이 모듈을 React.lazy(() => import('./HeroMap'))로 로드한다(D45) —
// 이 파일이 d3-geo/topojson-client를 끌어오는 WorldMap/useWorldGeoIndex를 정적 import하는
// 유일한 진입점이라, 동적 import 경계를 여기 두면 entry 그래프에서 vendor-geo가 완전히
// 빠진다. named export는 HeroMap.test.tsx가 직접(lazy 없이) 렌더하는 데 계속 쓰고, default
// export는 오직 React.lazy용이다 — 둘의 런타임 동작은 동일하다.
import { useEffect, useMemo, useRef } from 'react';
import type { Continent, CountryId } from '@wt/shared';
import { CONTINENT_ROUTES } from '@wt/data/content/routes';
import { WorldMap } from '../../features/map/WorldMap';
import { useWorldGeoIndex } from '../../features/map/useWorldGeoIndex';

const LIT_CLASS = 'wt-map__country--hero-lit';

function buildCountryToContinent(): Map<CountryId, Continent> {
  const map = new Map<CountryId, Continent>();
  for (const [continent, ids] of Object.entries(CONTINENT_ROUTES) as [Continent, CountryId[]][]) {
    for (const id of ids) map.set(id, continent);
  }
  return map;
}

export function HeroMap() {
  const index = useWorldGeoIndex();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const countryToContinent = useMemo(buildCountryToContinent, []);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const litFor = (el: Element): Continent | undefined => {
      const id = el.getAttribute('data-country');
      return id ? countryToContinent.get(id) : undefined;
    };

    const onOver = (ev: Event): void => {
      const target = (ev.target as Element).closest('[data-country]');
      const continent = target ? litFor(target) : undefined;
      if (!continent) return;
      const base = root.querySelector('[data-layer="base"]');
      if (!base) return;
      for (const el of base.querySelectorAll<HTMLElement>('[data-country]')) {
        if (litFor(el) === continent) {
          el.classList.add(LIT_CLASS);
          el.style.setProperty('--continent-color', `var(--continent-${continent})`);
        }
      }
    };

    const onOut = (): void => {
      for (const el of root.querySelectorAll<HTMLElement>(`.${LIT_CLASS}`)) {
        el.classList.remove(LIT_CLASS);
      }
    };

    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
    };
  }, [countryToContinent]);

  return (
    <div ref={containerRef} className="wt-home-hero__map" data-testid="hero-map">
      {index ? (
        <WorldMap index={index} className="wt-home-hero__map-svg" />
      ) : (
        <div className="wt-home-hero__map-placeholder" data-testid="hero-map-loading" />
      )}
    </div>
  );
}

// React.lazy(() => import('./HeroMap'))는 default export를 요구한다(WT-M5-01b, D45).
export default HeroMap;
