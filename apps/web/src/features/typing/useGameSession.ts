// spec: docs/03 §4.4(useGameSession 시그니처), §5.1(엔진 생명주기), docs/00 §11-D2(worldtour 50),
//       §11-D5·D21(티어/데일리 세트는 서버 salt로 생성 — M3). WT-M2-03.
//
// 세션 생성·파괴, 엔진↔스토어 배선. GamePage 최상단에서 1회 호출한다(엔진은 프레임워크 독립 —
// @wt/engine). 여기서는 (mode, trackId)로 출제 국가를 확정해 엔진을 만들고 start/retry/abort만
// 노출한다. Date.now/performance.now는 엔진에 주입(deps)만 하고 직접 호출하지 않는다(§5.1).
//
// [범위 주의] 랭킹 걸린 티어/데일리 세트는 서버가 salt로 생성·배포하는 것이 확정 설계다(§11-D5·D21,
// M3의 /runs/start·/daily). M3 이전인 지금은 결정적 로컬 플레이스홀더(mulberry32)로 채운다 —
// Math.random은 금지(gotcha #5). 대륙/세계일주는 고정 콘텐츠 라우트라 그대로 확정이다.
import { useCallback, useEffect, useMemo } from 'react';
import {
  GameSessionEngine,
  createModeRules,
  type EngineDeps,
} from '@wt/engine';
import {
  mulberry32,
  seededShuffle,
  type Continent,
  type Country,
  type CountryId,
  type GameMode,
} from '@wt/shared';
import { CONTINENT_ROUTES, ROUTE_WORLD_TOUR } from '@wt/data/content/routes';
import { getBootData } from '../../app/bootLoader';
import { useSettingsStore } from '../../stores/settings';

export interface UseGameSessionResult {
  engine: GameSessionEngine;
  start(): void;
  retry(): void;
  abort(): void;
}

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

function resolveCountryIds(
  mode: GameMode,
  trackId: string,
  dataset: readonly Country[],
): CountryId[] {
  switch (mode) {
    case 'continent': {
      const route = CONTINENT_ROUTES[trackId as Continent];
      if (!route) throw new Error(`useGameSession: unknown continent trackId "${trackId}"`);
      return [...route];
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
      throw new Error('useGameSession: race는 멀티 전용이다 — useMultiplayer를 사용하라(M4).');
  }
}

function realDeps(mode: GameMode, lang: 'ko' | 'en'): EngineDeps {
  return {
    now: () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    schedule: (cb, ms) => {
      const id = setTimeout(cb, ms);
      return () => clearTimeout(id);
    },
    rules: createModeRules(mode, lang),
  };
}

export function useGameSession(opts: { mode: GameMode; trackId: string }): UseGameSessionResult {
  const lang = useSettingsStore((s) => s.lang);

  const engine = useMemo(() => {
    const dataset = getBootData().countries.countries;
    const byId = new Map(dataset.map((c) => [c.id, c] as const));
    const ids = resolveCountryIds(opts.mode, opts.trackId, dataset);
    const countries = ids
      .map((id) => byId.get(id))
      .filter((c): c is Country => c !== undefined);
    if (countries.length === 0) {
      throw new Error(
        `useGameSession: no countries resolved for mode=${opts.mode} trackId=${opts.trackId}`,
      );
    }
    return new GameSessionEngine(realDeps(opts.mode, lang), countries, lang);
  }, [opts.mode, opts.trackId, lang]);

  // 세션 교체/언마운트 시 진행 중이던 타이머를 확실히 해제(abort는 idle/finished에서 no-op).
  useEffect(() => () => engine.abort(), [engine]);

  const start = useCallback(() => engine.start(), [engine]);
  const retry = useCallback(() => engine.retry(), [engine]);
  const abort = useCallback(() => engine.abort(), [engine]);

  return { engine, start, retry, abort };
}
