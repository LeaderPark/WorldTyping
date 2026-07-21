// spec: docs/03 §4.4(useCountries 시그니처 — byId/route), docs/00 §11-D2(세계일주 50)·
//       §11-D21(랭킹 걸린 세트는 서버 salt 확정 — M3 전까지 로컬 결정적 플레이스홀더), WT-M2-06
//
// countries.json 접근 + "모드·trackId → 출제 순서" 단일 원천. routes.ts(대륙/세계일주 고정 콘텐츠)와
// 티어/데일리 로컬 결정적 셔플(mulberry32, Math.random 금지 — gotcha #5)을 여기 한 곳에 모아
// useGameSession(엔진 배정)과 ProgressLine 등 표시 계층(§4.2 컴포넌트 트리)이 동일한 원천을
// 공유하게 한다. race는 멀티 전용이라 이 훅에서도 거부한다(useMultiplayer 소관, M4).
//
// [범위 주의] 티어/데일리는 서버 salt 확정 설계(§11-D21, M3의 /runs/start·/daily)의 로컬
// 플레이스홀더다 — 문자열 시드(FNV-1a) → mulberry32로 결정적 세트를 만든다.
import { useCallback, useMemo } from 'react';
import {
  mulberry32,
  seededShuffle,
  type Country,
  type CountryId,
  type GameMode,
} from '@wt/shared';
import { CONTINENT_ROUTES, ROUTE_WORLD_TOUR } from '@wt/data/content/routes';
import { getBootData } from '../../app/bootLoader';

/** 랭킹 대상 밖(extended) 국가 — 티어/데일리 로컬 풀에서 제외(§11-D1). */
const EXTENDED_IDS = new Set<CountryId>(['TW', 'XK', 'EH']);
const TIER_SET_SIZE = 20;
const DAILY_SET_SIZE = 20;

/** 문자열 → 부호 없는 32-bit 시드(결정적). mulberry32 초기값 파생용(로컬 플레이스홀더). */
function seedFromString(s: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface UseCountriesResult {
  /** id → Country. 배정 밖의(존재하지 않는) id로 호출하면 throw(계약 위반 — 호출자는 route()가
   *  준 id로만 조회한다는 전제). */
  byId(id: CountryId): Country;
  /** (mode, trackId) → 출제 순서. continent/worldtour는 routes.ts 고정 순서 그대로(데이터셋
   *  존재 여부와 무관하게 전체 id를 반환 — 필터링은 호출자 책임), tier/daily는 데이터셋에서
   *  결정적으로 셔플한 세트. race는 멀티 전용이라 throw. */
  route(mode: GameMode, trackId: string): CountryId[];
}

export function useCountries(): UseCountriesResult {
  const dataset = useMemo(() => getBootData().countries.countries, []);
  const byIdMap = useMemo(() => new Map(dataset.map((c) => [c.id, c] as const)), [dataset]);

  const byId = useCallback(
    (id: CountryId): Country => {
      const c = byIdMap.get(id);
      if (!c) throw new Error(`useCountries: unknown country id "${id}" (배정 밖 조회 — 계약 위반)`);
      return c;
    },
    [byIdMap],
  );

  const route = useCallback(
    (mode: GameMode, trackId: string): CountryId[] => {
      switch (mode) {
        case 'continent': {
          const r = CONTINENT_ROUTES[trackId as keyof typeof CONTINENT_ROUTES];
          if (!r) throw new Error(`useCountries: unknown continent trackId "${trackId}"`);
          return [...r];
        }
        case 'worldtour':
          return [...ROUTE_WORLD_TOUR];
        case 'tier': {
          const tier = Number(trackId);
          const pool = dataset
            .filter((c) => !EXTENDED_IDS.has(c.id) && c.difficultyTier === tier)
            .map((c) => c.id);
          return seededShuffle(pool, mulberry32(seedFromString(`tier:${trackId}`))).slice(
            0,
            TIER_SET_SIZE,
          );
        }
        case 'daily': {
          const dateKey = new Date().toISOString().slice(0, 10);
          const pool = dataset.filter((c) => !EXTENDED_IDS.has(c.id)).map((c) => c.id);
          return seededShuffle(pool, mulberry32(seedFromString(`daily:${dateKey}`))).slice(
            0,
            DAILY_SET_SIZE,
          );
        }
        case 'race':
          throw new Error('useCountries: race는 멀티 전용이다 — useMultiplayer를 사용하라(M4).');
      }
    },
    [dataset],
  );

  return { byId, route };
}
