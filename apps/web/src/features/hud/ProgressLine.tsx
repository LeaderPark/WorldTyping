// spec: docs/01 §10.2(S6 "●─●─●─●─◉─○─○─○─○─○ … 12/45  다음: 폴란드  [ESC 스킵]"), docs/03 §4.2
//       (ProgressLine — 노선 진행바 + 다음 국가 미리보기)·§6.3(서버 ack 고스트 이중 표시), WT-M2-06,
//       WT-M4-04(ackIndex 추가 — 멀티 레이스 진행바에 서버 확인 위치를 얇은 반투명 링으로 겹쳐
//       표시. "정상 상태에선 두 개가 겹쳐 보인다" — §6.3).
//
// currentIndex는 국가 전환 단위 빈도(§4.5가 명시 허용)라 React state/prop으로 받는다 — 고빈도
// 값이 아니므로 이 컴포넌트는 통상적인 React 리렌더로 충분하다(국가당 최대 1회). ackIndex도
// country-accepted 수신 시(서버 왕복당 최대 1회)만 바뀌는 저빈도 값이라 동일하게 prop으로 받는다.
import { useTranslation } from 'react-i18next';
import type { CountryId } from '@wt/shared';

export interface ProgressLineProps {
  countryIds: readonly CountryId[];
  currentIndex: number;
  /** countries[currentIndex+1]의 표시명(lang에 맞춰 호출부가 미리 골라 넘긴다). null이면 마지막 국가. */
  nextCountryName: string | null;
  /** 멀티 전용(§6.3): 서버가 마지막으로 확인(country-accepted)한 인덱스. null/undefined면 미표시. */
  ackIndex?: number | null;
}

export function ProgressLine({ countryIds, currentIndex, nextCountryName, ackIndex = null }: ProgressLineProps) {
  const { t } = useTranslation();
  const total = countryIds.length;

  return (
    <div className="wt-progress-line" data-testid="progress-line">
      <div className="wt-progress-line__dots" aria-hidden="true">
        {countryIds.map((id, i) => (
          <span key={id} className={dotClassName(i, currentIndex, ackIndex)} data-testid={i === ackIndex ? 'progress-ack-ghost' : undefined} />
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

function dotClassName(i: number, currentIndex: number, ackIndex: number | null): string {
  const base = i < currentIndex ? 'wt-dot wt-dot--done' : i === currentIndex ? 'wt-dot wt-dot--current' : 'wt-dot wt-dot--pending';
  return i === ackIndex ? `${base} wt-dot--ack-ghost` : base;
}
