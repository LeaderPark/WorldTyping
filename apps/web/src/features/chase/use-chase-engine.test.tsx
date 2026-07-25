// @vitest-environment jsdom
//
// spec: docs/00 §11-D97(합성 Country 배선 계약), docs/03 §2.7·§4.4(useTypingEngine 반환 계약 승계),
// WT-CH-06 acceptance("컨트롤러 배선 훅 단위"). 이 훅은 engine.getCandidateCountries()를 candidatesShown
// 콜백 안에서 쓰지 않는다(실측 확인 — 그 시점엔 아직 이전 홉 값이라 신선하지 않음, use-chase-engine.ts
// 파일 상단 주석 참조) — 대신 이벤트가 실어 보내는 candidates[].id를 countries 테이블로 조회한다.
// 아래 mockChaseEngine은 그 신선도 함정을 그대로 재현해(emit 시 getCandidateCountries가 "이전" 값을
// 반환하도록) 훅이 실제로 이벤트의 id만 신뢰하는지 검증한다.
import { StrictMode, useEffect, type MutableRefObject } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseSessionEngine } from '@wt/engine';
import { TypingInputController, type TypingEvent } from '@wt/engine';
import type { Country } from '@wt/shared';
import { CHASE_COMPOSITE_ID } from './composite-country';
import { useChaseEngine } from './use-chase-engine';

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn'>): Country {
  return {
    iso3: 'XXX', aliasesKo: [], aliasesEn: [], continent: 'asia', subregion: '',
    difficultyTier: 1, capitalKo: '', capitalEn: '', flagEmoji: '🏳️', population: 0,
    latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: [p.nameKo], acceptedInputsEn: [p.nameEn.toLowerCase()],
    ...p,
  };
}
const MN = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia' });
const JP = mk({ id: 'JP', nameKo: '일본', nameEn: 'japan' });
const KR = mk({ id: 'KR', nameKo: '대한민국', nameEn: 'southkorea' });
const ALL_COUNTRIES = [MN, JP, KR];

interface MockEngine {
  engine: ChaseSessionEngine;
  emit(e: { type: 'candidatesShown'; hopIndex: number; candidates: Array<{ id: string; danger: boolean }> }): void;
  handleInput: ReturnType<typeof vi.fn>;
}

/** useChaseEngine이 소비하는 최소 표면(getSnapshot().lang·handleInput·subscribe)만 갖춘
 *  ChaseSessionEngine 목. getCandidateCountries()는 의도적으로 "직전 값"만 반환해(신선도 함정
 *  재현) 훅이 이 메서드에 의존하지 않음을 검증한다. */
