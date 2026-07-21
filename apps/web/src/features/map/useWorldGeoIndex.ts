// spec: docs/03 §3.1(GeoIndex 구축), §4.4(훅 배치), WT-M2-06
//
// GamePage(S5–S7)가 지도를 배경으로 항상 마운트하기 위한 GeoIndex 로더. topology fetch는
// 비동기라 첫 렌더에는 null을 반환한다 — WorldMap은 index가 준비된 이후에만 마운트한다
// (§3.2 계약: WorldMap은 마운트 후 리렌더 0이므로 로딩 완료 전에 마운트하지 않는다).
import { useEffect, useState } from 'react';
import { getBootData } from '../../app/bootLoader';
import { buildGeoIndex, type GeoIndex } from './geo-index';
import { loadTopology } from './topology-loader';

export function useWorldGeoIndex(): GeoIndex | null {
  const [index, setIndex] = useState<GeoIndex | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { config, countries } = getBootData();
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
