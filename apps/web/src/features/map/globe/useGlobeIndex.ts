// spec: docs/03 §3.1·§3.7(GlobeIndex 구축)·§4.4(훅 배치), 00 §11-D67, WT-DC-08.
//
// GamePage(S5–S7)가 지구본을 배경으로 항상 마운트하기 위한 GlobeIndex 로더. useWorldGeoIndex와
// 동형 — 부팅 데이터(getBootData) + topology fetch(loadTopology, geo-index/globe 공용 캐시)를
// 1회 수행하고, 실패(부팅 미적재·fetch 오류)해도 null로 안전 폴백한다(지도는 juice 배경일 뿐이라
// 로딩 실패해도 타이핑 게임은 성립해야 한다 — useWorldGeoIndex 주석과 동일 계약).
import { useEffect, useState } from 'react';
import { getBootData } from '../../../app/bootLoader';
import { loadTopology } from '../topology-loader';
import { buildGlobeIndex, type GlobeIndex } from './globe-index';

export function useGlobeIndex(): GlobeIndex | null {
  const [index, setIndex] = useState<GlobeIndex | null>(null);

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
        setIndex(buildGlobeIndex(topology, countries.countries));
      })
      .catch(() => {
        if (!cancelled) setIndex(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return index;
}
