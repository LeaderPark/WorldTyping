// spec: docs/03 §4.4(useTypingEngine 시그니처), §2.7(컨트롤러 마운트·파이프·라이프사이클),
//       §4.5(고빈도 값 규약), docs/00 §11-D19·D33(useTypingEngine 반환 계약). WT-M2-03 / WT-M2-09.
//
// hidden input ref에 TypingInputController(@wt/engine)를 attach하고, 컨트롤러의 TypingEvent를
// 엔진(handleInput)으로 파이프한다. 컨트롤러 인스턴스를 노출해 PromptArea가 같은 이벤트 스트림을
// 구독(채색)하게 한다 — 컨트롤러는 클라 로직/DOM 계층이지 React state가 아니다(§4.5 불변식 준수).
//
// [StrictMode 안전성 — WT-M2-09] attach/detach는 ref 콜백이 아니라 useEffect가 소유한다. ref
// 콜백은 부수효과 없이 요소만 state에 기록하고, effect가 (요소, 엔진) 키로 setup=attach·
// cleanup=detach를 대칭 수행한다. vite dev의 React.StrictMode는 마운트 직후 effect를
// setup→cleanup→setup으로 이중 호출하는데, 이 대칭 구조에서는 항상 컨트롤러 1개가 부착된
// 상태로 수렴한다. (과거 결함: 부수효과를 ref 콜백에 두고 `useEffect(()=>teardown)`만 뒀더니
// StrictMode 이중 호출의 cleanup이 detach만 하고 ref 콜백은 재호출되지 않아 재부착이 누락됨 —
// dev 빌드에서 hidden input에 컨트롤러가 안 붙어 타이핑·ESC가 엔진에 전달되지 않았다.)
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
  /**
   * 모바일 스킵 고정 버튼(docs/03 §7.2·WT-M5-02)용 — 데스크톱 ESC와 정확히 같은 경로를
   * 재사용한다: hidden input에 Escape keydown을 그대로 재현해 흘려보낸다(controller.attach()가
   * 이 이벤트를 그 요소에서 직접 구독하므로 스킵 판정 로직을 이 훅에 복제하지 않는다 —
   * shared 판정 로직 중복 금지 원칙과 동일 취지). 부착 전(요소 없음)이면 no-op.
   */
  requestSkip(): void;
}

export function useTypingEngine(engine: GameSessionEngine): UseTypingEngineResult {
  const [controller, setController] = useState<TypingInputController | null>(null);
  // ref 콜백이 요소를 여기에 기록하면 아래 effect가 재실행돼 attach/detach를 수행한다.
  // (ref 콜백 자체는 부수효과가 없어야 StrictMode 이중 호출에서 안전하다 — 파일 상단 주석.)
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null);
  const controllerRef = useRef<TypingInputController | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);

  const inputRef = useCallback<RefCallback<HTMLInputElement>>((el) => {
    inputElRef.current = el;
    setInputEl(el);
  }, []);

  // 요소·엔진이 준비/교체되면 컨트롤러를 새로 붙이고, cleanup에서 반드시 뗀다(대칭). 요소가
  // 아직 없으면(초기 렌더) no-op. 엔진 교체(세션 재생성) 시에도 이 effect가 재실행돼 이전
  // 컨트롤러를 정리하고 새 언어/엔진으로 재부착한다.
  useEffect(() => {
    if (!inputEl) return;
    const c = new TypingInputController(inputEl, engine.getSnapshot().lang);
    c.attach();
    const unsub = c.subscribe((e) => engine.handleInput(e));
    controllerRef.current = c;
    setController(c);
    return () => {
      unsub();
      c.detach();
      if (controllerRef.current === c) controllerRef.current = null;
      // StrictMode 이중 호출/엔진 교체로 이미 다른 컨트롤러가 들어섰다면 그 값을 보존한다.
      setController((prev) => (prev === c ? null : prev));
    };
  }, [inputEl, engine]);

  const focusInput = useCallback(() => {
    controllerRef.current?.focus();
  }, []);

  // D70: 컨트롤러의 getValue()가 Gboard 가상 접두(basePrefix)를 제외한 실입력을 돌려준다 —
  // 프롬프트 에코가 재삽입된 옛 값을 표시하지 않게 한다. 컨트롤러 부착 전(초기 렌더)엔 DOM value 폴백.
  const getInputValue = useCallback(
    () => controllerRef.current?.getValue() ?? inputElRef.current?.value ?? '',
    [],
  );

  const requestSkip = useCallback(() => {
    inputElRef.current?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  }, []);

  return { inputRef, focusInput, controller, getInputValue, requestSkip };
}
