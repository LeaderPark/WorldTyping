// spec: docs/03 §3.1(GeoIndex 구축), §4.4(훅 배치), WT-M2-06, WT-M2-07(HomePage 히어로 지도 재사용)
//
// GamePage(S5–S7)가 지도를 배경으로 항상 마운트하기 위한 GeoIndex 로더. topology fetch는
// 비동기라 첫 렌더에는 null을 반환한다 — WorldMap은 index가 준비된 이후에만 마운트한다
// (§3.2 계약: WorldMap은 마운트 후 리렌더 0이므로 로딩 완료 전에 마운트하지 않는다).
//
// [WT-M2-07 방어 추가] HomePage 히어로도 이 훅을 재사용한다(구현 세부 지시 1). HomePage는
// 루트 loader(bootLoader) 없이 렌더되는 경로도 있다(app/router.test.tsx가 classic
// <MemoryRouter>로 loader 없이 홈을 직접 마운트) — getBootData()가 부팅 캐시 미적재 시 throw하는
// 계약(bootLoader.ts 주석)을 이 훅이 삼키지 않으면 그 기존 스모크 테스트가 깨진다. 지도는 애초에
// juice 배경일 뿐이라 "부팅 데이터 없음"도 "fetch 실패"와 동일하게 null로 안전 폴백한다.
import { useEffect, useState } from 'react';
import { getBootData } from '../../app/bootLoader';
import { buildGeoIndex, type GeoIndex } from './geo-index';
import { loadTopology } from './topology-loader';

export function useWorldGeoIndex(): GeoIndex | null {
  const [index, setIndex] = useState<GeoIndex | null>(null);

  useEffect(() => {
    let cancelled = false;
    let boot;
    try {
      boot = getBootData();
    } catch {
      setIndex(null);
      return;
    }
    const { config, countries } = boot;
    loadTopology(config.mapUrl)
      .then((topology) => {
        if (cancelled) return;
        setIndex(buildGeoIndex(topology, countries.countries));
      })
      .catch(() => {
        // 지도는 juice 전용 배경이다 — 로딩 실패해도 게임(타이핑)은 계속 성립해야 한다.
        if (!cancelled) setIndex(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return index;
}
