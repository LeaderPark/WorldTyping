// spec: docs/09-chase-mode-goldrunner.md §6.2(ChaseSessionEngine 시그니처)·§3.2(3-타깃 판정),
//       docs/00 §11-D97(합성 Country를 setCountry로 주입 — 컨트롤러 무수정), docs/03 §2.7(컨트롤러
//       라이프사이클)·§4.4(useTypingEngine 반환 계약 승계)·§4.5(고빈도 값 규약), WT-CH-06.
//
// apps/web/src/features/typing/useTypingEngine.ts의 chase 전용 대응물. TypingInputController를
// hidden input에 attach하고 controller→engine.handleInput 파이프는 그대로 재사용하되, chase 고유
// 배선 한 가지를 더한다: engine이 candidatesShown을 방출할 때마다 그 시점 3후보의 acceptedInputs
// 합집합을 실은 합성 Country를 controller.setCountry로 주입한다(D97 — 컨트롤러 자체는 단일 타깃
// 전제 그대로 무수정, EXACT 확정은 "3후보 중 하나에 완전 일치"의 권위 신호가 된다).
//
// [실측 확인 — engine.getCandidateCountries()를 여기서 안 쓰는 이유, 최종 보고 기재] chase-session.ts의
// afterAdvance()는 processNewSimEvents()(candidatesShown 방출)를 syncCandidates()(this.candidateIds
// 갱신) **이전에** 실행한다. 즉 candidatesShown 리스너 콜백 "안에서" 동기적으로 getCandidateCountries()
// 를 호출하면 **아직 갱신 전인 이전 홉의 후보**가 반환된다(실제 엔진으로 재현 확인 — 새 홉 후보가 아닌
// 직전 후보 3개가 나옴). getCandidateCountries()는 사후 스냅샷 조회용(chase-session.test.ts의 실사용도
// startPlaying() 완전히 반환된 뒤에만 호출)이라 이 훅의 동기 콜백 안에서 쓰면 안 된다. 대신 이벤트가
// 실어 보내는 `candidates: CandidateView[]`(신선한 id 배열 — sim 이벤트 원본에서 직접 옴, 이 갱신
// 순서와 무관)를 이 훅이 보유한 countries 테이블로 직접 조회한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import { TypingInputController } from '@wt/engine';
import type { ChaseSessionEngine } from '@wt/engine';
import type { Country, CountryId } from '@wt/shared';
import { buildCompositeCountry } from './composite-country';

export interface UseChaseEngineResult {
  /** FocusStrip의 HiddenTypingInput에 넘길 ref 콜백(요소 부착 시 컨트롤러 생성·attach). */
  inputRef: RefCallback<HTMLInputElement>;
  /** 프로그램적 포커스(포커스 이탈 복구 등). */
  focusInput(): void;
  /** CandidateCallouts가 후보별 입력 에코(matchInputDetail 병렬 평가)를 위해 구독할 컨트롤러. */
  controller: TypingInputController | null;
  /** 표시 계층이 실입력 원문을 읽을 때 사용(고빈도 값은 state 미경유 — §4.5). */
  getInputValue(): string;
  /** D95: chase엔 스킵 없음(구조상 no-op) — 인터페이스 대칭을 위해 유지, 호출해도 안전. */
  requestSkip(): void;
}

export function useChaseEngine(
  engine: ChaseSessionEngine,
  countries: readonly Country[],
): UseChaseEngineResult {
  const [controller, setController] = useState<TypingInputController | null>(null);
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null);
  const controllerRef = useRef<TypingInputController | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);

  // countries는 마운트 상수 취급(전체 국가 테이블 — engine 생성 시 넘긴 것과 동일 배열이어야 함).
  const countryById = useMemo(() => {
    const m = new Map<CountryId, Country>();
    for (const c of countries) m.set(c.id, c);
    return m;
  }, [countries]);

  const inputRef = useCallback<RefCallback<HTMLInputElement>>((el) => {
    inputElRef.current = el;
    setInputEl(el);
  }, []);

  // useTypingEngine과 동일한 StrictMode 안전 패턴(WT-M2-09) — ref 콜백은 부수효과 없이 요소만
  // 기록하고, effect가 (요소, 엔진) 키로 setup=attach·cleanup=detach를 대칭 수행한다.
  useEffect(() => {
    if (!inputEl) return;
    const c = new TypingInputController(inputEl, engine.getSnapshot().lang);
    c.attach();
    const unsubEngine = c.subscribe((e) => engine.handleInput(e));
    controllerRef.current = c;
    setController(c);

    // D97 배선: candidatesShown마다 그 시점 3후보의 합성 Country를 주입한다. engine.subscribe는
    // controller 생성 이후에 걸어야 setCountry 호출 시 controller가 이미 준비돼 있다. 후보 id는
    // 이벤트 자체(e.candidates)에서 조회한다(engine.getCandidateCountries()는 이 시점에 신선하지
    // 않음 — 파일 상단 주석 참조).
    const unsubCandidates = engine.subscribe((e) => {
      if (e.type !== 'candidatesShown') return;
      const resolved = e.candidates
        .map((cv) => countryById.get(cv.id))
        .filter((c): c is Country => c !== undefined);
      if (resolved.length === 0) return; // 방어적: 계약상 발생하지 않음(engine이 항상 3개 보장)
      c.setCountry(buildCompositeCountry(resolved));
    });

    return () => {
      unsubCandidates();
      unsubEngine();
      c.detach();
      if (controllerRef.current === c) controllerRef.current = null;
      setController((prev) => (prev === c ? null : prev));
    };
  }, [inputEl, engine, countryById]);

  const focusInput = useCallback(() => {
    controllerRef.current?.focus();
  }, []);

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
