// @vitest-environment jsdom
// spec: docs/03 §2.7 (TypingInputController), §2.5(EXACT 플러시/epoch), §2.6(버퍼 상한),
//       §2.9(라틴 혼입), §2.3(value-snapshot). 합성 이벤트(jsdom) 기반.
//
// QA 매트릭스(docs/03 §2.10) vitest 커버:
//   #1 도깨비불 "가나"        → PREFIX 유지 + delta 1/1/1/1
//   #2 복합 모음 "과테말라"의 "고" → PREFIX
//   #4 epoch 가드(단위 수준)   → EXACT 플러시 전에 캡처된 유령 compositionend 폐기
//   #7 조합 중 백스페이스       → removed 계상, 오타 아님
//   #8 붙여넣기                → preventDefault + bulkInsert
//   #10 버퍼 +8 상한           → 초과분 계상 제외
//   #11 ko 모드 영문 혼입       → MISS + (3자 이상 시) latinInKoMode 1회
//   #12 별칭 "한국"(캐노니컬 대한민국) → EXACT, 실입력 6타
// #3(조합 중 EXACT 지연 없음)·#5(Safari 순서)·#6(Gboard)은 WT-M2-08 E2E/실기기 소관.
// #9(창 블러 판 무효)은 엔진 practice 강등(WT-M2-02)/E2E 소관 — 여기선 blurred emit만 커버.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { TypingInputController, type TypingEvent } from './input-controller';

function makeCountry(over: Partial<Country>): Country {
  return {
    id: 'XX',
    iso3: 'XXX',
    nameKo: '',
    nameEn: '',
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: 1,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [],
    acceptedInputsEn: [],
    ...over,
  };
}

const GHANA = makeCountry({ id: 'GH', nameKo: '가나', acceptedInputsKo: ['가나'] });
const GUATEMALA = makeCountry({ id: 'GT', nameKo: '과테말라', acceptedInputsKo: ['과테말라'] });
const KOREA = makeCountry({
  id: 'KR',
  nameKo: '대한민국',
  aliasesKo: ['한국'],
  acceptedInputsKo: ['대한민국', '한국'],
});
const CHAD = makeCountry({ id: 'TD', nameEn: 'Chad', acceptedInputsEn: ['chad'] });

type EvtOf<T extends TypingEvent['type']> = Extract<TypingEvent, { type: T }>;

/** 타입 좁힌 필터. */
function eventsOf<T extends TypingEvent['type']>(events: TypingEvent[], type: T): EvtOf<T>[] {
  return events.filter((e): e is EvtOf<T> => e.type === type);
}

/** delta를 가진 이벤트(progress/miss/exact)의 added를 순서대로. */
function addedSeq(events: TypingEvent[]): number[] {
  const out: number[] = [];
  for (const e of events) {
    if (e.type === 'progress' || e.type === 'miss' || e.type === 'exact') out.push(e.delta.added);
  }
  return out;
}

let nowMs = 0;

interface Harness {
  input: HTMLInputElement;
  ctrl: TypingInputController;
  events: TypingEvent[];
  setNow(n: number): void;
  compositionStart(): void;
  compositionEnd(): void;
  type(value: string, composing?: boolean): void;
  paste(inputType?: string): boolean;
  keydown(key: string): boolean;
}