function mockChaseEngine(lang: 'ko' | 'en'): MockEngine {
  const listeners = new Set<(e: never) => void>();
  const handleInput = vi.fn<(e: TypingEvent) => void>();
  const engine = {
    getSnapshot: () => ({ lang }),
    handleInput,
    subscribe: (f: (e: never) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    // 실 엔진의 실측 동작 재현: candidatesShown 리스너 실행 시점엔 아직 갱신 전이라 항상 빈 배열
    // (아무 것도 "신선"하지 않음)을 반환한다고 가정 — 훅이 이 값을 참조하면 곧바로 실패한다.
    getCandidateCountries: () => [],
  } as unknown as ChaseSessionEngine;
  return {
    engine,
    handleInput,
    emit: (e) => listeners.forEach((f) => f(e as never)),
  };
}

function Harness({
  engine,
  controllerBox,
}: {
  engine: ChaseSessionEngine;
  controllerBox?: MutableRefObject<TypingInputController | null>;
}) {
  const { inputRef, controller } = useChaseEngine(engine, ALL_COUNTRIES);
  useEffect(() => {
    if (controllerBox) controllerBox.current = controller;
  }, [controller, controllerBox]);
  return <input data-testid="inp" ref={inputRef} />;
}

afterEach(() => cleanup());

describe('useChaseEngine — 컨트롤러 배선(StrictMode 안전성 승계, WT-M2-09 패턴)', () => {
  it('StrictMode 이중 호출 후에도 타이핑 입력이 engine.handleInput으로 흐른다', () => {
    const mock = mockChaseEngine('ko');
    const controllerBox: MutableRefObject<TypingInputController | null> = { current: null };
    render(
      <StrictMode>
        <Harness engine={mock.engine} controllerBox={controllerBox} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;
    controllerBox.current!.setCountry(MN);

    input.value = 'ㅁ';
    fireEvent.input(input, { target: { value: 'ㅁ' } });

    expect(mock.handleInput).toHaveBeenCalled();
  });

  it('컨트롤러는 정확히 1개(중복 부착 없음)', () => {
    const mock = mockChaseEngine('ko');
    render(
      <StrictMode>
        <Harness engine={mock.engine} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    // skipRequested가 handleInput으로 1회만 전달돼야 한다(컨트롤러 2개 부착 시 2회).
    expect(mock.handleInput).toHaveBeenCalledWith({ type: 'skipRequested' });
    expect(mock.handleInput).toHaveBeenCalledTimes(1);
  });

  it('언마운트 시 컨트롤러가 detach되어 이후 이벤트가 흐르지 않는다', () => {
    const mock = mockChaseEngine('ko');
    const { unmount } = render(
      <StrictMode>
        <Harness engine={mock.engine} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;
    unmount();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mock.handleInput).not.toHaveBeenCalled();
  });
});

describe('useChaseEngine — D97 합성 Country 배선(engine.getCandidateCountries() 신선도 함정 회피)', () => {
  it('candidatesShown 이벤트 자체의 candidates[].id로(getCandidateCountries 미참조) 합성 Country를 주입한다', () => {
    const mock = mockChaseEngine('ko');
    const controllerBox: MutableRefObject<TypingInputController | null> = { current: null };
    render(<Harness engine={mock.engine} controllerBox={controllerBox} />);

    const setCountrySpy = vi.spyOn(controllerBox.current!, 'setCountry');
    mock.emit({
      type: 'candidatesShown',
      hopIndex: 1,
      candidates: [
        { id: 'MN', danger: false },
        { id: 'JP', danger: false },
        { id: 'KR', danger: true },
      ],
    });

    expect(setCountrySpy).toHaveBeenCalledTimes(1);
    const injected = setCountrySpy.mock.calls[0]![0];
    expect(injected.id).toBe(CHASE_COMPOSITE_ID);
    // getCandidateCountries()는 항상 []을 반환하는 목이므로, 이 결과가 채워졌다는 것 자체가
    // 이벤트의 candidates[].id를 직접 조회했다는 증거다(신선도 함정 회피 확인).
    expect(injected.acceptedInputsKo).toEqual(['몽골', '일본', '대한민국']);
  });

  it('candidatesShown 이후 합성 타깃 입력이 EXACT로 판정되어 engine.handleInput에 전달된다', () => {
    const mock = mockChaseEngine('ko');
    render(<Harness engine={mock.engine} />);
    const input = screen.getByTestId('inp') as HTMLInputElement;

    mock.emit({
      type: 'candidatesShown',
      hopIndex: 0,
      candidates: [
        { id: 'MN', danger: false },
        { id: 'JP', danger: false },
        { id: 'KR', danger: false },
      ],
    });

    input.value = '일본';
    fireEvent.input(input, { target: { value: '일본' } });

    const exactCall = mock.handleInput.mock.calls.find(([e]) => (e as TypingEvent).type === 'exact');
    expect(exactCall).toBeDefined();
  });

  it('이벤트의 후보 id가 countries 테이블에서 하나도 조회되지 않으면 setCountry를 호출하지 않는다(방어적)', () => {
    const mock = mockChaseEngine('ko');
    const controllerBox: MutableRefObject<TypingInputController | null> = { current: null };
    render(<Harness engine={mock.engine} controllerBox={controllerBox} />);
    const setCountrySpy = vi.spyOn(controllerBox.current!, 'setCountry');

    mock.emit({ type: 'candidatesShown', hopIndex: 0, candidates: [{ id: 'ZZ', danger: false }] });

    expect(setCountrySpy).not.toHaveBeenCalled();
  });
});
