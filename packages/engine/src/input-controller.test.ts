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
// D70 Gboard 접두 스트립 테스트용: 옛 값 '가나'가 접두로 재삽입된 뒤 확장분('다')이 이 타깃의
// 접두(다도=ㄷㅏㄷㅗ)로 평가되는지 확인하기 위한 합성 국가('다'는 ㄷㅏ, '다도' 접두).
const DADO = makeCountry({ id: 'DD', nameKo: '다도', acceptedInputsKo: ['다도'] });

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

/**
 * "내용 이벤트"(progress/miss/exact) 개수. D70 재삽입/기저붕괴 삼킴 검증에서 flushIme의 자기유발
 * focus가 내는 refocused 노이즈를 세지 않고 "실제로 계상되는 입력이 있었는가"만 본다.
 */
function contentCount(events: TypingEvent[]): number {
  return events.filter((e) => e.type === 'progress' || e.type === 'miss' || e.type === 'exact')
    .length;
}

/** GHANA(가나)를 조합 중 EXACT로 확정해 flushIme의 staleEcho(='ㄱㅏㄴㅏ')를 세팅한다(공통 준비). */
function reachGhanaExact(h: Harness): void {
  h.ctrl.setCountry(GHANA);
  h.compositionStart();
  h.type('ㄱ', true);
  h.type('가', true);
  h.type('간', true);
  h.type('가나', true); // EXACT → 조합 중 flushIme(staleEcho 세팅)
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

  // 회귀 방지: flushIme()가 조합 중 EXACT를 강제 확정하려고 스스로 부르는 input.blur()는 실제
  // 브라우저 'blur' 이벤트를 진짜로 일으킨다(위 테스트처럼 mock으로 감추지 않는다) — 이게
  // 'blurred'로 새면 실사용자의 한글 IME 조합 중 확정마다(흔한 경로) 매번 practice로 강등되는
  // 회귀가 생긴다(engine session.ts case 'blurred' → degrade). blur()/focus()를 실제로 호출해
  // native 이벤트가 진짜 발생하는 상태에서 검증한다(§2.5, 이전 테스트는 h.input.blur를 스텁해
  // 이 leak을 가리고 있었다 — 순서만 검증).
  it('self-induced flushIme blur (composing EXACT) does NOT leak as a "blurred" TypingEvent', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.input.focus(); // 실제 포커스 상태에서 시작해야 이후 blur()가 진짜 이벤트를 낸다.
    h.compositionStart();
    h.type('ㄱ', true);
    h.type('가', true);
    h.type('간', true);
    h.type('가나', true); // EXACT while composing → flushIme의 자기유발 blur→clear→focus.
    expect(eventsOf(h.events, 'blurred')).toHaveLength(0);
    expect(eventsOf(h.events, 'exact')).toHaveLength(1);
    expect(document.activeElement).toBe(h.input); // 플러시 후 포커스 복귀 확인.
  });

  // 대조군: 자기유발 blur 억제 로직이 진짜 외부 blur까지 삼키면 안 된다(GDD §5.5 practice
  // 강등이 계속 동작해야 함) — flushIme 밖에서 발생한 blur는 그대로 emit된다.
  it('a genuine external blur (not from flushIme) still emits "blurred"', () => {
    const h = harness('ko');
    h.ctrl.setCountry(GHANA);
    h.input.focus();
    h.input.blur(); // 사용자가 창을 벗어난 것과 동등 — flushIme 경유가 아니다.
    expect(eventsOf(h.events, 'blurred')).toHaveLength(1);
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

  // docs/00 §11-D70: setCountry는 잔여 버퍼를 새 타깃으로 재평가하지 않고 권위적으로 비운다
  // (구 §2.5 "잔여 즉시 재평가" 안전망 폐기 — 그 재평가가 실버그의 근원이었다).
  it('setCountry clears a residual buffer instead of re-evaluating it (D70 authoritative clear)', () => {
    const h = harness('ko');
    h.input.value = '한'; // 이전 국가에서 넘어온 잔여
    h.ctrl.setCountry(KOREA);
    expect(h.input.value).toBe(''); // 새 타깃으로 평가하지 않고 비운다
    expect(eventsOf(h.events, 'progress')).toHaveLength(0);
    expect(eventsOf(h.events, 'miss')).toHaveLength(0);
  });

  it('ignores input events before setCountry (empty-targets guard)', () => {
    const h = harness('ko');
    h.type('가');
    expect(h.events).toHaveLength(0);
  });

  // ── docs/00 §11-D70: flush 후 재삽입/스킵-잔여/Gboard 접두 처리 ─────────────────────────
  describe('D70 buffer ownership (reinsert / skip-residual / Gboard prefix)', () => {
    // ① 재삽입 삼킴 + 재플러시: EXACT 플러시 후 IME focus-복귀가 옛 자모열('가나')을 48ms 내 다시
    //   삽입하면 무이벤트로 삼키고 재플러시한다(유령 miss 없음, 버퍼 비워짐).
    it('reinserted stale tail within 48ms is swallowed and re-flushed (no content event, buffer cleared)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // staleEcho='ㄱㅏㄴㅏ', flushAt=0
      const before = contentCount(h.events);
      h.setNow(20); // 재삽입 윈도우(≤48ms) 안
      h.ctrl.setCountry(KOREA); // 권위적 클리어(value=''라 no-op), staleEcho 이월, reinsertFlushes=0
      h.type('가나', true); // IME focus-복귀 재삽입: ≥2자모 + stale 꼬리일치 → 삼킴
      expect(contentCount(h.events)).toBe(before); // progress/miss/exact 무증가
      expect(eventsOf(h.events, 'miss')).toHaveLength(0);
      expect(h.input.value).toBe(''); // 재플러시로 비워짐
    });

    // ② 0ms 단일 자모 비삼킴(§2.10 #4 보존): 확정 직후 0ms에 친 다음 국가 첫 타(자모 1개)는
    //   staleEcho가 세팅돼 있어도 절대 삼켜지지 않는다.
    it('a single jamo at 0ms after flush is NEVER swallowed (§2.10 #4)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // staleEcho='ㄱㅏㄴㅏ', flushAt=0
      const before = contentCount(h.events);
      h.ctrl.setCountry(KOREA); // 대한민국
      h.compositionStart();
      h.type('ㅎ', true); // 0ms, 자모 1개 → genuine
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX'); // ㅎ은 대한민국/한국 접두
    });

    // ③ 48ms 초과 비삼킴: 옛 꼬리와 동일한 ≥2자모라도 윈도우를 벗어나면 genuine으로 평가한다.
    it('stale tail after the 48ms window is NOT swallowed (treated as genuine → MISS)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // flushAt=0
      const before = contentCount(h.events);
      h.setNow(49); // 윈도우 밖
      h.ctrl.setCountry(KOREA);
      h.type('가나', true); // '가나'는 대한민국/한국 접두 아님 → genuine MISS
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
    });

    // ④ Gboard 접두 스트립 + getValue: 옛 전체값('가나')이 접두로 재삽입되고 사용자가 확장('다')을
    //   더하면, 접두를 가상 스트립해 확장분만 평가하고 getValue도 접두를 제외한다.
    it('Gboard stale-prefix strip: evaluates only the extension and getValue excludes the virtual prefix', () => {
      const h = harness('ko');
      h.setNow(100);
      reachGhanaExact(h); // staleRaw='가나', flushAt=100
      h.setNow(300); // 윈도우 밖(Gboard 분기는 시간 제약 없음)
      h.ctrl.setCountry(DADO); // 다도(ㄷㅏㄷㅗ)
      h.type('가나다', true); // '가나'(옛 값) 접두 + '다' 확장
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX'); // 확장분 '다'가 '다도' 접두로 평가됨
      expect(h.ctrl.getValue()).toBe('다'); // 가상 접두 '가나' 제외
      // 확장을 이어가면 basePrefix 분기가 연장분만 넘긴다.
      h.type('가나다도', true); // EXACT('다도')
      const exacts = eventsOf(h.events, 'exact'); // [GHANA '가나', DADO '다도']
      expect(exacts).toHaveLength(2);
      expect(exacts.at(-1)?.detail.bestTarget.display).toBe('다도');
      expect(h.ctrl.getValue()).toBe(''); // EXACT flush로 basePrefix·버퍼 리셋
    });

    // ⑤ 기저 붕괴 조용 flush: basePrefix가 세워진 뒤 value가 더 이상 접두로 시작하지 않으면
    //   (IME가 접두를 삼킴) 조용히 재플러시하고 리셋한다(내용 이벤트 없음).
    it('base-prefix collapse silently flushes and resets (no content event)', () => {
      const h = harness('ko');
      h.setNow(100);
      reachGhanaExact(h);
      h.setNow(300);
      h.ctrl.setCountry(DADO);
      h.type('가나다', true); // Gboard strip → basePrefix='가나', progress '다'
      const before = contentCount(h.events);
      h.type('다', true); // value가 더 이상 '가나'로 시작하지 않음 → 기저 붕괴
      expect(contentCount(h.events)).toBe(before); // 조용한 리셋
      expect(h.input.value).toBe(''); // 재플러시
      expect(h.ctrl.getValue()).toBe('');
    });

    // ⑥ setCountry 스킵 클리어: 조합 중 ESC 스킵(컨트롤러는 버퍼를 비우지 않음) 후 다음 국가
    //   제시가 잔여를 권위적으로 비운다 → 유령 miss 없음(D70 진단 (1) 스킵 경로).
    it('setCountry clears residual left by a skip (ESC) — new country starts empty, no ghost miss', () => {
      const h = harness('ko');
      h.ctrl.setCountry(GHANA);
      h.compositionStart();
      h.type('ㅂ', true); // 가나와 어긋나는 조합 중 잔여
      h.keydown('Escape'); // 스킵 요청만(컨트롤러는 flush하지 않는다)
      expect(h.input.value).toBe('ㅂ'); // 잔여 남아 있음
      const before = contentCount(h.events);
      h.ctrl.setCountry(KOREA); // 다음 국가 제시 → 권위적 클리어
      expect(h.input.value).toBe(''); // 새 국가 = 빈 버퍼
      expect(contentCount(h.events)).toBe(before); // 잔여 재평가로 인한 유령 이벤트 없음
    });

    // ⑦ MAX_REINSERT_FLUSHES fail-open: 재삽입을 3회 삼킨 뒤에는 더 이상 삼키지 않고 genuine
    //   처리한다(무한 삼킴/입력 잠금 방지).
    it('after MAX_REINSERT_FLUSHES swallows, further stale reinsertions fail open (processed)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // staleEcho='ㄱㅏㄴㅏ', flushAt=0
      h.ctrl.setCountry(KOREA); // reinsertFlushes=0
      for (let i = 0; i < 3; i++) {
        // 3 = MAX_REINSERT_FLUSHES(internal)
        h.setNow(10); // 매 재플러시가 flushAt=10으로 갱신 → 항상 윈도우 안
        h.type('가나', true); // 3회 연속 삼킴
      }
      const before = contentCount(h.events);
      h.setNow(10);
      h.type('가나', true); // 4번째 → reinsertFlushes 상한 도달 → genuine MISS
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
    });

    // ⑧ 자기유발 compositionend no-op: 조합 중 EXACT 플러시가 유발한 compositionend는 epoch++가
    //   blur 뒤로 재배열됐으므로 옛 epoch를 캡처 → microtask에서 폐기된다(구세대화). exact가
    //   유일한 마지막 이벤트여야 한다(재배열 이전에는 여기서 유령 progress가 새어 나왔다).
    it('self-induced compositionend (from flush blur) is discarded — epoch captured before increment', async () => {
      const h = harness('ko');
      h.ctrl.setCountry(GHANA);
      // 브라우저 실제 동작 모사: blur()가 동기 compositionend를 유발한다.
      const realBlur = h.input.blur.bind(h.input);
      vi.spyOn(h.input, 'blur').mockImplementation(() => {
        realBlur();
        h.input.dispatchEvent(new CompositionEvent('compositionend'));
      });
      h.compositionStart();
      h.type('ㄱ', true);
      h.type('가', true);
      h.type('간', true);
      h.type('가나', true); // EXACT → flushIme: blur→compositionend(옛 epoch), 이후 epoch++
      await Promise.resolve();
      await Promise.resolve();
      expect(eventsOf(h.events, 'exact')).toHaveLength(1);
      expect(h.events.at(-1)?.type).toBe('exact'); // 유령 재평가 없음
    });
  });
});
