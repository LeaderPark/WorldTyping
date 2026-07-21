// @vitest-environment jsdom
//
// spec: docs/03 §4.4(useGameClock — bindTimerEl/bindGaugeEl), §4.5(rAF 루프에서 DOM 직접 갱신,
//       React state 미경유). WT-M2-03.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import {
  GameSessionEngine,
  continentRules,
  tierRules,
  type EngineDeps,
  type ModeRules,
} from '@wt/engine';
import type { Country } from '@wt/shared';
import { useGameClock } from './useGameClock';

const COUNTRY: Country = {
  id: 'GH', iso3: 'GHA', nameKo: '가나', nameEn: 'ghana', aliasesKo: [], aliasesEn: [],
  continent: 'africa', subregion: '', difficultyTier: 3, capitalKo: '', capitalEn: '',
  flagEmoji: '🏳️', population: 0, latlng: [0, 0], mapFeatureId: null,
  acceptedInputsKo: ['가나'], acceptedInputsEn: ['ghana'],
};

let rafCb: (() => void) | null = null;
let pnow = 0;

function makeEngine(rules: ModeRules) {
  let t = 0;
  const timers: { cb: () => void; at: number }[] = [];
  const deps: EngineDeps = {
    now: () => t,
    schedule: (cb, ms) => {
      const rec = { cb, at: t + ms };
      timers.push(rec);
      return () => {
        const i = timers.indexOf(rec);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    rules,
  };
  function advance(ms: number) {
    t += ms;
    for (;;) {
      const idx = timers.findIndex((x) => x.at <= t);
      if (idx < 0) break;
      const [rec] = timers.splice(idx, 1);
      rec!.cb();
    }
  }
  return { engine: new GameSessionEngine(deps, [COUNTRY], 'ko'), advance };
}

function ClockHarness({ engine }: { engine: GameSessionEngine }) {
  const { bindTimerEl, bindGaugeEl } = useGameClock(engine);
  const timerRef = useRef<HTMLSpanElement | null>(null);
  const gaugeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    bindTimerEl(timerRef.current);
    bindGaugeEl(gaugeRef.current);
    engine.start();
    return () => engine.abort();
  }, [engine, bindTimerEl, bindGaugeEl]);
  return (
    <div>
      <span data-testid="timer" ref={timerRef} />
      <span data-testid="gauge" ref={gaugeRef} />
    </div>
  );
}

beforeEach(() => {
  rafCb = null;
  pnow = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => pnow);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useGameClock', () => {
  it('제한 없는 모드: rAF tick에서 타이머 textContent + 게이지 100% 갱신', () => {
    const { engine, advance } = makeEngine(continentRules());
    const { getByTestId } = render(<ClockHarness engine={engine} />);
    act(() => advance(3000)); // 카운트다운 → playing + countryShown
    expect(rafCb).toBeTypeOf('function');
    act(() => rafCb!());
    expect(getByTestId('timer').textContent).toBe('0:00');
    expect((getByTestId('gauge') as HTMLElement).style.width).toBe('100%');
  });

  it('제한 있는 모드: 게이지가 잔여 시간 비율로 좁아진다(shownAt 기준)', () => {
    const { engine, advance } = makeEngine(tierRules('ko'));
    const { getByTestId } = render(<ClockHarness engine={engine} />);
    act(() => advance(3000)); // shownAt = performance.now() = 1000 시점 기록
    const gauge = getByTestId('gauge') as HTMLElement;

    act(() => rafCb!()); // pnow===shownAt → 잔여 100%
    expect(gauge.style.width).toBe('100%');

    pnow = 1_000_000_000; // shownAt 훨씬 이후 → 잔여 0%로 클램프
    act(() => rafCb!());
    expect(gauge.style.width).toBe('0%');
  });

  it('phase가 playing을 벗어나면(abort) 루프를 정지한다', () => {
    const { engine, advance } = makeEngine(continentRules());
    render(<ClockHarness engine={engine} />);
    act(() => advance(3000));
    expect(rafCb).toBeTypeOf('function'); // playing 동안 예약됨
    act(() => engine.abort()); // phase='aborted' → stop() → cancelAnimationFrame
    expect(rafCb).toBeNull();
  });
});
