// spec: docs/01 §10.2(S6 "●─●─●─●─◉─○─○─○─○─○ … 12/45  다음: 폴란드  [ESC 스킵]"), docs/03 §4.2
//       (ProgressLine — 노선 진행바 + 다음 국가 미리보기)·§6.3(서버 ack 고스트 이중 표시), WT-M2-06,
//       WT-M4-04(ackIndex 추가 — 멀티 레이스 진행바에 서버 확인 위치를 얇은 반투명 링으로 겹쳐
//       표시. "정상 상태에선 두 개가 겹쳐 보인다" — §6.3), WT-M5-04(ghostIndex — 싱글 자기 최고
//       기록 고스트 마커. features/typing/ghost.ts의 useGhostProgress가 고스트 완료 시각마다
//       1회씩만 넘겨주는 값이라 ackIndex와 동일한 빈도 등급이다. 레이스에선 쓰지 않는다),
//       WT-UI-03(원작 상단 앱바에 이설 — 도트를 대륙색 구간 레일 위 세그먼트로 재배치. props·
//       testid·ackIndex/ghostIndex 시맨틱 전부 불변; 시각만 앱바용 얇은 바로).
//
// currentIndex는 국가 전환 단위 빈도(§4.5가 명시 허용)라 React state/prop으로 받는다 — 고빈도
// 값이 아니므로 이 컴포넌트는 통상적인 React 리렌더로 충분하다(국가당 최대 1회). ackIndex도
// country-accepted 수신 시(서버 왕복당 최대 1회)만 바뀌는 저빈도 값이라 동일하게 prop으로 받는다.
// 대륙색은 앵커(GameAppBar)가 --wt-progress-continent CSS 변수로 내려준다(prop 확장 없이 색만 주입).
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { CountryId } from '@wt/shared';

export interface ProgressLineProps {
  countryIds: readonly CountryId[];
  currentIndex: number;
  /** 멀티 전용(§6.3): 서버가 마지막으로 확인(country-accepted)한 인덱스. null/undefined면 미표시. */
  ackIndex?: number | null;
  /** 싱글 전용(§9.3, WT-M5-04): 자기 최고 기록 고스트가 현재 위치한 인덱스. null/undefined면
   *  미표시(미언락·토글 off·저장된 고스트 없음 전부 이 경우). */
  ghostIndex?: number | null;
}

export function ProgressLine({
  countryIds,
  currentIndex,
  ackIndex = null,
  ghostIndex = null,
}: ProgressLineProps) {
  const { t } = useTranslation();
  const total = countryIds.length;
  // 대륙색 구간 바 채움 비율(마지막 국가 도달 시 100%). 국가 전환 단위 값이라 인라인 style 갱신 OK.
  const pct =
    total <= 1
      ? currentIndex >= total - 1
        ? 100
        : 0
      : Math.min(100, Math.max(0, (currentIndex / (total - 1)) * 100));

  return (
    <div
      className="wt-progress-line"
      data-testid="progress-line"
      role="progressbar"
      aria-label={t('hud.progressLabel')}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={Math.min(currentIndex + 1, total)}
      aria-valuetext={t('game.progress', { current: Math.min(currentIndex + 1, total), total })}
    >
      {/* 대륙색 구간 레일 + 도트 세그먼트를 한 트랙에 겹쳐 얹는다(§10.2 진행바). */}
      <div className="wt-progress-line__rail" aria-hidden="true">
        <span className="wt-progress-line__rail-fill" style={{ width: `${pct}%` } as CSSProperties} />
        <div className="wt-progress-line__dots">
          {countryIds.map((id, i) => (
            <span
              key={id}
              className={dotClassName(i, currentIndex, ackIndex, ghostIndex)}
              data-testid={
                i === ackIndex ? 'progress-ack-ghost' : i === ghostIndex ? 'progress-ghost-marker' : undefined
              }
            />
          ))}
        </div>
      </div>
      <span className="wt-progress-line__count" data-testid="progress-count">
        {t('game.progress', { current: Math.min(currentIndex + 1, total), total })}
      </span>
      <span className="wt-progress-line__skip" data-testid="progress-skip-hint">
        {t('hud.skipHint')}
      </span>
    </div>
  );
}

function dotClassName(i: number, currentIndex: number, ackIndex: number | null, ghostIndex: number | null): string {
  const base = i < currentIndex ? 'wt-dot wt-dot--done' : i === currentIndex ? 'wt-dot wt-dot--current' : 'wt-dot wt-dot--pending';
  const withAck = i === ackIndex ? `${base} wt-dot--ack-ghost` : base;
  return i === ghostIndex ? `${withAck} wt-dot--self-ghost` : withAck;
}
