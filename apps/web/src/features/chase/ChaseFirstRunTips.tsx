// spec: docs/09-chase-mode-goldrunner.md §8.1(온보딩 — 별도 튜토리얼 없음, 첫 플레이 스캐폴딩만)·
//       §7.3(콜아웃)·§7.4(수배 별)·§7.5(홈 비컨·레이더 화살표)·§8.10(a11y), docs/01 §11.1(첫 판
//       전용 스캐폴딩 원칙), docs/00 §11-D96(연출 비블로킹 — 히트스톱 외 블로킹 금지)·D111 ①,
//       WT-CH-DEV-2.
//
// chase 첫 런 한정 코치마크 3개(순차). features/onboarding/FirstRunTips.tsx(싱글 모드 선례)의
// 계약을 그대로 준용한다:
//   · localStorage 1회 플래그로 평생 1회만 노출(여기서는 `wt:chase:tipsSeen`)
//   · 비모달·비블로킹 — role="dialog"·포커스 이동·오버레이 스크림 전부 없음. 컨테이너는
//     pointer-events:none(globals.css)이라 클릭도 통과하고, 타이핑 입력(FocusStrip 히든 input)은
//     한 순간도 가로채지 않는다(D96: 히트스톱 외 어떤 연출도 입력을 막지 않는다).
//   · reduced-motion이면 등장 애니메이션 없이 정적 표시(data-static="true" → CSS animation:none).
//
// 싱글 FirstRunTips가 "완주 기록 0"(meta.stamps)을 첫 판 판정에 쓰는 것과 달리 chase는 무한 생존
// 모드라 완주 스탬프가 남지 않는다 — 그래서 판정 원천을 전용 localStorage 플래그 하나로 둔다
// (플래그는 첫 노출 시점에 즉시 기록해, 중간에 체포당해 시퀀스를 끝까지 못 봐도 다음 판에 다시
// 뜨지 않게 한다 — BriefingCard의 종전 관례와 동일).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings';

const TIPS_SEEN_KEY = 'wt:chase:tipsSeen';
/** 팁 1개 노출 시간. 한 홉 사이클(콜아웃 스캔→타이핑→홉)보다 살짝 길게 잡아 "읽을 틈"을 주되,
 *  3개 합계가 8초를 넘지 않도록 한다(플레이 방해 최소화 — 시야 상단/하단 가장자리 배치와 병행). */
const TIP_STEP_MS = 2600;

/** 순서·앵커 위치(§11-D111 ①): ① 후보 콜아웃 ② 수배 별 ③ 홈 비컨/레이더 화살표.
 *  `anchor` 값은 globals.css의 `[data-tip='…']` 배치 규칙 키로 그대로 쓰인다. */
const TIP_STEPS: ReadonlyArray<{ anchor: string; key: string }> = [
  { anchor: 'callouts', key: 'chase.tip.callouts' },
  { anchor: 'wanted', key: 'chase.tip.wanted' },
  { anchor: 'delivery', key: 'chase.tip.delivery' },
];

function hasSeenChaseTips(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TIPS_SEEN_KEY) === '1';
  } catch {
    return true; // 접근 불가(사생활 모드 등) — 매 판 노출을 강요하지 않는다.
  }
}

function markChaseTipsSeen(): void {
  try {
    localStorage?.setItem(TIPS_SEEN_KEY, '1');
  } catch {
    /* 저장 실패해도 이번 세션 노출은 이미 시작됐다 — 무시. */
  }
}

/** ChaseGameRoot가 playing phase에서만 마운트한다(카운트다운·브리핑·결과에는 뜨지 않는다). */
export function ChaseFirstRunTips() {
  const { t } = useTranslation();
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  // null = 더 보여줄 팁 없음(이미 본 사용자 포함) → 렌더 자체를 하지 않는다.
  const [step, setStep] = useState<number | null>(() => (hasSeenChaseTips() ? null : 0));

  useEffect(() => {
    if (step === null) return undefined;
    if (step === 0) markChaseTipsSeen();
    const timer = setTimeout(() => {
      setStep((cur) => (cur === null || cur + 1 >= TIP_STEPS.length ? null : cur + 1));
    }, TIP_STEP_MS);
    return () => clearTimeout(timer);
  }, [step]);

  // ChaseGameRoot/use-chase-juice와 동일한 reduced 판정 공식(같은 전역 상태 → 같은 결과).
  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;

  if (step === null) return null;
  const tip = TIP_STEPS[step];
  if (!tip) return null;

  return (
    <div
      className="wt-chase-tips"
      data-testid="chase-first-run-tips"
      data-static={reducedActive ? 'true' : undefined}
    >
      <div
        className="wt-chase-tip"
        data-tip={tip.anchor}
        data-testid="chase-first-run-tip"
        role="status"
        aria-live="polite"
      >
        <span className="wt-chase-tip__text">{t(tip.key)}</span>
        <span className="wt-chase-tip__step" aria-hidden="true">{`${step + 1}/${TIP_STEPS.length}`}</span>
      </div>
    </div>
  );
}
