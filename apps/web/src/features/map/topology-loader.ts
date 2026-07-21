// spec: docs/03 §3.1(GeoIndex — world-atlas countries-110m.json 파싱 원천), §8.2(에셋 로딩 —
//       config.mapUrl), WT-M2-06
//
// bootLoader(§4.1)는 countries.json만 적재하고 지도 위상 데이터(countries-110m.json)는 적재하지
// 않는다(§3.1은 GameSessionEngine 배정과 무관한 렌더 전용 자산이라 별도 지연 로드가 맞다) — 이
// 모듈이 그 fetch를 1회만 수행해 모듈 스코프에 캐싱한다(bootLoader.ts의 캐시 패턴과 동일).
import type { TopologyLike } from './geo-index';

let cached: TopologyLike | null = null;
let inflight: Promise<TopologyLike> | null = null;

/** mapUrl(config.mapUrl)의 world-atlas topology JSON을 1회만 fetch·캐싱한다. */
export async function loadTopology(mapUrl: string): Promise<TopologyLike> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch(mapUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`topology fetch failed: ${res.status} ${mapUrl}`);
        return res.json();
      })
      .then((json) => {
        cached = json as TopologyLike;
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 테스트 전용: 모듈 캐시 리셋. */
export function __resetTopologyCacheForTests(): void {
  cached = null;
  inflight = null;
}
