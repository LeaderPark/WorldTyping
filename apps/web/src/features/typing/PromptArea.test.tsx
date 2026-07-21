// @vitest-environment jsdom
//
// spec: docs/03 §2.7(컨트롤러 파이프·hidden input·포커스 유지), §2.8(채색), §2.10 #1(가나 무오타),
//       §4.4(useTypingEngine). WT-M2-03.
//
// 실제 컨트롤러→엔진→렌더러 파이프라인을 조립해 값-스냅샷 입력을 흘려보내며 검증한다(단위 렌더러
// 테스트가 커버 못 하는 배선·hidden input 계약·포커스 유지까지 포함).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useEffect, useState } from 'react';
import { GameSessionEngine, continentRules, type EngineDeps } from '@wt/engine';
import type { Country } from '@wt/shared';
import { HiddenTypingInput } from './HiddenTypingInput';
import { PromptArea } from './PromptArea';
import { useTypingEngine } from './useTypingEngine';

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
const MONGOLIA = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia' });

/** 수동 플러시 가능한 가상 시계(엔진 deps). 컨트롤러는 자체 perf.now를 쓰므로 무관. */
function makeClock() {
  let t = 0;
  const timers: { cb: () => void; at: number }[] = [];
  const deps: EngineDeps = {
    now: () => t,
    schedule: (cb, ms) => {
      const rec = { cb, at: t + ms };
      timers.push(rec);
      return () => {
        const i = timers.indexOf(rec);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    rules: continentRules(),
  };
  function advance(ms: number) {
    t += ms;
    for (;;) {
      const idx = timers.findIndex((x) => x.at <= t);
      if (idx < 0) break;
      const [rec] = timers.splice(idx, 1);
      rec!.cb();
    }
  }
  return { deps, advance };
}

function Harness({ engine, countries }: { engine: GameSessionEngine; countries: Country[] }) {
  const { inputRef, controller, getInputValue } = useTypingEngine(engine);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!controller) return;
    const unsub = engine.subscribe((e) => {
      if (e.type === 'countryShown') {
        setIndex(e.index);
        controller.setCountry(countries[e.index]!);
      }
    });
    engine.start();
    return () => {
      unsub();
      engine.abort();
    };
  }, [engine, controller, countries]);

  return (
    <div>
      <PromptArea
        country={countries[index]!}
        lang="ko"
        controller={controller}
        getInputValue={getInputValue}
        juiceLevel={2}
      />
      <HiddenTypingInput inputRef={inputRef} />
    </div>
  );
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    input.value = value;
    fireEvent.input(input, { target: { value } });
  });
}

afterEach(() => cleanup());

describe('HiddenTypingInput — §2.7 말미 스펙', () => {
  it('IME 안전 속성이 스펙대로 설정된다', () => {
    const { deps } = makeClock();
    const engine = new GameSessionEngine(deps, [GHANA], 'ko');
    render(<Harness engine={engine} countries={[GHANA]} />);
    const input = screen.getByTestId('hidden-typing-input') as HTMLInputElement;
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('enterkeyhint')).toBe('next');
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.style.opacity).toBe('0.01');
    expect(input.style.position).toBe('fixed');
  });

  it('비상호작용 요소 pointerdown 시 입력으로 포커스를 되찾는다(포커스 유지 계약)', () => {
    const { deps } = makeClock();
    const engine = new GameSessionEngine(deps, [GHANA], 'ko');
    render(<Harness engine={engine} countries={[GHANA]} />);
    const input = screen.getByTestId('hidden-typing-input') as HTMLInputElement;
    (document.activeElement as HTMLElement)?.blur();
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).toBe(input);
  });
});

describe('파이프라인 — 가나 도깨비불 무오타 후 다음 국가로 진행', () => {
  it('ㄱ→가→간→가나 중 오타 채색이 없고, 확정 후 몽골로 넘어간다', () => {
    const { deps, advance } = makeClock();
    const engine = new GameSessionEngine(deps, [GHANA, MONGOLIA], 'ko');
    render(<Harness engine={engine} countries={[GHANA, MONGOLIA]} />);
    const input = screen.getByTestId('hidden-typing-input') as HTMLInputElement;

    // 카운트다운 종료 → playing → 첫 국가(가나) 제시
    act(() => advance(3000));
    const mount = screen.getByTestId('prompt-mount');
    expect(mount.textContent).toBe('가나');

    for (const raw of ['ㄱ', '가', '간']) {
      type(input, raw);
      expect(mount.querySelector('.is-error')).toBeNull();
    }
    // "간" 시점: 받침이 둘째 음절 커서로 흡수 → 오타 아님
    expect(mount.querySelectorAll('.is-error').length).toBe(0);

    // 확정 → 다음 국가(몽골) 마운트
    type(input, '가나');
    const mountAfter = screen.getByTestId('prompt-mount');
    expect(mountAfter.textContent).toBe('몽골');
    // 확정 순간 EXACT 플러시로 입력 버퍼는 비워진다(§2.5)
    expect(input.value).toBe('');
  });

  it('오타 입력 시 해당 음절이 error 채색 + 컨테이너 셰이크', () => {
    const { deps, advance } = makeClock();
    const engine = new GameSessionEngine(deps, [GHANA], 'ko');
    render(<Harness engine={engine} countries={[GHANA]} />);
    const input = screen.getByTestId('hidden-typing-input') as HTMLInputElement;
    act(() => advance(3000));

    type(input, '가바'); // 가 뒤 오타 ㅂ
    const mount = screen.getByTestId('prompt-mount');
    expect(mount.querySelectorAll('.is-error').length).toBe(1);
    // 렌더러는 마운트 요소 자신에 wt-prompt(+ --shake)를 붙인다.
    expect(mount.classList.contains('wt-prompt')).toBe(true);
    expect(mount.classList.contains('wt-prompt--shake')).toBe(true);
  });
});
