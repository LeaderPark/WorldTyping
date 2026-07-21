// spec: docs/01 §11.1(온보딩 2단계 — "첫 판 전용 스캐폴딩": 완주 기록 없으면 1~3번째 국가에서
//       툴팁 + 첫 정답 시 토스트 1회), docs/03 §4.2(GameView 하위 컴포넌트), WT-M2-07
//
// 1단계(싱글플레이 카드 펄스)는 HomePage가 담당(§11.1 1항, meta.stamps 비어있음 조건 공유).
// 3단계(첫 완주 결과 화면의 여권 발급 연출)는 이 작업 산출물 목록 밖(§11.1 3항, ResultView
// 확장은 별도 태스크 소관) — 이 컴포넌트는 2단계(툴팁+토스트)만 담당한다.
//
// 완주 기록이 하나도 없는 계정에서만 노출된다(meta.stamps 비어있음 = "첫 판"). 토스트는
// localStorage 플래그로 평생 1회만(§11.1 "첫 정답 시 … 토스트 1회").
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TypingEvent, TypingInputController } from '@wt/engine';
import { useMetaStore } from '../../stores/meta';

const AUTO_ADVANCE_SEEN_KEY = 'wt:onboarding:autoAdvanceSeen';
/** 첫 3개 국가(0-based index 0~2)에서만 "따라 치면 돼요" 툴팁을 보여준다(§11.1). */
const TOOLTIP_MAX_INDEX = 2;
const TOAST_AUTO_HIDE_MS = 4000;

function hasSeenAutoAdvanceToast(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_ADVANCE_SEEN_KEY) === '1';
  } catch {
    return true; // 접근 불가(사생활 모드 등) — 토스트를 강요하지 않는다.
  }
}

function markAutoAdvanceToastSeen(): void {
  try {
    localStorage?.setItem(AUTO_ADVANCE_SEEN_KEY, '1');
  } catch {
    /* 저장 실패해도 이번 세션 표시 자체는 이미 끝났다 — 무시. */
  }
}

export interface FirstRunTipsProps {
  controller: TypingInputController | null;
  /** GameView의 currentIndex — 국가 전환 단위 빈도(§4.5 허용치)라 그대로 prop으로 받는다. */
  currentIndex: number;
}

export function FirstRunTips({ controller, currentIndex }: FirstRunTipsProps) {
  const { t } = useTranslation();
  const isFirstRun = useMetaStore((s) => Object.keys(s.stamps).length === 0);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (!isFirstRun || !controller) return;
    if (hasSeenAutoAdvanceToast()) return;

    const unsub = controller.subscribe((e: TypingEvent) => {
      if (e.type !== 'exact') return;
      if (hasSeenAutoAdvanceToast()) return;
      markAutoAdvanceToastSeen();
      setToastVisible(true);
    });
    return unsub;
  }, [isFirstRun, controller]);

  useEffect(() => {
    if (!toastVisible) return undefined;
    const timer = setTimeout(() => setToastVisible(false), TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [toastVisible]);

  if (!isFirstRun) return null;

  const showTooltip = currentIndex <= TOOLTIP_MAX_INDEX;

  return (
    <>
      {showTooltip && (
        <div className="wt-onboarding-tip" data-testid="onboarding-tooltip" role="status">
          {t('onboarding.followAlong')}
        </div>
      )}
      {toastVisible && (
        <div className="wt-onboarding-toast" data-testid="onboarding-toast" role="status" aria-live="polite">
          {t('onboarding.autoAdvance')}
        </div>
      )}
    </>
  );
}
