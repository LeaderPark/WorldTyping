// spec: docs/01 §10.2(S6 상단 HUD — 나가기·모드/트랙명·진행·정확도·설정), docs/03 §4.2(HUD 구성)·
//       §4.5(고빈도 값 규약 — 정확도는 React state 금지, statsTick 구독 → textContent 직접). WT-UI-03.
//
// 원작 METRO TYPING S6의 상단 앱바 이식: [나가기][모드/트랙명] … [진행바(ProgressLine 이설)] …
// [♥ 라이프][정확도][설정]. 나가기는 라우터 navigate('/')로 GamePage의 이탈 확인 블로커(useBlocker)를
// 그대로 발동한다(별도 계약 추가 없음). 정확도(hud-acc)는 statsTick 이벤트로 textContent만 갱신한다.
//
// data-testid="hud-bar": 비상호작용 영역 탭 시 hidden input 포커스 유지 계약(E8)의 탭 타깃 —
// 가로 중앙은 항상 진행바(비상호작용)라 버튼을 누르지 않는다.
import { useEffect, useRef } from 'react';
import type { CSSProperties, RefCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { EngineEvent, GameSessionEngine } from '@wt/engine';
import type { Continent, CountryId } from '@wt/shared';
import { formatPercent } from '../../lib/format';
import { ProgressLine } from './ProgressLine';
import { ThemeToggle } from '../auth/ThemeToggle';

export interface GameAppBarProps {
  engine: GameSessionEngine;
  /** 모드·트랙 표시명(route-label의 describeRouteLabel 산출 — 호출부에서 조립해 넘긴다). */
  title: string;
  /** 진행바 대륙색(구간 바 채움). null이면 중립색 폴백. */
  continent: Continent | null;
  countryIds: readonly CountryId[];
  currentIndex: number;
  /** null이면 라이프 없는 모드(대륙/레이스) — 하트 숨김. */
  lives: number | null;
  ackIndex?: number | null;
  ghostIndex?: number | null;
  /** WT-DC-04(②): 하트 요소 ref 바인딩 — 생명 손실 시 GameView가 WAAPI로 바운스/색을 구동한다.
   *  라이프 없는 모드(하트 미렌더)면 호출되지 않는다. */
  bindLivesEl?: RefCallback<HTMLElement>;
}

export function GameAppBar({
  engine,
  title,
  continent,
  countryIds,
  currentIndex,
  lives,
  ackIndex = null,
  ghostIndex = null,
  bindLivesEl,
}: GameAppBarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const accRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const accEl = accRef.current;
    if (accEl) accEl.textContent = t('hud.accuracy', { accuracy: 100 });
    const onEvent = (e: EngineEvent): void => {
      if (e.type !== 'statsTick') return;
      if (accEl) accEl.textContent = t('hud.accuracy', { accuracy: formatPercent(e.acc) });
    };
    return engine.subscribe(onEvent);
  }, [engine, t]);

  return (
    <header className="wt-appbar wt-appbar-game" data-testid="hud-bar">
      <div className="wt-appbar__left">
        <button
          type="button"
          className="wt-appbar__exit"
          aria-label={t('game.confirmLeave.leave')}
          onClick={() => navigate('/')}
        >
          <span aria-hidden="true">⏻</span>
        </button>
        <span className="wt-appbar__title" title={title}>
          {title}
        </span>
      </div>

      <div
        className="wt-appbar__center"
        style={{ '--wt-progress-continent': continent ? `var(--continent-${continent})` : 'var(--grade-c)' } as CSSProperties}
      >
        <ProgressLine
          countryIds={countryIds}
          currentIndex={currentIndex}
          ackIndex={ackIndex}
          ghostIndex={ghostIndex}
        />
      </div>

      <div className="wt-appbar__right">
        {lives !== null && (
          <span
            ref={bindLivesEl}
            className="wt-appbar__lives"
            data-testid="hud-lives"
            aria-label={t('hud.lives', { count: lives })}
          >
            {'♥'.repeat(Math.max(0, lives))}
          </span>
        )}
        <span className="wt-appbar__acc" aria-hidden="true">
          🎯
        </span>
        <span ref={accRef} className="wt-appbar__acc-value" data-testid="hud-acc" />
        <ThemeToggle className="wt-appbar__settings" />
      </div>
    </header>
  );
}
