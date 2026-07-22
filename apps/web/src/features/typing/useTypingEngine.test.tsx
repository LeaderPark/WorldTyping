// @vitest-environment jsdom
//
// spec: docs/03 §2.7(컨트롤러 라이프사이클)·§4.4(useTypingEngine 시그니처)·§4.5(고빈도 값 규약),
//       docs/00 §11-D33(useTypingEngine 반환 계약)·D37(dev 플레이도 동작해야 함), WT-M2-09.
//
// [회귀 방지 대상] vite dev는 apps/web을 <StrictMode>로 감싸 마운트 직후 effect를 이중 호출
// (setup→cleanup→setup)한다. 과거 useTypingEngine은 attach/detach를 ref 콜백에 두고
// `useEffect(()=>teardown)`만 뒀기에, StrictMode 이중 호출의 cleanup이 컨트롤러를 detach만 하고
// ref 콜백은 재호출되지 않아 재부착이 누락됐다 — dev 빌드에서 hidden input에 컨트롤러가 안 붙어
// 타이핑·ESC가 엔진에 전혀 전달되지 않았다. 이 테스트는 <StrictMode>로 마운트해 이중 호출 이후에도
// 컨트롤러가 정확히 1개 부착되어 입력(ESC·타이핑)이 엔진(handleInput)으로 흐르는지 검증한다.
import { StrictMode, useEffect, type MutableRefObject } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TypingInputController,
  type GameSessionEngine,
  type TypingEvent,
} from '@wt/engine';
import type { Country } from '@wt/shared';
import { useTypingEngine } from './useTypingEngine';

/** useTypingEngine이 소비하는 최소 표면(getSnapshot().lang · handleInput)만 갖춘 엔진 목. */
function mockEngine(lang: 'ko' | 'en', onInput: (e: TypingEvent) => void): GameSessionEngine {
  return {
    getSnapshot: () => ({ lang }),
    handleInput: onInput,
  } as unknown as GameSessionEngine;
}

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn'>): Country {
  return {
    iso3: 'XXX', aliasesKo: [], aliasesEn: [], continent: 'asia', subregion: '',
    difficultyTier: 1, capitalKo: '', capitalEn: '', flagEmoji: '🏳️', population: 0,
    latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: [p.nameKo], acceptedInputsEn: [p.nameEn.toLowerCase()],
    ...p,
  };
}
const GHANA = mk({ id: 'GH', nameKo: '가나', nameEn: 'ghana' });

function Harness({
  engine,
  controllerBox,
  onRequestSkip,
}: {
  engine: GameSessionEngine;
  controllerBox?: MutableRefObject<TypingInputController | null>;
  onRequestSkip?: MutableRefObject<(() => void) | null>;
}) {
  const { inputRef, controller, requestSkip } = useTypingEngine(engine);
  useEffect(() => {
    if (controllerBox) controllerBox.current = controller;
    if (onRequestSkip) onRequestSkip.current = requestSkip;
  }, [controller, controllerBox, requestSkip, onRequestSkip]);
  return <input data-testid="inp" ref={inputRef} />;
}

afterEach(() => cleanup());

describe('useTypingEngine — StrictMode 안전성(WT-M2-09)', () => {
  it('StrictMode 이중 호출 후 ESC가 엔진으로 흐른다(컨트롤러 부착 유지)', () => {
    const handleInput = vi.fn<(e: TypingEvent) => void>();
    render(
      <StrictMode>
        <Harness engine={mockEngine('ko', handleInput)} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;

    fireEvent.keyDown(input, { key: 'Escape' });

    // 이중 호출 후에도 컨트롤러가 부착돼 skipRequested가 엔진에 전달돼야 한다(과거 결함: 0회).
    expect(handleInput).toHaveBeenCalledWith({ type: 'skipRequested' });
  });

  it('StrictMode 이중 호출 후에도 컨트롤러는 정확히 1개(중복 부착/누수 없음)', () => {
    const handleInput = vi.fn<(e: TypingEvent) => void>();
    render(
      <StrictMode>
        <Harness engine={mockEngine('ko', handleInput)} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;

    fireEvent.keyDown(input, { key: 'Escape' });

    // 컨트롤러가 2개 붙었다면(cleanup 누락) skipRequested가 2회 발사된다.
    expect(handleInput).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 마운트 후 타이핑 입력이 엔진으로 흐른다(progress/exact 계열 이벤트)', () => {
    const events: TypingEvent[] = [];
    const controllerBox: MutableRefObject<TypingInputController | null> = { current: null };
    render(
      <StrictMode>
        <Harness engine={mockEngine('en', (e) => events.push(e))} controllerBox={controllerBox} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;

    // 컨트롤러는 effect에서 부착·노출된다(render가 act로 이펙트를 플러시하므로 이미 채워져 있다).
    const controller = controllerBox.current;
    expect(controller).not.toBeNull();
    controller!.setCountry(GHANA);

    input.value = 'g';
    fireEvent.input(input, { target: { value: 'g' } });

    // 타이핑 한 글자라도 타이핑 계열 이벤트(progress|miss|exact)가 엔진으로 흘러야 한다.
    expect(events.some((e) => e.type === 'progress' || e.type === 'miss' || e.type === 'exact')).toBe(
      true,
    );
  });

  it('언마운트 시 컨트롤러가 detach되어 이후 이벤트가 흐르지 않는다', () => {
    const handleInput = vi.fn<(e: TypingEvent) => void>();
    const { unmount } = render(
      <StrictMode>
        <Harness engine={mockEngine('ko', handleInput)} />
      </StrictMode>,
    );
    const input = screen.getByTestId('inp') as HTMLInputElement;
    unmount();

    // detach된 뒤 남은 요소에 ESC를 쏴도 엔진으로 전달되지 않는다.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(handleInput).not.toHaveBeenCalled();
  });

  it('requestSkip()이 데스크톱 ESC와 동일하게 skipRequested를 엔진에 전달한다(모바일 스킵 버튼, WT-M5-02)', () => {
    const handleInput = vi.fn<(e: TypingEvent) => void>();
    const skipBox: MutableRefObject<(() => void) | null> = { current: null };
    render(
      <StrictMode>
        <Harness engine={mockEngine('ko', handleInput)} onRequestSkip={skipBox} />
      </StrictMode>,
    );

    skipBox.current?.();

    expect(handleInput).toHaveBeenCalledWith({ type: 'skipRequested' });
  });

  it('부착 전(요소 없음) requestSkip()은 예외 없이 no-op', () => {
    function Bare() {
      const { requestSkip } = useTypingEngine(mockEngine('ko', vi.fn()));
      useEffect(() => {
        requestSkip();
      }, [requestSkip]);
      return null;
    }
    expect(() => render(<Bare />)).not.toThrow();
  });
});
