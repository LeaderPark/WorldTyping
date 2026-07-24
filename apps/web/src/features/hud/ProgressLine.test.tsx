// @vitest-environment jsdom
//
// spec: docs/03 §4.2(ProgressLine)·§6.3(ack 고스트)·WT-M5-04(ghost 마커), WT-UI-03(앱바 이설 —
// 대륙색 레일 채움 추가, testid/시맨틱 불변). 도트 세그먼트·특수 마커 testid·진행 카운트를 검증.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CountryId } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { ProgressLine } from './ProgressLine';

const IDS = ['CO', 'VE', 'GY', 'SR', 'BR', 'PY', 'UY', 'AR', 'CL', 'BO'] as unknown as CountryId[];

afterEach(() => cleanup());

function renderLine(props: Partial<React.ComponentProps<typeof ProgressLine>> = {}) {
  return render(
    <AppProviders>
      <ProgressLine countryIds={IDS} currentIndex={2} {...props} />
    </AppProviders>,
  );
}

describe('ProgressLine (WT-UI-03)', () => {
  it('progressbar 시맨틱과 진행 카운트를 유지한다', () => {
    renderLine();
    const bar = screen.getByTestId('progress-line');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(IDS.length));
    expect(screen.getByTestId('progress-count').textContent).toBe(`3 / ${IDS.length}`);
  });

  it('국가 수만큼 도트 세그먼트를 그리고 done/current 클래스를 매긴다', () => {
    const { container } = renderLine({ currentIndex: 2 });
    const dots = container.querySelectorAll('.wt-dot');
    expect(dots.length).toBe(IDS.length);
    expect(container.querySelectorAll('.wt-dot--done').length).toBe(2); // index 0,1
    expect(container.querySelectorAll('.wt-dot--current').length).toBe(1); // index 2
  });

  it('대륙색 레일 채움 폭이 currentIndex에 비례한다', () => {
    const { container } = renderLine({ currentIndex: 0 });
    const fill = container.querySelector('.wt-progress-line__rail-fill') as HTMLElement;
    expect(fill.style.width).toBe('0%');
    cleanup();
    const { container: c2 } = renderLine({ currentIndex: IDS.length - 1 });
    const fill2 = c2.querySelector('.wt-progress-line__rail-fill') as HTMLElement;
    expect(fill2.style.width).toBe('100%');
  });

  it('ack/ghost 마커 testid를 해당 인덱스 도트에 부착한다(시맨틱 불변)', () => {
    renderLine({ currentIndex: 2, ackIndex: 4, ghostIndex: 6 });
    expect(screen.getByTestId('progress-ack-ghost')).toBeInTheDocument();
    expect(screen.getByTestId('progress-ghost-marker')).toBeInTheDocument();
    expect(screen.getByTestId('progress-ack-ghost').classList.contains('wt-dot--ack-ghost')).toBe(true);
    expect(screen.getByTestId('progress-ghost-marker').classList.contains('wt-dot--self-ghost')).toBe(true);
  });
});
