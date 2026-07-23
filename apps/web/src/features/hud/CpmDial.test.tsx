// @vitest-environment jsdom
//
// spec: docs/03 §4.5(CPM은 React state 금지 — statsTick 구독 → DOM 직접 갱신), WT-UI-03. 바늘 회전이
// style.transform으로만 갱신되고(React 리렌더 없음) 0~800으로 클램프되는지, 중앙 수치(hud-cpm)가
// 실제 CPM으로 갱신되는지 검증한다.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import { AppProviders } from '../../app/providers';
import { CpmDial } from './CpmDial';

function makeStubEngine() {
  const listeners = new Set<(e: EngineEvent) => void>();
  const engine = {
    subscribe: (fn: (e: EngineEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => ({ combo: 0, phase: 'playing' }),
  } as unknown as GameSessionEngine;
  const emitStats = (cpm: number): void => {
    act(() => {
      listeners.forEach((l) => l({ type: 'statsTick', cpm, acc: 1, elapsedMs: 0 }));
    });
  };
  return { engine, emitStats };
}

afterEach(() => cleanup());

describe('CpmDial (WT-UI-03)', () => {
  it('초기값은 0이고 바늘은 좌측 끝(-90deg)을 가리킨다', () => {
    const { engine } = makeStubEngine();
    const { container } = render(
      <AppProviders>
        <CpmDial engine={engine} />
      </AppProviders>,
    );
    expect(screen.getByTestId('hud-cpm').textContent).toBe('0');
    const needle = container.querySelector('.wt-dial__needle') as HTMLElement;
    expect(needle.style.transform).toBe('rotate(-90.0deg)');
  });

  it('statsTick마다 수치·바늘을 DOM으로 직접 갱신한다(400→중앙 0deg, 800→우측 +90deg)', () => {
    const { engine, emitStats } = makeStubEngine();
    const { container } = render(
      <AppProviders>
        <CpmDial engine={engine} />
      </AppProviders>,
    );
    const needle = container.querySelector('.wt-dial__needle') as HTMLElement;

    emitStats(400);
    expect(screen.getByTestId('hud-cpm').textContent).toBe('400');
    expect(needle.style.transform).toBe('rotate(0.0deg)');

    emitStats(800);
    expect(screen.getByTestId('hud-cpm').textContent).toBe('800');
    expect(needle.style.transform).toBe('rotate(90.0deg)');
  });

  it('800 초과 CPM은 바늘을 +90deg로 클램프하되 수치는 실제값을 표시한다', () => {
    const { engine, emitStats } = makeStubEngine();
    const { container } = render(
      <AppProviders>
        <CpmDial engine={engine} />
      </AppProviders>,
    );
    const needle = container.querySelector('.wt-dial__needle') as HTMLElement;
    emitStats(1000);
    expect(needle.style.transform).toBe('rotate(90.0deg)');
    expect(screen.getByTestId('hud-cpm').textContent).toBe('1000');
  });
});