function harness(lang: 'ko' | 'en'): Harness {
  nowMs = 0;
  const input = document.createElement('input');
  document.body.appendChild(input);
  const ctrl = new TypingInputController(input, lang, () => nowMs);
  const events: TypingEvent[] = [];
  ctrl.subscribe((e) => events.push(e));
  ctrl.attach();
  return {
    input,
    ctrl,
    events,
    setNow: (n) => {
      nowMs = n;
    },
    compositionStart: () => input.dispatchEvent(new CompositionEvent('compositionstart')),
    compositionEnd: () => input.dispatchEvent(new CompositionEvent('compositionend')),
    type(value, composing = false) {
      input.value = value;
      input.dispatchEvent(new InputEvent('input', { isComposing: composing }));
    },
    paste(inputType = 'insertFromPaste') {
      const e = new InputEvent('beforeinput', { inputType, cancelable: true });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    },
    keydown(key) {
      const e = new KeyboardEvent('keydown', { key, cancelable: true });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('TypingInputController', () => {
  // #1
  it('doggaebi "가나": stays PREFIX with no miss, deltas 1/1/1/1, ends EXACT', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('ㄱ', true);
    h.type('가', true);
    h.type('간', true);
    h.type('가나', true); // EXACT
    expect(eventsOf(h.events, 'miss')).toHaveLength(0);
    expect(addedSeq(h.events)).toEqual([1, 1, 1, 1]);
    expect(eventsOf(h.events, 'exact')).toHaveLength(1);
  });

  // #2
  it('"과테말라" at "고" is PREFIX (compound vowel mid-composition)', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GUATEMALA);
    h.compositionStart();
    h.type('고', true); // ㄱㅗ ⊂ ㄱㅗㅏ... → PREFIX
    const prog = eventsOf(h.events, 'progress');
    expect(prog).toHaveLength(1);
    expect(prog[0]?.detail.state).toBe('PREFIX');
    expect(eventsOf(h.events, 'miss')).toHaveLength(0);
  });

  // #7
  it('backspace 간→가→ㄱ: removed counted, not an error', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('간', true);
    h.type('가', true);
    h.type('ㄱ', true);
    expect(eventsOf(h.events, 'miss')).toHaveLength(0);
    const prog = eventsOf(h.events, 'progress');
    expect(prog[1]).toMatchObject({ delta: { added: 0, removed: 1, addedError: 0 } });
    expect(prog[2]).toMatchObject({ delta: { added: 0, removed: 1, addedError: 0 } });
  });

  // #12
  it('alias "한국" (canonical "대한민국") reaches EXACT and counts 6 real keystrokes', () => {
    const h = harness('ko');
    h.ctrl.setCountry(KOREA);
    h.compositionStart();
    h.type('ㅎ', true);
    h.type('하', true);
    h.type('한', true);
    h.type('한ㄱ', true);
    h.type('한구', true);
    h.type('한국', true); // EXACT (ㅎㅏㄴㄱㅜㄱ)
    expect(eventsOf(h.events, 'exact')).toHaveLength(1);
    expect(addedSeq(h.events).reduce((a, b) => a + b, 0)).toBe(6);
  });

  // §2.5 — 플러시 프로토콜: blur → value='' → focus 순서 + 동기성(같은 tick)
  it('EXACT while composing flushes blur→clear→focus synchronously, in order', () => {
    const h = harness('ko');
    const order: string[] = [];
    vi.spyOn(h.input, 'blur').mockImplementation(() => order.push(`blur:${h.input.value}`));
    vi.spyOn(h.input, 'focus').mockImplementation(() => order.push(`focus:${h.input.value}`));
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('ㄱ', true);
    h.type('가', true);
    h.type('간', true);
    h.type('가나', true); // EXACT → flushIme
    // 전부 동기: 별도 await 없이 이 시점에서 이미 완료되어야 한다(§2.5 iOS 계약, setTimeout 금지).
    expect(order).toEqual(['blur:가나', 'focus:']);
    expect(h.input.value).toBe('');
    expect(eventsOf(h.events, 'exact')).toHaveLength(1);
  });

  // §2.5 (else 분기) — 조합 아님(en): blur 없이 value만 비운다 + elapsedFromShownMs 보고
  it('en EXACT clears value without blur and reports elapsed from shown', () => {
    const h = harness('en');
    const blurSpy = vi.spyOn(h.input, 'blur');
    h.setNow(1000);
    h.ctrl.setCountry(CHAD); // shownAt = 1000
    h.setNow(1350);
    h.type('chad'); // EXACT
    const exact = eventsOf(h.events, 'exact');
    expect(exact).toHaveLength(1);
    expect(exact[0]?.elapsedFromShownMs).toBe(350);
    expect(h.input.value).toBe('');
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('uses performance.now when no clock is injected (default param)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const ctrl = new TypingInputController(input, 'en'); // 기본 now = performance.now
    const events: TypingEvent[] = [];
    ctrl.subscribe((e) => events.push(e));
    ctrl.attach();
    ctrl.setCountry(CHAD);
    input.value = 'chad';
    input.dispatchEvent(new InputEvent('input'));
    const exact = eventsOf(events, 'exact');
    expect(exact).toHaveLength(1);
    expect(exact[0]?.elapsedFromShownMs).toBeGreaterThanOrEqual(0);
  });

  // #4 — epoch 가드: EXACT 플러시 이전에 캡처된 compositionend는 microtask에서 폐기
  it('epoch guard: compositionend captured before the EXACT flush is discarded', async () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('ㄱ', true);
    h.type('가', true);
    h.type('간', true);
    // Safari 순서 모사: 최종 input 이전에 compositionend가 먼저(epoch=E 캡처, microtask 예약)
    h.input.value = '가나';
    h.compositionEnd();
    // 최종 input → EXACT → flushIme(epoch E→E+1)
    h.input.dispatchEvent(new InputEvent('input', { isComposing: false }));
    await Promise.resolve();
    await Promise.resolve();
    // 유령 compositionend의 microtask는 cap!==epoch로 폐기 → 마지막 이벤트는 여전히 exact
    expect(eventsOf(h.events, 'exact')).toHaveLength(1);
    expect(h.events[h.events.length - 1]?.type).toBe('exact');
  });

  it('compositionend re-evaluates when epoch is unchanged (Safari order safety)', async () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('가', true); // progress
    const before = h.events.length;
    h.compositionEnd(); // 플러시 없었음 → cap===epoch → microtask에서 재평가 실행
    await Promise.resolve();
    expect(h.events.length).toBe(before + 1);
    expect(h.events[h.events.length - 1]?.type).toBe('progress');
  });

  // #8
  it('paste triggers preventDefault and bulkInsert', () => {
    const h = harness('ko');
    h.ctrl.setCountry(KOREA);
    const prevented = h.paste('insertFromPaste');
    expect(prevented).toBe(true);
    expect(eventsOf(h.events, 'bulkInsert')).toHaveLength(1);
  });

  it('insertReplacementText and insertFromDrop are treated as bulk', () => {
    const h = harness('ko');
    h.ctrl.setCountry(KOREA);
    expect(h.paste('insertReplacementText')).toBe(true);
    expect(h.paste('insertFromDrop')).toBe(true);
    expect(eventsOf(h.events, 'bulkInsert')).toHaveLength(2);
  });

  it('non-bulk beforeinput (insertText) is passed through', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    expect(h.paste('insertText')).toBe(false);
    expect(eventsOf(h.events, 'bulkInsert')).toHaveLength(0);
  });

  it('a single snapshot adding >8 jamo emits bulkInsert (swipe) and suppresses exact', () => {
    const h = harness('ko');
    h.ctrl.setCountry(KOREA); // 대한민국 = 11 자모
    h.compositionStart();
    h.type('대한민국', true); // 한 스냅샷 11 자모 > 8
    expect(eventsOf(h.events, 'bulkInsert')).toHaveLength(1);
    expect(eventsOf(h.events, 'exact')).toHaveLength(0);
  });

  // #10
  it('buffer cap: input beyond bestTarget.key.length+8 stops being counted', () => {
    const h = harness('en');
    h.ctrl.setCountry(CHAD); // bestTarget "chad" (len 4) → cap 12
    let v = '';
    for (let i = 1; i <= 14; i++) {
      v += 'z'; // 'chad'와 어긋나는 오타 스트림 (EXACT 없음)
      h.type(v);
    }
    const added = addedSeq(h.events);
    expect(added).toHaveLength(14);
    // 길이 1..12 스냅샷: 각 1타 계상 / 길이 13,14: 초과분 → 계상 0
    expect(added.slice(0, 12)).toEqual(Array(12).fill(1));
    expect(added.slice(12)).toEqual([0, 0]);
  });

  // #11
  it('ko latin: single char = MISS no toast; 3+ latin = MISS + latinInKoMode once', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.type('d'); // MISS, 라틴 1자 → 토스트 없음
    expect(eventsOf(h.events, 'miss')).toHaveLength(1);
    expect(eventsOf(h.events, 'latinInKoMode')).toHaveLength(0);
    h.type('dd');
    h.type('ddd'); // 라틴 3자 → latinInKoMode 1회
    h.type('dddd'); // 이미 경고됨 → 재발생 없음
    expect(eventsOf(h.events, 'latinInKoMode')).toHaveLength(1);
    expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(4);
  });

  it('Escape requests skip (preventDefault); other keys are never prevented', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    expect(h.keydown('Escape')).toBe(true);
    expect(eventsOf(h.events, 'skipRequested')).toHaveLength(1);
    expect(h.keydown('a')).toBe(false); // IME 파이프라인 보존
  });

  it('emits blurred and refocused on blur/focus events (GDD §5.5)', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.input.dispatchEvent(new FocusEvent('blur'));
    h.input.dispatchEvent(new FocusEvent('focus'));
    expect(eventsOf(h.events, 'blurred')).toHaveLength(1);
    expect(eventsOf(h.events, 'refocused')).toHaveLength(1);
  });

  it('detach removes all listeners', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.ctrl.detach();
    h.type('가', true);
    h.keydown('Escape');
    h.input.dispatchEvent(new FocusEvent('blur'));
    expect(h.events).toHaveLength(0);
  });

  it('clear() flushes the buffer while composing', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.compositionStart();
    h.type('가', true);
    h.ctrl.clear();
    expect(h.input.value).toBe('');
  });

  it('focus() focuses the input with preventScroll', () => {
    const h = harness('ko');
    const spy = vi.spyOn(h.input, 'focus');
    h.ctrl.focus();
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('subscribe returns an unsubscribe function', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    const seen: TypingEvent[] = [];
    const off = h.ctrl.subscribe((e) => seen.push(e));
    h.type('가', true);
    off();
    h.type('간', true);
    expect(seen).toHaveLength(1);
  });

  // §2.5 안전망: 새 국가 제시 시 잔여 버퍼가 있으면 즉시 재평가
  it('setCountry with residual buffer re-evaluates immediately', () => {
    const h = harness('ko');
    h.input.value = '한';
    h.ctrl.setCountry(KOREA);
    const prog = eventsOf(h.events, 'progress');
    expect(prog.length).toBeGreaterThanOrEqual(1);
    expect(prog[0]?.detail.state).toBe('PREFIX');
  });

  it('ignores input events before setCountry (empty-targets guard)', () => {
    const h = harness('ko');
    h.type('가');
    expect(h.events).toHaveLength(0);
  });
});
