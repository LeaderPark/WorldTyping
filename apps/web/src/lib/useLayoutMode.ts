// spec: docs/03 §7.1("인게임은 미디어쿼리가 아니라 useLayoutMode() 훅(뷰포트+visualViewport
//       합성)으로 결정 — 소프트 키보드가 뜨면 높이가 절반이 되므로 뷰포트 폭만으론 오판" +
//       "visualViewport.resize/scroll 구독 → CSS 변수 --vv-height, --vv-offset-top 갱신"),
//       docs/00 §11(세션 특이 조정), WT-M5-02
//
// 모드 판정은 폭(innerWidth)만 본다(§7.1 표: mobile<640, tablet 640-1023, desktop>=1024 —
// tailwind.config.ts screens.sm/lg와 동일 경계) — 키보드가 떠 높이가 줄어도 오판하지 않는다.
// 높이/오프셋(visualViewport)은 모드 판정과 분리해 CSS 변수로만 반영한다. iOS 주소창 수축이나
// 안드로이드 소프트 키보드 등장 모두 이 두 값의 변화로 커버된다(globals.css의
// `.wt-prompt-kb-anchor`가 이 변수를 읽어 "키보드 위 중앙"을 계산한다).
import { useEffect, useState } from 'react';

export type LayoutMode = 'mobile' | 'tablet' | 'desktop';

const BREAKPOINT_SM = 640;
const BREAKPOINT_LG = 1024;

function computeMode(width: number): LayoutMode {
  if (width < BREAKPOINT_SM) return 'mobile';
  if (width < BREAKPOINT_LG) return 'tablet';
  return 'desktop';
}

export interface LayoutModeState {
  mode: LayoutMode;
  /** visualViewport.height(px) — 없으면 innerHeight 폴백. */
  vvHeight: number;
  /** visualViewport.offsetTop(px) — 없으면 0. */
  vvOffsetTop: number;
}

function readState(): LayoutModeState {
  if (typeof window === 'undefined') {
    return { mode: 'desktop', vvHeight: 0, vvOffsetTop: 0 };
  }
  const vv = window.visualViewport;
  return {
    mode: computeMode(window.innerWidth),
    vvHeight: vv?.height ?? window.innerHeight,
    vvOffsetTop: vv?.offsetTop ?? 0,
  };
}

/** :root에 --vv-height/--vv-offset-top을 반영 — CSS 전역 소비(globals.css)를 위함(§7.1). */
function applyVvVars(height: number, offsetTop: number): void {
  const root = document.documentElement;
  root.style.setProperty('--vv-height', `${height}px`);
  root.style.setProperty('--vv-offset-top', `${offsetTop}px`);
}

export function useLayoutMode(): LayoutModeState {
  const [state, setState] = useState<LayoutModeState>(readState);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;

    function update(): void {
      const next = readState();
      applyVvVars(next.vvHeight, next.vvOffsetTop);
      setState(next);
    }

    update();
    window.addEventListener('resize', update);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
    };
  }, []);

  return state;
}
