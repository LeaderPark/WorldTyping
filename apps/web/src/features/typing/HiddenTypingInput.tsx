// spec: docs/03 §2.7 말미(hidden input 스펙·포커스 유지 계약), §7.2(모바일 입력 — Enter no-op),
//       docs/00 §11-D19. WT-M2-03.
//
// 화면에 거의 보이지 않는(opacity:0.01·1px) 입력 요소. 실제 IME 파이프라인은 이 요소에 붙는
// TypingInputController(@wt/engine, §2.7)가 담당하며, 이 컴포넌트는 (1) 스펙 그대로의 속성/스타일,
// (2) 인게임 포커스 유지 계약(§2.7 말미), (3) Enter keydown preventDefault(§7.2)만 책임진다.
//
// [고빈도 값 규약(§4.5)] 입력 버퍼 값은 절대 React state로 끌어올리지 않는다 — 컨트롤러가 값
// 스냅샷을 직접 읽고 프롬프트 렌더러가 DOM을 갱신한다. 이 컴포넌트는 value/onChange를 두지 않는다
// (비제어). 그래서 리렌더는 마운트 1회뿐이다.
import { useCallback, useEffect, useRef } from 'react';
import type { RefCallback } from 'react';

export interface HiddenTypingInputProps {
  /** useTypingEngine이 넘기는 ref 콜백(컨트롤러 attach 지점). */
  inputRef: RefCallback<HTMLInputElement>;
  /** aria-label(국가 이름 입력). 미지정 시 스펙 기본값. */
  ariaLabel?: string;
  /**
   * 포커스 유지 대상 여부(인게임=true). true일 때만 document pointerdown 캡처로 포커스를 되찾는다.
   * 대기/결과 화면에서는 false로 두어 다른 UI 클릭을 방해하지 않는다.
   */
  retainFocus?: boolean;
}

/** 클릭/탭한 대상이 상호작용 요소(포커스를 넘겨야 하는 것)인지 판정. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a[href], input, textarea, select, label, [role="button"], [role="link"], [contenteditable="true"], [data-interactive]',
    ),
  );
}

export function HiddenTypingInput({
  inputRef,
  ariaLabel = '국가 이름 입력',
  retainFocus = true,
}: HiddenTypingInputProps) {
  const localRef = useRef<HTMLInputElement | null>(null);

  // 두 ref(로컬 + 부모 콜백)를 합성한다. 로컬 ref로 포커스 되찾기에 쓰고, 콜백으로 컨트롤러를 붙인다.
  const setRef = useCallback<RefCallback<HTMLInputElement>>(
    (el) => {
      localRef.current = el;
      inputRef(el);
    },
    [inputRef],
  );

  // 포커스 유지 계약(§2.7 말미): 화면 아무 데나(비상호작용 요소) 탭해도 키보드가 유지되도록,
  // document의 pointerdown 캡처 단계에서 preventDefault + 재포커스. 상호작용 요소는 그대로 통과.
  useEffect(() => {
    if (!retainFocus) return;
    function onPointerDown(e: PointerEvent): void {
      if (isInteractiveTarget(e.target)) return;
      const el = localRef.current;
      if (!el) return;
      e.preventDefault(); // 텍스트 선택/포커스 이탈 방지
      el.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, [retainFocus]);

  // Enter는 자동 확정 게임에서 no-op(§7.2) — 폼 제출/모바일 키보드 닫힘 방지. IME 파이프라인
  // 보존을 위해 그 외 키는 절대 preventDefault 하지 않는다(컨트롤러가 Escape만 처리).
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.preventDefault();
  }, []);

  return (
    <input
      ref={setRef}
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="next"
      inputMode="text"
      aria-label={ariaLabel}
      data-testid="hidden-typing-input"
      onKeyDown={onKeyDown}
      // §2.7 말미 스타일 전문: opacity:0.01+1px(display:none/visibility:hidden은 포커스 불가·iOS
      // IME 미동작), top:50%(iOS 자동 스크롤 시 화면 튐 방지), pointer-events:none.
      style={{
        position: 'fixed',
        opacity: 0.01,
        height: '1px',
        width: '1px',
        top: '50%',
        left: '50%',
        pointerEvents: 'none',
      }}
    />
  );
}
