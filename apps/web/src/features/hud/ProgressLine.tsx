// spec: docs/01 §10.2(S6 "●─●─●─●─◉─○─○─○─○─○ … 12/45  다음: 폴란드  [ESC 스킵]"), docs/03 §4.2
//       (ProgressLine — 노선 진행바 + 다음 국가 미리보기), WT-M2-06.
//
// currentIndex는 국가 전환 단위 빈도(§4.5가 명시 허용)라 React state/prop으로 받는다 — 고빈도
// 값이 아니므로 이 컴포넌트는 통상적인 React 리렌더로 충분하다(국가당 최대 1회).
import { useTranslation } from 'react-i18next';
import type { CountryId } from '@wt/shared';

export interface ProgressLineProps {
  countryIds: readonly CountryId[];
  currentIndex: number;
  /** countries[currentIndex+1]의 표시명(lang에 맞춰 호출부가 미리 골라 넘긴다). null이면 마지막 국가. */
  nextCountryName: string | null;
}

export function ProgressLine({ countryIds, currentIndex, nextCountryName }: ProgressLineProps) {
  const { t } = useTranslation();
  const total = countryIds.length;

  return (
    <div className="wt-progress-line" data-testid="progress-line">
      <div className="wt-progress-line__dots" aria-hidden="true">
        {countryIds.map((id, i) => (
          <span key={id} className={dotClassName(i, currentIndex)} />
        ))}
      </div>
      <span className="wt-progress-line__count" data-testid="progress-count">
        {t('game.progress', { current: Math.min(currentIndex + 1, total), total })}
      </span>
      {nextCountryName != null && (
        <span className="wt-progress-line__next" data-testid="progress-next">
          {t('hud.next', { country: nextCountryName })}
        </span>
      )}
      <span className="wt-progress-line__skip" data-testid="progress-skip-hint">
        {t('hud.skipHint')}
      </span>
    </div>
  );
}

function dotClassName(i: number, currentIndex: number): string {
  if (i < currentIndex) return 'wt-dot wt-dot--done';
  if (i === currentIndex) return 'wt-dot wt-dot--current';
  return 'wt-dot wt-dot--pending';
}
