// spec: docs/03 §4.4(useTypingEngine 시그니처), §2.7(컨트롤러 마운트·파이프), §4.5(고빈도 값 규약),
//       docs/00 §11-D19. WT-M2-03.
//
// hidden input ref에 TypingInputController(@wt/engine)를 attach하고, 컨트롤러의 TypingEvent를
// 엔진(handleInput)으로 파이프한다. 컨트롤러 인스턴스를 노출해 PromptArea가 같은 이벤트 스트림을
// 구독(채색)하게 한다 — 컨트롤러는 클라 로직/DOM 계층이지 React state가 아니다(§4.5 불변식 준수).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import { TypingInputController, type GameSessionEngine } from '@wt/engine';

export interface UseTypingEngineResult {
  /** HiddenTypingInput에 넘길 ref 콜백(요소 부착 시 컨트롤러 생성·attach). */
  inputRef: RefCallback<HTMLInputElement>;
  /** 프로그램적 포커스(보딩패스 탭 등 사용자 제스처 안에서 호출). */
  focusInput(): void;
  /** PromptArea가 채색을 위해 구독할 컨트롤러(부착 전 null). */
  controller: TypingInputController | null;
  /** 별칭 에코 등 표시 계층이 실입력 원문을 읽을 때 사용(고빈도 값은 state 미경유 — §4.5). */
  getInputValue(): string;
}

export function useTypingEngine(engine: GameSessionEngine): UseTypingEngineResult {
  const [controller, setController] = useState<TypingInputController | null>(null);
  const controllerRef = useRef<TypingInputController | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    controllerRef.current?.detach();
    controllerRef.current = null;
    inputElRef.current = null;
  }, []);

  const inputRef = useCallback<RefCallback<HTMLInputElement>>(
    (el) => {
      if (el) {
        // 같은 요소로 재호출되면 무시(React는 보통 언마운트 시 null만 준다).
        if (controllerRef.current && inputElRef.current === el) return;
        teardown();
        const lang = engine.getSnapshot().lang;
        const c = new TypingInputController(el, lang);
        c.attach();
        unsubRef.current = c.subscribe((e) => engine.handleInput(e));
        controllerRef.current = c;
        inputElRef.current = el;
        setController(c);
      } else {
        teardown();
        setController(null);
      }
    },
    [engine, teardown],
  );

  // 엔진 자체가 교체되면(세션 재생성) 이전 컨트롤러를 확실히 정리한다.
  useEffect(() => teardown, [teardown]);

  const focusInput = useCallback(() => {
    controllerRef.current?.focus();
  }, []);

  const getInputValue = useCallback(() => inputElRef.current?.value ?? '', []);

  return { inputRef, focusInput, controller, getInputValue };
}
