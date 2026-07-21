// spec: docs/03 §7.1(플랫폼 판정 — 랭킹 태깅), WT-M2-05
//
// 부팅 1회 확정, 세션 중 불변(§7.1). 터치+coarse 포인터+좁은 뷰포트 동시 충족 시에만 mobile —
// 데스크톱 터치스크린 오탐(coarse 없이 터치만 있는 경우 등)을 피하기 위한 3중 조건이다.

export type Platform = 'desktop' | 'mobile';

export function detectPlatform(): Platform {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'desktop';
  const hasTouch = 'ontouchstart' in window;
  const isCoarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const isNarrow = window.innerWidth < 1024;
  return hasTouch && isCoarsePointer && isNarrow ? 'mobile' : 'desktop';
}
