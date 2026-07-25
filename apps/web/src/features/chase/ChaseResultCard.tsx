// spec: docs/09-chase-mode-goldrunner.md §7.7(결과 카드 — 현상금·통계 행 6종·등급 스탬프 기존
//       문법), docs/00 §11-D92(등급 예외), WT-CH-08.
//
// features/result/ResultCard.tsx와 완전히 동일한 프레임 클래스(wt-card wt-result-card wt-result-
// card--{grade})를 재사용한다 — CSS는 손대지 않고(신규 CSS 없음), 등급 스탬프·카드 톤·바코드 장식을
// 그대로 물려받는다(§7.7 "기존 결과 카드 프레임 재사용 + chase 전용 스킨"). computeChaseScore/
// gradeChase의 결과값만 조립해 표시하는 순수 프레젠테이션 컴포넌트 — 점수/등급 재계산 없음
// (Gotcha 3, 호출부 ChaseGameRoot.tsx가 @wt/shared computeChaseScore를 1회 호출해 넘긴다).
import { useTranslation } from 'react-i18next';
import type { Grade, PoliceKind } from '@wt/shared';
import { formatCpm, formatMMSS, formatPercent } from '../../lib/format';

export interface ChaseResultCardProps {
  grade: Grade;
  finalScore: number;
  pi: number;
  /** 생존 시간(런 로컬 ms — 카운트다운 종료~체포/자수 확정). */
  survivalMs: number;
  /** 도주 거리 합산(km) — 방문 경로 인접 구간의 chase-graph 사전 계산 정수 km 합. */
  fledDistanceKm: number;
  /** 이 런에서 도달한 최고 수배 별(events의 starChanged.to 최댓값). */
  maxStars: number;
  deliveredCount: number;
  deliveredPayout: number;
  maxCombo: number;
  cpm: number;
  /** 0~1 비율. */
  accuracy: number;
  outcome: 'arrested' | 'resigned';
  arrestedBy?: PoliceKind;
  /** 체포된 국가의 현지화 표시명(localized nameKo/nameEn) — outcome==='arrested'일 때만 의미. */
  arrestedCountryName?: string;
}

const ARREST_KIND_KEY: Record<PoliceKind, string> = {
  chaser: 'chase.arrest.byChaser',
  interceptor: 'chase.arrest.byInterceptor',
  heli: 'chase.arrest.byHeli',
};

export function ChaseResultCard({
  grade,
  finalScore,
  pi,
  survivalMs,
  fledDistanceKm,
  maxStars,
  deliveredCount,
  deliveredPayout,
  maxCombo,
  cpm,
  accuracy,
  outcome,
  arrestedBy,
  arrestedCountryName,
}: ChaseResultCardProps) {
  const { t } = useTranslation();

  return (
    <div className={`wt-card wt-result-card wt-result-card--${grade}`} data-testid="chase-result-card">
      <p className="wt-result-card__route">
        {outcome === 'arrested'
          ? t('chase.arrest.stamp')
          : t('chase.mode.title')}
      </p>

      {outcome === 'arrested' && arrestedBy && arrestedCountryName && (
        <p className="wt-result-card__mistyped" data-testid="chase-result-arrest-detail">
          {t(ARREST_KIND_KEY[arrestedBy])} · {t('chase.arrest.caughtIn', { country: arrestedCountryName })}
        </p>
      )}

      <p className="wt-result-card__grade" data-testid="result-grade">
        {t('result.grade', { grade })}
      </p>

      <p className="wt-result-card__score" data-testid="chase-result-bounty">
        {t('chase.result.bounty', { score: finalScore })} · {t('result.pi', { pi })}
      </p>

      <p className="wt-result-card__stats" data-testid="chase-result-stats">
        <span>{t('chase.result.survivalTime', { time: formatMMSS(survivalMs) })}</span>
        <span>{t('chase.result.fledDistance', { km: fledDistanceKm })}</span>
        <span>{t('chase.result.maxStars', { stars: maxStars })}</span>
        <span>{t('chase.result.delivered', { count: deliveredCount, payout: deliveredPayout })}</span>
        <span>{t('result.streak', { count: maxCombo })}</span>
        <span>{t('result.cpm', { cpm: formatCpm(cpm) })}</span>
        <span>{t('result.accuracy', { accuracy: formatPercent(accuracy) })}</span>
      </p>

      <span className="wt-result-card__barcode" aria-hidden="true" />
    </div>
  );
}
