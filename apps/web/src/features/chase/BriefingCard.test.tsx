// @vitest-environment jsdom
//
// spec: docs/09 §7.1(브리핑 카드)·§8.1(온보딩 1회 규칙 요약), docs/03 §7.2(동기 focus 계약), WT-CH-08
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { BriefingCard } from './BriefingCard';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BriefingCard', () => {
  it('미션 텍스트에 홈 국가명을 보간해 렌더한다', () => {
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-briefing-mission').textContent).toContain('대한민국');
  });

  it('첫 노출(localStorage 플래그 없음)에서는 3줄 규칙 요약을 보여준다', () => {
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-briefing-rules')).toBeInTheDocument();
  });

  it('이미 본 적 있으면(localStorage 플래그) 규칙 요약을 숨긴다', () => {
    localStorage.setItem('wt:onboarding:chaseBriefingSeen', '1');
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    expect(screen.queryByTestId('chase-briefing-rules')).not.toBeInTheDocument();
  });

  it('카드 클릭 시 동기적으로 focusInput을 호출하고, 스탬프 낙하 후 onStart를 호출한다', () => {
    const focusInput = vi.fn();
    const onStart = vi.fn();
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={focusInput} onStart={onStart} />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    expect(focusInput).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('locked이면 클릭해도 시작하지 않는다(서버 시드/그래프 로딩 중)', () => {
    const focusInput = vi.fn();
    const onStart = vi.fn();
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" locked focusInput={focusInput} onStart={onStart} />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(focusInput).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('Enter/Space 키로도 depart를 트리거한다', () => {
    const focusInput = vi.fn();
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={focusInput} onStart={vi.fn()} />
      </AppProviders>,
    );
    fireEvent.keyDown(screen.getByTestId('chase-briefing-card'), { key: 'Enter' });
    expect(focusInput).toHaveBeenCalledTimes(1);
  });
});
