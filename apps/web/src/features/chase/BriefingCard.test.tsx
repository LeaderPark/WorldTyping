// @vitest-environment jsdom
//
// spec: docs/09 §7.1(브리핑 카드)·§8.1(온보딩), docs/03 §7.2(동기 focus 계약), WT-CH-08,
//       docs/00 §11-D111 ①("게임 방법" 5항목 — 첫 진입 펼침 / 이후 디스클로저 토글, WT-CH-DEV-2)
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

  it('첫 진입에는 "게임 방법" 5항목이 펼쳐진 상태로 보인다(아이콘+제목+본문, §11-D111 ①)', () => {
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    const panel = screen.getByTestId('chase-howto-panel');
    expect(panel).toBeVisible();
    const items = panel.querySelectorAll('.wt-chase-howto__item');
    expect(items).toHaveLength(5);
    for (const item of Array.from(items)) {
      expect(item.querySelector('.wt-chase-howto__icon')).not.toBeNull();
      expect((item.querySelector('.wt-chase-howto__item-title')?.textContent ?? '').length).toBeGreaterThan(0);
      expect((item.querySelector('.wt-chase-howto__item-body')?.textContent ?? '').length).toBeGreaterThan(10);
    }
    expect(screen.getByTestId('chase-howto-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('첫 노출 시 플래그를 남기고, 다음 진입에는 접힌 토글로 시작한다', () => {
    const first = render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    expect(localStorage.getItem('wt:chase:howtoSeen')).toBe('1');
    first.unmount();

    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-howto-panel')).not.toBeVisible();
    expect(screen.getByTestId('chase-howto-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('토글로 언제든 다시 펼치고 접을 수 있다(aria-expanded/aria-controls 동기화)', () => {
    localStorage.setItem('wt:chase:howtoSeen', '1');
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={vi.fn()} onStart={vi.fn()} />
      </AppProviders>,
    );
    const toggle = screen.getByTestId('chase-howto-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // 접힘 상태에서도 aria-controls는 실재하는 패널 id를 가리킨다(보조기술 관계 유지).
    const panel = screen.getByTestId('chase-howto-panel');
    expect(panel.id).toBe(toggle.getAttribute('aria-controls'));
    expect(panel).not.toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toBeVisible();
  });

  it('안내 토글은 게임을 시작시키지 않는다(START 계약 불변 — 카드 클릭만 depart)', () => {
    const focusInput = vi.fn();
    const onStart = vi.fn();
    render(
      <AppProviders>
        <BriefingCard homeName="대한민국" focusInput={focusInput} onStart={onStart} />
      </AppProviders>,
    );
    fireEvent.click(screen.getByTestId('chase-howto-toggle'));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(focusInput).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    // 안내가 펼쳐져 있어도 START(카드)는 항상 접근 가능하다.
    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    expect(focusInput).toHaveBeenCalledTimes(1);
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
