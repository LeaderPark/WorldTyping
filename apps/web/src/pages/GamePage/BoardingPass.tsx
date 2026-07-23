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
import { useMetaStore, type TrackBest } from '../../stores/meta';
import { describeRouteLabel, ruleTypeKey } from './route-label';

export interface BoardingPassProps {
  mode: GameMode;
  trackId: string;
  countries: readonly Country[];
  lang: 'ko' | 'en';
  nickname: string;
  guestId: string;
  /** 세계일주 장시간 모드 경고(§7.3) 노출 여부 판정용. */
  platform: 'desktop' | 'mobile';
  start(): void;
  focusInput(): void;
  /** 티어/데일리가 서버 세트(POST /runs/start) 응답을 기다리는 동안 CTA를 잠근다(WT-M3-06
   *  구현 세부 지시 1 — 서버 세트 없이는 시작 불가). 보통 수십ms 내 해제된다. */
  locked?: boolean;
  /** 고스트 모드 언락 여부(§9.3 "아무 노선 완주 1회", WT-M5-04) — false/undefined면 토글 자체를
   *  숨긴다(콘텐츠는 안 잠그지만 이 옵션은 도전과제성 코스메틱 성격, §9.3 "잠그는 것은 코스메틱과
   *  도전과제성 옵션뿐"). onToggleGhost가 없으면(예: 데일리) 마찬가지로 숨긴다. */
  ghostUnlocked?: boolean;
  ghostEnabled?: boolean;
  onToggleGhost?(v: boolean): void;
}

/** GDD §10.2 "카드가 개찰기 통과 애니메이션(200ms)" — 이 시간만큼 start()를 지연시켜 펀칭
 *  연출을 화면에 완주시킨다. */
const PUNCH_MS = 200;

/** 티켓 억센트 색(순수 장식 — 판정/점수와 무관, 대륙은 노선색, 그 외는 등급색으로 대체). 클래스는
 *  globals.css `.wt-boarding__card--*`(WT-UI-05)가 `--wt-boarding-accent`를 설정한다. */
function ticketAccentClass(mode: GameMode, trackId: string): string {
  if (mode === 'continent') return `wt-boarding__card--${trackId}`;
  if (mode === 'worldtour') return 'wt-boarding__card--worldtour';
  if (mode === 'daily') return 'wt-boarding__card--daily';
  return 'wt-boarding__card--tier'; // tier · race(이 화면 도달 불가 — 안전 폴백)
}

