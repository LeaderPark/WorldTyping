// @vitest-environment jsdom
//
// spec: docs/01 §11.1(온보딩 2단계 — 첫 1~3국가 툴팁 + 첫 EXACT 토스트 1회), WT-M2-07
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypingEvent, TypingInputController } from '@wt/engine';
import type { MatchDetail } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { FirstRunTips } from './FirstRunTips';

const DUMMY_DETAIL = {} as unknown as MatchDetail;

function fakeController(): { controller: TypingInputController; emit: (e: TypingEvent) => void } {
  let listener: ((e: TypingEvent) => void) | null = null;
  const controller = {
    subscribe: (fn: (e: TypingEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  } as unknown as TypingInputController;
  return { controller, emit: (e) => listener?.(e) };
}

beforeEach(() => {
  localStorage.clear();
  useMetaStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FirstRunTips', () => {
  it('완주 기록이 있으면 아무것도 렌더하지 않는다', () => {
    useMetaStore.getState().addStamp('continent:asia');
    const { controller } = fakeController();
    render(<AppProviders><FirstRunTips controller={controller} currentIndex={0} /></AppProviders>);
    expect(screen.queryByTestId('onboarding-tooltip')).not.toBeInTheDocument();
  });

  it('첫 판(완주 기록 없음)의 1~3번째 국가(index 0~2)에서 툴팁을 보여준다', () => {
    const { controller } = fakeController();
    const { rerender } = render(<AppProviders><FirstRunTips controller={controller} currentIndex={0} /></AppProviders>);
    expect(screen.getByTestId('onboarding-tooltip')).toBeInTheDocument();

    rerender(<AppProviders><FirstRunTips controller={controller} currentIndex={2} /></AppProviders>);
    expect(screen.getByTestId('onboarding-tooltip')).toBeInTheDocument();

    rerender(<AppProviders><FirstRunTips controller={controller} currentIndex={3} /></AppProviders>);
    expect(screen.queryByTestId('onboarding-tooltip')).not.toBeInTheDocument();
  });

  it('첫 EXACT 이벤트에서 토스트를 1회 보여주고 localStorage 플래그를 남긴다', () => {
    vi.useFakeTimers();
    const { controller, emit } = fakeController();
    render(<AppProviders><FirstRunTips controller={controller} currentIndex={0} /></AppProviders>);
    expect(screen.queryByTestId('onboarding-toast')).not.toBeInTheDocument();

    act(() => {
      emit({
        type: 'exact',
        detail: DUMMY_DETAIL,
        delta: { added: 1, removed: 0, addedCorrect: 1, addedError: 0 },
        elapsedFromShownMs: 500,
      });
    });

    expect(screen.getByTestId('onboarding-toast')).toBeInTheDocument();
    expect(localStorage.getItem('wt:onboarding:autoAdvanceSeen')).toBe('1');

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId('onboarding-toast')).not.toBeInTheDocument();
  });

  it('플래그가 이미 세워져 있으면 다시 EXACT가 와도 토스트를 띄우지 않는다', () => {
    localStorage.setItem('wt:onboarding:autoAdvanceSeen', '1');
    const { controller, emit } = fakeController();
    render(<AppProviders><FirstRunTips controller={controller} currentIndex={0} /></AppProviders>);

    act(() => {
      emit({
        type: 'exact',
        detail: DUMMY_DETAIL,
        delta: { added: 1, removed: 0, addedCorrect: 1, addedError: 0 },
        elapsedFromShownMs: 500,
      });
    });
    expect(screen.queryByTestId('onboarding-toast')).not.toBeInTheDocument();
  });
});
