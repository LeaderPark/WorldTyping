// spec: docs/05 §4.2(S2C_Start — countries/startAt/hardCapAt), §6.2("공평한 출발"), docs/03
//       §4.2("race variant는 GameView 재사용")·§6.3(countdown.startAt − offset 로컬 출발, ±80ms
//       목표), docs/00 §11-D7, WT-M4-04
//
// RaceView가 소비할 로컬 GameSessionEngine을 store의 raceReplay(캐시된 최신 start/race-sync)로
// 구성한다. 판정·규칙 로직은 전혀 재구현하지 않는다 — @wt/engine(GameSessionEngine, createModeRules
// ('race', ...))를 그대로 재사용한다(useGameSession.ts와 동일한 패턴, REST 세트 대신 서버가 WS로
// 이미 확정해 보낸 countries를 쓴다는 점만 다르다).
//
// [로컬 출발 동기화] engine.start()는 항상 자신의 COUNTDOWN_MS(3s) 뒤에 playing으로 전이한다
// (session.ts, 싱글/레이스 공통 — 재구현하지 않는다). 서버 countdown은 그보다 길 수 있으므로(GDD
// §8.2 "카운트다운 5초"), engine.start() 호출 자체를 `localStartPerf − COUNTDOWN_MS` 시점으로
// 스케줄링해 engine의 3초 뒤 playing 전이가 정확히 localStartPerf(서버 startAt − offset)에
// 맞아떨어지게 한다 — engine.start()의 내부 타이밍 상수를 건드리지 않고도 서버 권위 출발 시각과
// 정합한다.
import { useEffect, useMemo, useState } from 'react';
import { COUNTDOWN_MS, GameSessionEngine, createModeRules } from '@wt/engine';
import type { Country } from '@wt/shared';
import { getBootData } from '../../../app/bootLoader';
import { extractRaceStart, type RaceReplayMessage } from '../../../stores/multiplayer';

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface UseRaceSessionResult {
  engine: GameSessionEngine | null;
  countries: readonly Country[];
  hardCapAt: number | null;
}

export function useRaceSession(replay: RaceReplayMessage | null, lang: 'ko' | 'en', getOffsetMs: () => number): UseRaceSessionResult {
  const start = useMemo(() => (replay ? extractRaceStart(replay) : null), [replay]);

  const countries = useMemo<Country[]>(() => {
    if (!start) return [];
    const dataset = getBootData().countries.countries;
    const byId = new Map(dataset.map((c) => [c.id, c] as const));
    return start.countries.map((id) => byId.get(id)).filter((c): c is Country => c !== undefined);
  }, [start]);

  const engine = useMemo(() => {
    if (countries.length === 0) return null;
    const rules = createModeRules('race', lang);
    const deps = {
      now: () =>
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now(),
      schedule: (cb: () => void, ms: number) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      },
      rules,
    };
    return new GameSessionEngine(deps, countries, lang);
  }, [countries, lang]);

  useEffect(() => () => engine?.abort(), [engine]);

  // 위 파일 상단 주석의 로컬 출발 스케줄링. start.startAt이 바뀌면(리매치 등) 재스케줄한다.
  const startAt = start?.startAt ?? null;
  useEffect(() => {
    if (!engine || startAt === null) return;
    const localStartPerf = startAt - getOffsetMs();
    const delayMs = Math.max(0, localStartPerf - COUNTDOWN_MS - now());
    const id = setTimeout(() => engine.start(), delayMs);
    return () => clearTimeout(id);
    // getOffsetMs는 의도적으로 의존성에서 제외한다 — engine/startAt이 바뀔 때만 재스케줄하며,
    // 그 시점의 offset 스냅샷으로 충분하다(§6.1: 30ms 미만 변화는 유지되는 값이라 재스케줄해도
    // 실익이 없고, 오히려 재귀적 재스케줄로 출발 시각이 계속 미뤄지는 쪽이 더 위험하다).
  }, [engine, startAt]);

  const [hardCapAt, setHardCapAt] = useState<number | null>(start?.hardCapAt ?? null);
  useEffect(() => {
    setHardCapAt(start?.hardCapAt ?? null);
  }, [start?.hardCapAt]);

  return { engine, countries, hardCapAt };
}
