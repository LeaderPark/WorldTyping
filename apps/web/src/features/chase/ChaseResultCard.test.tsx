// @vitest-environment jsdom
//
// spec: docs/09 §7.7(결과 카드 6종 통계), WT-CH-08
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/providers';
import { ChaseResultCard } from './ChaseResultCard';

afterEach(() => cleanup());

const baseProps = {
  grade: 'A' as const,
  finalScore: 12480,
  pi: 950,
  survivalMs: 192_000,
  fledDistanceKm: 8340,
  maxStars: 4,
  deliveredCount: 3,
  deliveredPayout: 4200,
  maxCombo: 12,
  cpm: 480,
  accuracy: 0.97,
  outcome: 'resigned' as const,
};

describe('ChaseResultCard', () => {
  it('현상금·등급·6종 통계 행을 렌더한다', () => {
    render(
      <AppProviders>
        <ChaseResultCard {...baseProps} />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-result-bounty').textContent).toContain('12480');
    const stats = screen.getByTestId('chase-result-stats').textContent ?? '';
    expect(stats).toContain('8340');
    expect(stats).toContain('4');
    expect(stats).toContain('3');
    expect(stats).toContain('4200');
    expect(stats).toContain('12');
  });

  it('체포(outcome=arrested)면 ARRESTED 헤드라인 + 체포 상세를 보여준다', () => {
    render(
      <AppProviders>
        <ChaseResultCard
          {...baseProps}
          outcome="arrested"
          arrestedBy="chaser"
          arrestedCountryName="대한민국"
        />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-result-card').textContent).toContain('ARRESTED');
    expect(screen.getByTestId('chase-result-arrest-detail').textContent).toContain('대한민국');
  });

  it('자수(outcome=resigned)면 체포 상세를 렌더하지 않는다', () => {
    render(
      <AppProviders>
        <ChaseResultCard {...baseProps} />
      </AppProviders>,
    );
    expect(screen.queryByTestId('chase-result-arrest-detail')).not.toBeInTheDocument();
  });

  it('등급별 프레임 클래스(wt-result-card--{grade})를 그대로 재사용한다', () => {
    render(
      <AppProviders>
        <ChaseResultCard {...baseProps} grade="S" />
      </AppProviders>,
    );
    expect(screen.getByTestId('chase-result-card').className).toContain('wt-result-card--S');
  });
});
