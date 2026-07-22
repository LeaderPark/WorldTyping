// spec: docs/03 §7.3("모달은 focus trap(inert 폴리필 불요 — 최신 브라우저 inert 사용) + ESC
//       닫기 + 트리거로 복귀"), WT-M5-02
//
// ESC 처리는 각 모달이 이미 자체적으로(useHotkeys 등) 닫기 함수를 호출하므로 이 훅은 관여하지
// 않는다 — 여기는 순수하게 (1) 배경 inert, (2) 초기 포커스 이동, (3) Tab 트랩, (4) 닫힘 시
// 트리거로 포커스 복귀만 책임진다.
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function queryFocusable(container: HTMLElement): HTMLElement[] {
  // offsetParent 기반 가시성 필터는 일부러 두지 않는다 — jsdom은 레이아웃 엔진이 없어
  // offsetParent가 항상 null이라(테스트 환경에서 이 필터를 쓰면 포커스 이동 자체가 깨진다),
  // 실제 브라우저에서도 이 저장소의 모달 내용은 항상 셀렉터가 곧 실제 상호작용 요소다.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * 컨테이너가 열려 있는 동안 형제 서브트리 전체(조상을 거슬러 올라가며)를 `inert`로 막고,
 * 컨테이너 안에서만 Tab 포커스가 순환하게 한다. 닫히면 inert를 해제하고 열기 직전 포커스였던
 * 요소로 되돌린다.
 */
export function useModalA11y(containerRef: RefObject<HTMLElement | null>, open: boolean): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const containerEl = containerRef.current;
    if (!containerEl) return;
    // 아래 nested 함수(onKeyDown)에서도 non-null로 좁혀진 채 안전하게 참조할 수 있도록 별도
    // 바인딩으로 고정한다(containerRef.current를 반복 재조회하지 않는다 — 열려있는 동안 그
    // 값이 바뀔 일이 없다).
    const container: HTMLElement = containerEl;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const inerted: Element[] = [];
    let node: Element = container;
    while (node.parentElement && node !== document.body) {
      const parent = node.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== node && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          inerted.push(sibling);
        }
      }
      node = parent;
    }

    queryFocusable(container)[0]?.focus();

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const items = queryFocusable(container);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    container.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      for (const sibling of inerted) sibling.removeAttribute('inert');
      previouslyFocused.current?.focus?.();
    };
    // containerRef 자체(객체 참조)는 매 렌더 동일 — deps에는 open만 두면 충분하다.
  }, [open, containerRef]);
}
