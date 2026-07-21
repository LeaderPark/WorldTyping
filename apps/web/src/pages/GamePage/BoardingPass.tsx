// spec: docs/01 §10.2(S5 보딩패스 전문 — "탭 → 개찰기 통과 애니메이션(200ms) → 3·2·1"),
//       docs/03 §4.2(BoardingPass, phase: idle)·§7.2(iOS 동기 focus 계약), WT-M2-06.
//
// 탭/스페이스 → hidden input 동기 focus(§7.2, 반드시 이 핸들러 안에서 동기 호출) → 200ms 개찰
// 애니메이션 → engine.start(). 애니메이션 동안에도 이 컴포넌트는 그대로 마운트돼 있다(phase는
// engine.start() 호출 시점에야 countdown으로 바뀌므로).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { requiredKeystrokes, type Country, type GameMode } from '@wt/shared';
import { formatMMSS } from '../../lib/format';
import { describeRouteLabel, ruleTypeKey } from './route-label';

export interface BoardingPassProps {
  mode: GameMode;
  trackId: string;
  countries: readonly Country[];
  lang: 'ko' | 'en';
  nickname: string;
  guestId: string;
  start(): void;
  focusInput(): void;
  /** 티어/데일리가 서버 세트(POST /runs/start) 응답을 기다리는 동안 CTA를 잠근다(WT-M3-06
   *  구현 세부 지시 1 — 서버 세트 없이는 시작 불가). 보통 수십ms 내 해제된다. */
  locked?: boolean;
}

/** GDD §10.2 "카드가 개찰기 통과 애니메이션(200ms)" — 이 시간만큼 start()를 지연시켜 펀칭
 *  연출을 화면에 완주시킨다. */
const PUNCH_MS = 200;

export function BoardingPass({
  mode,
  trackId,
  countries,
  lang,
  nickname,
  guestId,
  start,
  focusInput,
  locked = false,
}: BoardingPassProps) {
  const { t } = useTranslation();
  const [punching, setPunching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const depart = useCallback(() => {
    if (punching || locked) return;
    // 반드시 이 동기 핸들러 안에서 focus — setTimeout 뒤로 미루면 iOS가 소프트키보드를 열지 않는다.
    focusInput();
    setPunching(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      start();
    }, PUNCH_MS);
  }, [punching, locked, focusInput, start]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        depart();
      }
    },
    [depart],
  );

  const totalKeystrokes = useMemo(
    () => countries.reduce((sum, c) => sum + requiredKeystrokes(c, lang), 0),
    [countries, lang],
  );
  const parMs = (totalKeystrokes / 3.5) * 1000;

  const routeLabel = describeRouteLabel(mode, trackId, countries.length, t);
  const ruleType = t(ruleTypeKey(mode));
  const displayName = nickname || `GUEST_${guestId.slice(0, 4).toUpperCase()}`;

  return (
    <div className="wt-boarding" data-testid="boarding-pass">
      <div
        className={`wt-boarding__card${punching ? ' wt-boarding__card--punch' : ''}${locked ? ' wt-boarding__card--locked' : ''}`}
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-disabled={locked}
        aria-label={t('boarding.cta')}
        data-testid="boarding-card"
        data-locked={locked}
        onClick={depart}
        onKeyDown={onKeyDown}
      >
        <p className="wt-boarding__label">{t('boarding.label')}</p>
        <p className="wt-boarding__route" data-testid="boarding-route">
          {routeLabel}
        </p>
        <p className="wt-boarding__count">{t('boarding.countries', { count: countries.length })}</p>
        <p className="wt-boarding__passenger">{t('boarding.passenger', { nickname: displayName })}</p>
        <p className="wt-boarding__rules">
          {t('boarding.rules', { ruleType, parTime: formatMMSS(parMs) })}
        </p>
        <p className="wt-boarding__cta">{locked ? t('boarding.connecting') : t('boarding.cta')}</p>
      </div>
    </div>
  );
}

/**
 * 티어/데일리 runs/start 실패(오프라인 등 — 서버 salt 확보 불가) 시 BoardingPass 대신 표시하는
 * 차단 안내(WT-M3-06 구현 세부 지시 1 — "티어/데일리는 시작 차단 + 안내"). 대륙/세계일주는
 * 로컬 세트로 계속 플레이 가능하므로 이 컴포넌트 대상이 아니다(GamePage 분기 참조).
 */
export function BoardingBlocked() {
  const { t } = useTranslation();
  return (
    <div className="wt-boarding" data-testid="boarding-blocked">
      <div className="wt-boarding__card wt-boarding__card--blocked">
        <p className="wt-boarding__label">{t('boarding.blocked.title')}</p>
        <p className="wt-boarding__rules">{t('boarding.blocked.body')}</p>
      </div>
    </div>
  );
}
