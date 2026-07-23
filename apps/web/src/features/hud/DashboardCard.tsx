// spec: docs/01 §10.2(S6 — 운행/비행시간+CPM), docs/03 §4.2(부유 대시보드)·§4.4(useGameClock
//       bindTimerEl)·§4.5(고빈도 값 규약). WT-UI-03.
//
// 지도 무대 위에 떠 있는 부유 카드. CpmDial(바늘 실시간) + 비행시간(bindTimerEl이 rAF로 textContent
// 갱신) + (레이스 한정)하드캡 카운트다운 슬롯을 담는다. 고빈도 값은 전부 자식/바인딩이 DOM 직접
// 갱신하므로 이 컴포넌트 자체는 국가 전환에도 리렌더가 필요 없다(bindTimerEl/race는 안정 참조).
import type { RefCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameSessionEngine } from '@wt/engine';
import { CpmDial } from './CpmDial';

export interface DashboardCardProps {
  engine: GameSessionEngine;
  /** useGameClock().bindTimerEl — 비행시간 요소를 rAF 루프에 연결. */
  bindTimerEl: RefCallback<HTMLElement>;
  /** 레이스 하드캡 카운트다운 바인딩(멀티 전용). 없으면 슬롯 미표시. */
  bindHardCapEl?: RefCallback<HTMLElement>;
}

export function DashboardCard({ engine, bindTimerEl, bindHardCapEl }: DashboardCardProps) {
  const { t } = useTranslation();
  return (
    <div className="wt-dashboard" data-testid="dashboard-card">
      <CpmDial engine={engine} />
      <div className="wt-dashboard__divider" aria-hidden="true" />
      <div className="wt-dashboard__timer">
        <span className="wt-dashboard__timer-label">{t('dial.time.label')}</span>
        <span ref={bindTimerEl} className="wt-dashboard__timer-value" data-testid="hud-timer" />
      </div>
      {bindHardCapEl && (
        <div className="wt-race-hardcap" data-testid="race-hardcap">
          <span ref={bindHardCapEl} data-testid="race-hardcap-time" />
        </div>
      )}
    </div>
  );
}