export function BoardingPass({
  mode,
  trackId,
  countries,
  lang,
  nickname,
  guestId,
  platform,
  start,
  focusInput,
  locked = false,
  ghostUnlocked = false,
  ghostEnabled = false,
  onToggleGhost,
}: BoardingPassProps) {
  const { t } = useTranslation();
  const [punching, setPunching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WT-DC-04(⑤): 카드 아래 "내 최고" 라인(디자인 L210~212). 원천은 meta trackBests(`mode:trackId`).
  const trackBests = useMetaStore((s) => s.trackBests);
  // 세계일주(10분+) 모바일 "장시간 모드" 경고 1회(§7.3) — 보딩패스 화면 1회 노출로 충분(닫으면
  // 이 마운트 동안은 재노출하지 않는다. 판마다 새로 마운트되므로 다음 판엔 다시 뜬다 — 매번
  // 배터리/시간을 상기시키는 편이 안전하다는 판단, 영구 억제는 하지 않는다).
  const [showLongModeWarning, setShowLongModeWarning] = useState(mode === 'worldtour' && platform === 'mobile');

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

  // WT-DC-04(⑤)/리드 결정(옵션2): 내 최고 라인(디자인 L210~212). meta TrackBest는 정확도를
  // 저장하지 않으므로(grade/timeMs/score/completed) boarding.myBest를 grade+time으로 확정
  // (기존 route.best와 동형). 스토어/기록 경로 수정 리스크를 피한 안전 선택 — 정확도는 후속 과제.
  const best = trackBests[`${mode}:${trackId}`] as TrackBest | undefined;
  const myBestLine = best
    ? t('boarding.myBest', { grade: best.grade, time: formatMMSS(best.timeMs) })
    : null;

  // 기존 testid/속성/핸들러(§7.2 동기 focus 계약 포함)는 전부 그대로 — 클래스 조합만 티켓
  // 억센트(trackId별 노선색)를 더한다.
  const cardClassName = `wt-boarding__card ${ticketAccentClass(mode, trackId)}${punching ? ' wt-boarding__card--punch' : ''}${locked ? ' wt-boarding__card--locked' : ''}`;

  return (
    <div className="wt-boarding" data-testid="boarding-pass">
      {showLongModeWarning && (
        <p className="wt-long-mode-warning" data-testid="long-mode-warning">
          <span>{t('boarding.longModeWarning')}</span>
          <button
            type="button"
            className="wt-long-mode-warning__dismiss"
            data-testid="long-mode-warning-dismiss"
            onClick={() => setShowLongModeWarning(false)}
          >
            {t('boarding.longModeWarning.dismiss')}
          </button>
        </p>
      )}
      <div
        className={cardClassName}
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-disabled={locked}
        aria-label={t('boarding.cta')}
        data-testid="boarding-card"
        data-locked={locked}
        onClick={depart}
        onKeyDown={onKeyDown}
      >
        {/* 노선색 억센트 바 — 순수 장식(§9.3 코스메틱과 동일 성격), 정보 없음. */}
        <span className="wt-boarding__accent" aria-hidden="true" />

        <div className="wt-boarding__main">
          <p className="wt-boarding__label">{t('boarding.label')}</p>
          <p className="wt-boarding__route" data-testid="boarding-route">
            {routeLabel}
          </p>
          <p className="wt-boarding__count">{t('boarding.countries', { count: countries.length })}</p>
          <p className="wt-boarding__passenger">{t('boarding.passenger', { nickname: displayName })}</p>
          <p className="wt-boarding__rules">
            {t('boarding.rules', { ruleType, parTime: formatMMSS(parMs) })}
          </p>
          <p className="wt-boarding__cta">
            {punching ? t('boarding.punching') : locked ? t('boarding.connecting') : t('boarding.cta')}
          </p>
        </div>

        {/* 절취선 너머 티켓 스텁 — 실물 보딩패스의 계승(§10.2 "여권을 탭해서 출국하기"의 시각적
            은유). 라벨/매수 반복 표기는 메인과 중복이라 스크린리더에서는 숨긴다. */}
        <div className="wt-boarding__stub" aria-hidden="true">
          <span className="wt-boarding__stub-text">{t('boarding.label')}</span>
          <span className="wt-boarding__stub-count">{countries.length}</span>
          <span className="wt-boarding__barcode" />
        </div>
      </div>

      {/* WT-DC-04(⑤): 내 최고 라인(디자인 L210~212) — 카드 아래 muted 텍스트. 데이터가 있을 때만. */}
      {myBestLine && (
        <p className="wt-boarding__mybest" data-testid="boarding-mybest">
          {myBestLine}
        </p>
      )}

      {/* 카드 클릭(depart) 영역 밖에 둔다 — 토글 클릭이 출국 탭으로 오인되지 않게(§9.3). */}
      {ghostUnlocked && onToggleGhost && (
        <label className="wt-boarding__ghost-toggle" data-testid="ghost-mode-toggle">
          <input
            type="checkbox"
            checked={ghostEnabled}
            onChange={(e) => onToggleGhost(e.target.checked)}
          />
          {t('boarding.ghostMode')}
        </label>
      )}
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
      {/* 티켓 스텁/절취선 없이 본문만(WT-UI-05) — 오프라인 안내는 "출국 불가" 상태라 티켓 룩의
          축제 분위기를 재현하지 않는다(globals.css의 --blocked 수식자가 억센트·절취선을 숨긴다). */}
      <div className="wt-boarding__card wt-boarding__card--blocked">
        <div className="wt-boarding__main">
          <p className="wt-boarding__label">{t('boarding.blocked.title')}</p>
          <p className="wt-boarding__rules">{t('boarding.blocked.body')}</p>
        </div>
      </div>
    </div>
  );
}
