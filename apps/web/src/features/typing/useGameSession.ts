// spec: docs/03 §4.4(useGameSession 시그니처), §5.1(엔진 생명주기), docs/00 §11-D2(worldtour 50),
//       §11-D5·D21(티어/데일리 세트는 서버 salt로 생성 — M3). WT-M2-03/WT-M2-06/WT-M3-06.
//
// 세션 생성·파괴, 엔진↔스토어 배선. GamePage 최상단에서 1회 호출한다(엔진은 프레임워크 독립 —
// @wt/engine). 출제 순서 산출은 useCountries(§4.4, WT-M2-06)에 위임해 엔진 배정과 ProgressLine 등
// 표시 계층이 동일한 원천을 공유하게 한다(순서 불일치 방지). 여기서는 route() id 중 실제
// countries.json에 존재하는 것만 걸러 엔진에 넘긴다(픽스처/부분 데이터셋 방어).
//
// [WT-M3-06] 티어/데일리는 useRunStart(net/run-session.ts)가 확정한 서버 세트가 도착하기 전까지
// 로컬 플레이스홀더(useCountries의 결정적 셔플)로 엔진을 잠시 채워둔다(GameSessionEngine 생성자가
// 빈 배열을 거부하므로 non-null 계약을 지키기 위함) — 실제 플레이 개시는 BoardingPass가
// runStart.status==='ready'가 될 때까지 CTA를 잠가 막는다(GamePage 소관). 대륙/세계일주는 로컬
// 세트가 서버와 결정적으로 항상 동일해(set-builder.ts) 로컬 세트를 그대로 쓰고, runStart는
// runToken 확보 용도로만 병행한다.
import { useCallback, useEffect, useMemo } from 'react';
import {
  GameSessionEngine,
  createModeRules,
  type EngineDeps,
} from '@wt/engine';
import type { Country, CountryId, GameMode } from '@wt/shared';
import { getBootData } from '../../app/bootLoader';
import { useSettingsStore } from '../../stores/settings';
import { useRunStart, SERVER_SET_MODES, type RunStartState } from '../../net/run-session';
import { useCountries } from './useCountries';

export interface UseGameSessionResult {
  engine: GameSessionEngine;
  /** 엔진에 실제로 배정된 국가 목록(순서 = 출제 순서). ProgressLine/지도 배선이 공유한다. */
  countries: readonly Country[];
  /** runs/start 배선 상태(runToken·티어/데일리 서버 세트 준비 여부) — BoardingPass/ResultView가 소비. */
  runStart: RunStartState;
  start(): void;
  retry(): void;
  abort(): void;
}

function realDeps(rules: ReturnType<typeof createModeRules>): EngineDeps {
  return {
    now: () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    schedule: (cb, ms) => {
      const id = setTimeout(cb, ms);
      return () => clearTimeout(id);
    },
    rules,
  };
}

export function useGameSession(opts: { mode: GameMode; trackId: string }): UseGameSessionResult {
  const lang = useSettingsStore((s) => s.lang);
  const platform = useSettingsStore((s) => s.platform);
  const guestId = useSettingsStore((s) => s.guestId);
  const { route } = useCountries();
  const runStart = useRunStart({ mode: opts.mode, trackId: opts.trackId, lang, platform, guestId });

  const localCountryIds = useMemo<CountryId[]>(() => {
    try {
      return route(opts.mode, opts.trackId);
    } catch {
      return []; // 존재하지 않는 trackId 등 — 아래 engine useMemo가 throw로 계약을 지킨다.
    }
  }, [opts.mode, opts.trackId, route]);

  const countryIds = useMemo<CountryId[]>(() => {
    if (SERVER_SET_MODES.has(opts.mode) && runStart.status === 'ready' && runStart.countryIds) {
      return runStart.countryIds; // 티어/데일리: 서버 확정 세트로 교체(§11-D21).
    }
    return localCountryIds;
  }, [opts.mode, runStart.status, runStart.countryIds, localCountryIds]);

  const countries = useMemo<Country[]>(() => {
    const dataset = getBootData().countries.countries;
    const byId = new Map(dataset.map((c) => [c.id, c] as const));
    return countryIds.map((id) => byId.get(id)).filter((c): c is Country => c !== undefined);
  }, [countryIds]);

  const engine = useMemo(() => {
    if (countries.length === 0) {
      throw new Error(
        `useGameSession: no countries resolved for mode=${opts.mode} trackId=${opts.trackId}`,
      );
    }
    const rules = createModeRules(opts.mode, lang);
    return new GameSessionEngine(realDeps(rules), countries, lang);
  }, [countries, lang, opts.mode, opts.trackId]);

  // 세션 교체/언마운트 시 진행 중이던 타이머를 확실히 해제(abort는 idle/finished에서 no-op).
  useEffect(() => () => engine.abort(), [engine]);

  const start = useCallback(() => engine.start(), [engine]);
  const retry = useCallback(() => engine.retry(), [engine]);
  const abort = useCallback(() => engine.abort(), [engine]);

  return { engine, countries, runStart, start, retry, abort };
}
