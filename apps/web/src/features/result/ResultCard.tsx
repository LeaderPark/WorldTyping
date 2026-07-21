// spec: docs/01 §10.2(S7 결과 카드 전문), §13.2(등급색 S/A/B/C/D), §13.3-6(완주 리트레이스 →
//       "이 리트레이스 장면이 공유 카드의 정지 컷"). WT-M2-06.
// [공유 캡처 범위 주의] 이 컴포넌트는 결과 카드의 레이아웃만 담당한다 — 이미지 캡처/공유 로직은
// M5 소관(산출물 목록 주석 그대로). 여기서는 공유 버튼을 렌더하지 않는다(호출부 ResultView가
// 액션 행을 별도로 구성한다).
import { useTranslation } from 'react-i18next';
import type { Grade } from '@wt/shared';
import { formatCpm, formatPercent, formatSeconds } from '../../lib/format';

export interface ResultCardProps {
  routeLabel: string;
  grade: Grade;
  finalScore: number;
  pi: number;
  elapsedMs: number;
  cpm: number;
  /** 0~1 비율. */
  accuracy: number;
  maxCombo: number;
  completed: boolean;
  mostMistyped: { name: string; count: number } | null;
  /** 국가별 소요 ms(구간 그래프 근사 — docs/01 §10.2 "구간 그래프: CPM 추이 스파크라인"의
   *  경량 대체. 값이 작을수록(빠를수록) 막대가 짧다). */
  paceMs: readonly number[];
}

export function ResultCard({
  routeLabel,
  grade,
  finalScore,
  pi,
  elapsedMs,
  cpm,
  accuracy,
  maxCombo,
  completed,
  mostMistyped,
  paceMs,
}: ResultCardProps) {
  const { t } = useTranslation();
  const maxPace = paceMs.length > 0 ? Math.max(...paceMs) : 0;

  return (
    <div className="wt-result-card" data-testid="result-card">
      <p className="wt-result-card__route">
        {completed ? t('result.routeComplete', { route: routeLabel }) : t('result.outcome.gameover')}
      </p>
      <p className={`wt-result-card__grade wt-grade--${grade}`} data-testid="result-grade">
        {t('result.grade', { grade })}
      </p>
      <p className="wt-result-card__score">
        {t('result.score', { score: finalScore })} · {t('result.pi', { pi })}
      </p>
      <p className="wt-result-card__stats">
        <span>{t('result.time', { seconds: formatSeconds(elapsedMs) })}</span>
        <span>{t('result.cpm', { cpm: formatCpm(cpm) })}</span>
        <span>{t('result.accuracy', { accuracy: formatPercent(accuracy) })}</span>
        <span>{t('result.streak', { count: maxCombo })}</span>
      </p>

      {paceMs.length > 1 && (
        <div className="wt-result-card__pace" data-testid="result-pace" aria-hidden="true">
          {paceMs.map((ms, i) => (
            <span
              key={i}
              className="wt-result-card__pace-bar"
              style={{ height: maxPace > 0 ? `${Math.max(8, (ms / maxPace) * 100)}%` : '8%' }}
            />
          ))}
        </div>
      )}

      {mostMistyped && (
        <p className="wt-result-card__mistyped">
          {t('result.mostMistyped', { country: mostMistyped.name, count: mostMistyped.count })}
        </p>
      )}
    </div>
  );
}
