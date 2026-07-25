// @vitest-environment jsdom
//
// spec: docs/09 §7.4·§8.6(수배 별 HUD 해부도 — 노드 고정)·§8.10(a11y), WT-CH-06 acceptance
// ("슬림 HUD 별 노드 고정", "a11y 공지").
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine } from '@wt/engine';
import { AppProviders } from '../../app/providers';
import { WantedHud } from './WantedHud';

function makeStubEngine(carriedCount = 0) {
  const listeners = new Set<(e: ChaseEngineEvent) => void>();
  let carried = carriedCount;
  const engine = {
    subscribe: (fn: (e: ChaseEngineEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => ({ carriedCount: carried }),
  } as unknown as ChaseSessionEngine;
  const emit = (e: ChaseEngineEvent): void => {
    act(() => listeners.forEach((l) => l(e)));
  };
  return {
    engine,
    emit,
    setCarried: (n: number) => {
      carried = n;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WantedHud — 별 노드 고정(§8.6)', () => {
  it('마운트 시 별 5개 노드를 고정 생성한다(추가/삭제 없음)', () => {
    const { engine } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    const stars = screen.getByTestId('chase-hud-stars').querySelectorAll('.wt-wanted-hud__star');
    expect(stars).toHaveLength(5);
  });

  it('wantedChanged(★3)에 정확히 3개 노드만 is-lit 클래스를 갖는다', () => {
    const { engine, emit } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    emit({ type: 'wantedChanged', stars: 3, direction: 'up' });

    const stars = Array.from(screen.getByTestId('chase-hud-stars').querySelectorAll('.wt-wanted-hud__star'));
    const lit = stars.filter((s) => s.classList.contains('is-lit'));
    expect(lit).toHaveLength(3);
  });

  it('노드 개수는 별 상승/하강을 반복해도 항상 5개(리플로우 방지 — 노드 재생성 없음)', () => {
    const { engine, emit } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    const starsContainer = screen.getByTestId('chase-hud-stars');
    const before = starsContainer.querySelectorAll('.wt-wanted-hud__star');
    emit({ type: 'wantedChanged', stars: 2, direction: 'up' });
    emit({ type: 'wantedChanged', stars: 5, direction: 'up' });
    emit({ type: 'wantedChanged', stars: 1, direction: 'down' });
    const after = starsContainer.querySelectorAll('.wt-wanted-hud__star');
    expect(after).toHaveLength(5);
    expect(after[0]).toBe(before[0]);
  });
});

describe('WantedHud — 저빈도 텍스트 갱신(§4.5)', () => {
  it('statsTick으로 시간/CPM/ACC 텍스트를 갱신한다', () => {
    const { engine, emit } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    emit({ type: 'statsTick', cpm: 320, acc: 0.95, elapsedMs: 65_000 });

    expect(screen.getByTestId('chase-hud-time')).toHaveTextContent('1:05');
    expect(screen.getByTestId('chase-hud-cpm')).toHaveTextContent('320');
    expect(screen.getByTestId('chase-hud-acc')).toHaveTextContent('95%');
  });

  it('delivered로 배송 누적 점수·금 가방 카운터를 갱신한다', () => {
    const { engine, emit, setCarried } = makeStubEngine(0);
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    setCarried(0);
    emit({ type: 'delivered', count: 2, payout: 1500, starsAfter: 1 });

    expect(screen.getByTestId('chase-hud-score')).toHaveTextContent('1500');
    expect(screen.getByTestId('chase-hud-gold')).toHaveTextContent('💰×0');
  });

  it('goldPicked로 금 가방 카운터를 갱신한다', () => {
    const { engine, emit, setCarried } = makeStubEngine(0);
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    setCarried(2);
    emit({ type: 'goldPicked', at: 'JP', ring: 'near' });

    expect(screen.getByTestId('chase-hud-gold')).toHaveTextContent('💰×2');
  });
});

describe('WantedHud — a11y 공지(§8.10)', () => {
  it('wantedChanged(up)을 aria-live 영역에 공지한다', () => {
    const { engine, emit } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    emit({ type: 'wantedChanged', stars: 2, direction: 'up' });
    const announcer = screen.getByTestId('chase-hud-announcer');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer.textContent).not.toBe('');
  });

  it('delivered를 aria-live 영역에 공지한다', () => {
    const { engine, emit } = makeStubEngine();
    render(
      <AppProviders>
        <WantedHud engine={engine} />
      </AppProviders>,
    );
    emit({ type: 'delivered', count: 1, payout: 800, starsAfter: 0 });
    expect(screen.getByTestId('chase-hud-announcer').textContent).not.toBe('');
  });
});
