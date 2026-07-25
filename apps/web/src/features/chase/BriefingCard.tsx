// spec: docs/09-chase-mode-goldrunner.md §7.1(보딩 화면 — "지명수배 전단 브리핑")·§8.1(온보딩 —
//       첫 플레이 1회 3줄 규칙 요약), docs/00 §11-D90, WT-CH-08.
//
// GamePage(mode=chase)의 idle 단계 카드. 기존 BoardingPass(§03-7.2 "탭 → hidden input 동기 focus →
// 카운트다운")의 클릭-투-스타트 계약은 그대로 재사용하되(입력 계층 무수정 원칙 — 이 컴포넌트는 그
// 계약을 준수하는 새 마크업일 뿐 BoardingPass 자체를 재사용하지 않는다: 그 컴포넌트의 props(모드/
// 노선/고스트 토글 등)는 "완주 가능한 고정 세트" 전제라 무한 생존 chase에 맞지 않는다), 시각은
// WANTED 전단(크라프트지 텍스처)으로 갈아입는다. 카드 프레임(.wt-boarding__card)은 기존 5모드와
// 공유하는 전역 클래스를 그대로 재사용하고(§8 "다른 모드 화면에 픽셀 영향 0" — 이 파일은 신규
// 페이지에서만 쓰이므로 공유 클래스 재사용이 다른 화면에 영향을 주지 않는다), 새 accent 수식자
// 하나(.wt-boarding__card--chase)만 globals.css에 더한다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

const ONBOARDING_SEEN_KEY = 'wt:onboarding:chaseBriefingSeen';
/** BoardingPass.tsx의 PUNCH_MS와 동일 취지 — 스탬프 낙하(§7.1 "300ms")를 화면에 완주시킨 뒤 start(). */
const STAMP_FALL_MS = 300;

function hasSeenChaseBriefing(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return true; // 접근 불가(사생활 모드 등) — 매번 노출을 강요하지 않는다.
  }
}

function markChaseBriefingSeen(): void {
  try {
    localStorage?.setItem(ONBOARDING_SEEN_KEY, '1');
  } catch {
    /* 저장 실패해도 이번 세션 표시는 이미 끝났다 — 무시. */
  }
}

export interface BriefingCardProps {
  /** simulateChase(seed, moveLog:[], endMs:0)로 미리 peek한 홈 국가 표시명(§7.1 미션 텍스트 원천). */
  homeName: string;
  /** 서버 시드/그래프 로딩 중이면 카드를 잠근다(runs/start와 동일한 "connecting" 톤, WT-M3-06 관례). */
  locked?: boolean;
  focusInput(): void;
  onStart(): void;
}

export function BriefingCard({ homeName, locked = false, focusInput, onStart }: BriefingCardProps) {
  const { t } = useTranslation();
  const [punching, setPunching] = useState(false);
  const [showRules] = useState(() => !hasSeenChaseBriefing());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    markChaseBriefingSeen();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const depart = useCallback(() => {
    if (punching || locked) return;
    // §03-7.2: 반드시 이 동기 핸들러 안에서 focus — setTimeout 뒤로 미루면 iOS가 소프트키보드를 열지 않는다.
    focusInput();
    setPunching(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onStart();
    }, STAMP_FALL_MS);
  }, [punching, locked, focusInput, onStart]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        depart();
      }
    },
    [depart],
  );

  const cardClassName = `wt-boarding__card wt-boarding__card--chase${punching ? ' wt-boarding__card--punch' : ''}${locked ? ' wt-boarding__card--locked' : ''}`;

  return (
    <div className="wt-boarding" data-testid="chase-briefing">
      <div
        className={cardClassName}
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-disabled={locked}
        aria-label={t('chase.briefing.cta')}
        data-testid="chase-briefing-card"
        data-locked={locked}
        onClick={depart}
        onKeyDown={onKeyDown}
      >
        <span className="wt-boarding__accent" aria-hidden="true" />
        <div className="wt-boarding__main">
          <p className="wt-boarding__label">{t('chase.briefing.title')}</p>
          <p className="wt-boarding__route" data-testid="chase-briefing-mission">
            {t('chase.briefing.mission', { home: homeName })}
          </p>
          {showRules && (
            <ul className="wt-chase-briefing__rules" data-testid="chase-briefing-rules">
              <li>{t('chase.briefing.ruleMove')}</li>
              <li>{t('chase.briefing.rulePolice')}</li>
              <li>{t('chase.briefing.ruleGold')}</li>
            </ul>
          )}
          <p className="wt-boarding__cta wt-chase-briefing__cta">
            {punching ? t('boarding.punching') : locked ? t('boarding.connecting') : t('chase.briefing.cta')}
          </p>
        </div>
      </div>
    </div>
  );
}
