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
const CUBA = makeCountry({ id: 'CU', nameEn: 'Cuba', acceptedInputsEn: ['cuba'] });
// D70 Gboard 접두 스트립 테스트용: 옛 값 '가나'가 접두로 재삽입된 뒤 확장분('다')이 이 타깃의
// 접두(다도=ㄷㅏㄷㅗ)로 평가되는지 확인하기 위한 합성 국가('다'는 ㄷㅏ, '다도' 접두).
const DADO = makeCountry({ id: 'DD', nameKo: '다도', acceptedInputsKo: ['다도'] });
// D84(버그 W) 부분 꼬리 스트립 테스트용. INDIA(인도=ㅇㅣㄴㄷㅗ)를 EXACT로 확정하면 staleEcho의
// 끝 음절이 '도'(ㄷㅗ, ≥2자모)라, 다음 국가 첫 타와 병합된 '도대'류 스냅샷을 재현할 수 있다.
// DOMINICA(도미니카)는 over-strip 가드용 — 전 국가 끝 음절 '도'로 시작하는 genuine 병합 입력이
// 전체 판정 PREFIX면 스트립되지 않고 보존됨을 잠근다(의미 중재).
const INDIA = makeCountry({ id: 'IN', nameKo: '인도', acceptedInputsKo: ['인도'] });
const DOMINICA = makeCountry({ id: 'DM', nameKo: '도미니카', acceptedInputsKo: ['도미니카'] });

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

/** INDIA(인도)를 조합 중 EXACT로 확정해 staleEcho(='ㅇㅣㄴㄷㅗ', 끝 음절 '도')를 세팅한다(버그 W). */
function reachIndiaExact(h: Harness): void {
  h.ctrl.setCountry(INDIA);
  h.compositionStart();
  h.type('ㅇ', true);
  h.type('이', true);
  h.type('인', true);
  h.type('인ㄷ', true);
  h.type('인도', true); // EXACT → 조합 중 flushIme, staleEcho='ㅇㅣㄴㄷㅗ' / staleRaw='인도'
}

/**
 * INDIA(인도)를 **비조합 경로**로 EXACT 확정한다(D104 구멍 A). 마지막 input 이벤트보다
 * compositionend가 먼저 오는 순서(조기 compositionend·Safari 역전)에서는 EXACT가 compositionend가
 * 예약한 microtask 재평가(ev=undefined · composing=false)로 확정되어 flushIme의 else(비조합)
 * 분기를 탄다 — 재삽입 방어가 무장되는지가 이 헬퍼로 여는 시나리오의 핵심이다.
 */
async function reachIndiaExactViaMicrotask(h: Harness): Promise<void> {
  h.ctrl.setCountry(INDIA);
  h.compositionStart();
  h.type('ㅇ', true);
  h.type('인', true);
  h.type('인ㄷ', true);
  h.input.value = '인도'; // 최종 input 이벤트 없이 값만 확정(IME가 compositionend를 먼저 낸 상태)
  h.compositionEnd(); // composing=false + microtask 재평가 예약
  await Promise.resolve(); // microtask: EXACT → flushIme(false) — 비조합 플러시
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

    // ③a (D84 개정): 윈도우가 48→150ms로 확대됐다 — 49ms에 도착한 옛-꼬리 전량 재삽입은 이제
    //   삼켜진다(기존 48ms 기대 반전). 시간 fail-open의 경계가 150ms로 이동했을 뿐 불변식은 유지.
    it('stale tail at 49ms (inside the widened 150ms window) IS swallowed (D84)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // flushAt=0
      const before = contentCount(h.events);
      h.setNow(49); // 구 윈도우(48ms) 밖·신 윈도우(150ms) 안
      h.ctrl.setCountry(KOREA);
      h.type('가나', true); // ≥2자모 + stale 꼬리 일치 + 윈도우 안 → 삼킴
      expect(contentCount(h.events)).toBe(before); // 무이벤트
      expect(h.input.value).toBe(''); // 재플러시로 비워짐
    });

    // ③b (D98 개정 — 조정 사유: "윈도우 밖 = 무조건 genuine" 단언이 D98 분기 (1) 신규 경로와 직접
    //   충돌한다. 윈도우 밖 전량 에코도 의미 중재(전체 판정 MISS)를 통과하면 삼킨다 — 늦게 발현하는
    //   재삽입이 라이브 재발의 원인이었다. fail-open은 이제 시간이 아니라 예산(⑦·N5)이 담당한다.)
    it('stale tail after the 150ms window IS swallowed when the whole value is MISS (D98)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // flushAt=0
      const before = contentCount(h.events);
      h.setNow(151); // 윈도우 밖 — 의미 중재 경로
      h.ctrl.setCountry(KOREA);
      h.type('가나', true); // '가나'는 대한민국/한국 접두 아님(MISS) → 늦은 에코로 판정, 삼킴
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe(''); // 재플러시로 비워짐
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

  // ── docs/00 §11-D84(버그 W): flush 후 끝음절 접미 재삽입이 사용자 첫 타와 병합된 스냅샷의
  //    부분 꼬리 스트립(의미 중재) + 재삽입 윈도우 150ms 확대 ─────────────────────────────────
  describe('D84 stale-tail merge strip / widened window (Bug W)', () => {
    // W-P1 (PRIMARY 승격·반전): 재삽입 '도' + genuine '대'가 '도대'로 병합된 스냅샷. staleRaw='인도'의
    //   proper 접미 '도'가 v 접두이고, 전체('도대')=MISS·잔여('대')=PREFIX(의미 중재 통과) → '도'만
    //   basePrefix로 가상 스트립하고 '대'만 평가. 이어 계속 타이핑하면 '대한민국' EXACT까지 이어진다.
    it('W-P1: merged "도대" strips the reinserted "도", evaluates only "대" (PREFIX), then reaches EXACT', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h); // staleEcho='ㅇㅣㄴㄷㅗ', staleRaw='인도', flushAt=0
      const before = contentCount(h.events);
      h.setNow(20); // 재삽입 윈도우 안
      h.ctrl.setCountry(KOREA); // value=''→no flush, staleEcho 이월, reinsertFlushes=0
      h.compositionStart();
      h.type('도대', true); // 병합: 재삽입 '도' + genuine '대'
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('대'); // 잔여만 평가
      expect(h.ctrl.getValue()).toBe('대'); // 가상 접두 '도' 제외
      expect(eventsOf(h.events, 'miss')).toHaveLength(0);
      // 스트립된 접두를 유지한 채 계속 타이핑 → basePrefix 분기가 연장분만 넘긴다 → EXACT.
      h.type('도대한', true);
      h.type('도대한민', true);
      h.type('도대한민국', true); // EXACT('대한민국')
      const exacts = eventsOf(h.events, 'exact');
      expect(exacts.at(-1)?.detail.bestTarget.display).toBe('대한민국');
      expect(h.ctrl.getValue()).toBe(''); // EXACT flush로 basePrefix·버퍼 리셋
    });

    // W-P2 (SECONDARY-병합): 60ms(구 48ms 윈도우 밖·신 150ms 윈도우 안)에 도착한 병합 스냅샷도
    //   동일하게 스트립된다 — 윈도우 확대가 late 병합 재삽입을 닫음을 증명.
    it('W-P2: merged "도대" at 60ms (inside widened window) strips the same as W-P1', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(60);
      h.ctrl.setCountry(KOREA);
      h.compositionStart();
      h.type('도대', true);
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('대');
      expect(h.ctrl.getValue()).toBe('대');
    });

    // W-S1 (SECONDARY-lone 승격·반전): lone 재삽입 '도'가 60ms(신 윈도우 안)에 도착 → 전량 삼킴 분기가
    //   삼킨다(48ms에선 누수하던 것이 150ms 확대로 닫힘).
    it('W-S1: lone reinsert "도" at 60ms (inside widened window) IS swallowed', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(60);
      h.ctrl.setCountry(KOREA);
      h.type('도', true); // ㄷㅗ + 윈도우 + stale.endsWith(ㄷㅗ) → 삼킴
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe(''); // 재플러시
    });

    // W-S2 (CONTRAST 승격·불변): lone '도'가 20ms에 도착 — 전량 삼킴 분기는 무중재 현행 그대로 삼킨다.
    it('W-S2: lone reinsert "도" at 20ms is swallowed (unchanged — swallow branch has no mediation)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(20);
      h.ctrl.setCountry(KOREA);
      h.type('도', true);
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe('');
    });

    // W-G1 (over-strip 가드 ★): 다음 국가명이 전 국가 끝 음절 '도'로 시작(도미니카)하고 사용자가
    //   '도미'를 코얼레싱해 쳤을 때 — 전체('도미')가 PREFIX(genuine 유효)라 의미 중재가 스트립을
    //   막는다. genuine 전량 보존(과삭제 원천 차단).
    it('W-G1: coalesced genuine "도미" (whole is PREFIX of 도미니카) is NOT stripped — preserved', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.setNow(20);
      h.ctrl.setCountry(DOMINICA);
      h.compositionStart();
      h.type('도미', true);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('도미'); // 전량 보존
      expect(h.ctrl.getValue()).toBe('도미');
    });

    // W-G2 (과억제 현상유지 잠금): lone '도'는 타깃(도미니카)의 genuine 첫 음절이지만, 전량 삼킴
    //   분기는 무중재라 그대로 삼킨다 — D70 기수용 트레이드(에코 빈도≫잭-genuine)의 명시적 불변.
    it('W-G2: lone "도" with DOMINICA target is still swallowed (D70 accepted trade — no mediation on lone branch)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(20);
      h.ctrl.setCountry(DOMINICA);
      h.type('도', true);
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe('');
    });

    // W-G3 (양쪽 MISS 비스트립 잠금): '도카' — 전체 MISS·잔여('카')도 MISS → 의미 중재 불발로
    //   스트립하지 않고 현행대로 누수(빨간 MISS). 과삭제 방지 우선의 의도된 귀결(§1.5 수용 (1)).
    it('W-G3: "도카" (whole MISS and stripped-rest MISS) is NOT stripped → leaks as MISS (accepted)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.setNow(20);
      h.ctrl.setCountry(KOREA);
      h.type('도카', true);
      expect(eventsOf(h.events, 'miss')).toHaveLength(1);
      expect(h.ctrl.getValue()).toBe('도카'); // 잔여 누수
    });

    // W-T1 (D98 개정 — 조정 사유: 부분 꼬리 스트립의 inWindow 게이트가 D98로 제거됐다. 151ms 병합
    //   재삽입은 이제 스트립된다; 시간 fail-open 대신 의미 중재 + 예산(W-B1)이 과삭제를 막는다.)
    it('W-T1: merged "도대" after the 150ms window IS stripped (no time gate — D98)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.setNow(151);
      h.ctrl.setCountry(KOREA);
      h.type('도대', true);
      expect(eventsOf(h.events, 'miss')).toHaveLength(0);
      expect(eventsOf(h.events, 'progress').at(-1)?.rawValue).toBe('대');
      expect(h.ctrl.getValue()).toBe('대');
    });

    // W-B1 (예산 공유 fail-open + 대조): 부분 꼬리 스트립은 전량 삼킴과 reinsertFlushes 예산을
    //   공유한다. lone '가나' 3회 삼킴으로 예산을 소진하면, 이어지는 '나다'(r='나'·잔여 '다'는
    //   다도 PREFIX라 중재는 통과)는 스트립되지 않고 genuine으로 fail-open한다.
    it('W-B1: partial-tail strip shares the reinsert budget — exhausted budget fails open', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h); // staleEcho='ㄱㅏㄴㅏ', staleRaw='가나', flushAt=0
      h.ctrl.setCountry(DADO); // 다도(ㄷㅏㄷㅗ), staleEcho 이월, reinsertFlushes=0
      for (let i = 0; i < 3; i++) {
        h.setNow(10); // 매 재플러시가 flushAt=10으로 갱신 → 항상 윈도우 안
        h.type('가나', true); // lone 삼킴 3회 → reinsertFlushes=3(예산 소진)
      }
      const before = contentCount(h.events);
      h.setNow(10);
      h.type('나다', true); // 중재는 통과하나 예산 소진 → 스트립 불발 → genuine MISS
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
      expect(h.ctrl.getValue()).toBe('나다');
    });

    // W-B1 (대조): 예산이 남아 있으면 같은 '나다'가 스트립된다 — r='나'(2자모 꼬리 접미)까지
    //   스트립이 일반화됨(끝 음절만이 아니라 임의 proper 접미)을 함께 잠근다.
    it('W-B1-contrast: with budget available, "나다" strips r="나" → progress "다"', () => {
      const h = harness('ko');
      h.setNow(0);
      reachGhanaExact(h);
      h.setNow(10);
      h.ctrl.setCountry(DADO);
      h.type('나다', true); // r='나' 스트립 → 잔여 '다'=다도 PREFIX
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('다');
      expect(h.ctrl.getValue()).toBe('다');
    });

    // W-C1 (스트립 후 기저 붕괴 승계): W-P1 첫 스냅샷으로 basePrefix='도'가 세워진 뒤, value가 더는
    //   '도'로 시작하지 않으면(IME가 접두를 삼킴) 기존 ⑤ 기구(조용 flush·리셋)를 그대로 승계한다.
    it('W-C1: after partial-tail strip, base-prefix collapse silently flushes (inherits ⑤ mechanism)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.setNow(20);
      h.ctrl.setCountry(KOREA);
      h.compositionStart();
      h.type('도대', true); // 스트립 → basePrefix='도', progress '대'
      const before = contentCount(h.events);
      h.type('대', true); // v='대'가 더 이상 '도'로 시작하지 않음 → 기저 붕괴
      expect(contentCount(h.events)).toBe(before); // 조용한 리셋
      expect(h.input.value).toBe(''); // 재플러시
      expect(h.ctrl.getValue()).toBe('');
    });
  });

  // ── docs/00 §11-D98(D84 개정): 재삽입은 focus 복귀 직후가 아니라 "사용자의 다음 키스트로크"
  //    시점에 발현할 수 있다(실기기 MS IME) → 국가 전환 후 150ms 넘게 쉬면 방어가 전부 비활성이던
  //    시간 게이트를 걷어내고, 윈도우 밖은 의미 중재로만 판별한다. staleEcho가 "첫 비어있지 않은
  //    입력에서 one-shot 소거"이므로 노출은 국가당 1스냅샷으로 이미 유계다. ────────────────────
  describe('D98 late reinsertion (window gate removed, semantic mediation)', () => {
    // N1(라이브 재현): 인도 확정 → 500ms 휴지 → '대' 입력이 '도대'로 병합 도착. 시간 게이트가 없으므로
    //   부분 꼬리 스트립이 그대로 동작한다(전체 '도대'=MISS, 잔여 '대'=PREFIX → 의미 중재 통과).
    it('N1: merged "도대" 500ms after the flush is stripped — progress "대" only', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h); // staleRaw='인도', flushAt=0
      const before = contentCount(h.events);
      h.setNow(500); // 일반적인 플레이 호흡 — 구 150ms 윈도우 한참 밖
      h.ctrl.setCountry(KOREA);
      h.compositionStart();
      h.type('도대', true);
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('대'); // 잔여만 평가
      expect(h.ctrl.getValue()).toBe('대'); // 화면에 '도대'가 남지 않는다(버그 증상)
      expect(eventsOf(h.events, 'miss')).toHaveLength(0);
    });

    // N2: 단독 늦은 에코 '도'(병합 없이 에코만 먼저 도착) — 윈도우 밖이지만 전체 판정이 MISS라
    //   의미 중재를 통과해 삼켜지고, 재플러시로 버퍼가 빈다.
    it('N2: lone late echo "도" at 500ms is swallowed (whole value MISS) and re-flushed', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(500);
      h.ctrl.setCountry(KOREA);
      h.type('도', true);
      expect(contentCount(h.events)).toBe(before); // 무이벤트
      expect(h.input.value).toBe(''); // 재플러시로 비워짐
    });

    // N3(대조 ★): 같은 늦은 '도'라도 새 타깃이 도미니카면 전체 판정이 PREFIX(genuine 유효) →
    //   의미 중재가 삼킴을 막는다. 윈도우 밖에서는 genuine이 항상 우선한다.
    it('N3: lone "도" at 500ms with DOMINICA target is NOT swallowed (genuine PREFIX wins)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.setNow(500);
      h.ctrl.setCountry(DOMINICA);
      h.compositionStart();
      h.type('도', true);
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('도');
      expect(h.ctrl.getValue()).toBe('도');
    });

    // N4(§2.10 #4 불변): 확정 직후 첫 타가 단일 자모면 구조 게이트(≥2자모)에 걸려 어떤 경로로도
    //   삼켜지지 않는다 — D98은 시간 게이트만 걷어냈을 뿐 이 계약을 건드리지 않는다.
    it('N4: a single jamo "ㄷ" right after the flush is never swallowed (§2.10 #4)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      const before = contentCount(h.events);
      h.ctrl.setCountry(KOREA);
      h.compositionStart();
      h.type('ㄷ', true); // 0ms, 자모 1개 → genuine
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'progress').at(-1)?.detail.state).toBe('PREFIX');
      expect(h.ctrl.getValue()).toBe('ㄷ');
    });

    // N5(fail-open 이관): 시간이 아니라 예산이 무한 삼킴을 막는다 — 3회 소진 후의 늦은 에코는
    //   중재를 통과하더라도 genuine으로 처리된다(입력 잠금 방지).
    it('N5: with the reinsert budget exhausted, a late echo fails open (genuine MISS)', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.ctrl.setCountry(KOREA); // reinsertFlushes=0
      for (let i = 0; i < 3; i++) {
        h.setNow(10); // 매 재플러시가 flushAt=10으로 갱신
        h.type('도', true); // 3회 삼킴 → 예산 소진
      }
      const before = contentCount(h.events);
      h.setNow(500);
      h.type('도', true); // 4번째 — 예산 없음 → 삼키지 않는다
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
      expect(h.ctrl.getValue()).toBe('도');
    });

    // N6(en 경로 불변): 영문 EXACT는 비조합 flush라 staleEcho를 장전하지 않는다 → resolveRaw가
    //   첫 줄에서 값을 그대로 통과시킨다. 옛 값과 동일한 늦은 입력조차 삼키지 않는다.
    it('N6: en mode never arms staleEcho (non-composing flush) — nothing is swallowed', () => {
      const h = harness('en');
      h.setNow(0);
      h.ctrl.setCountry(CHAD);
      h.type('chad'); // EXACT → else 분기 flush(staleEcho 미장전)
      const before = contentCount(h.events);
      h.setNow(500);
      h.ctrl.setCountry(CUBA);
      h.type('chad'); // 옛 값과 동일해도 genuine
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
      expect(h.input.value).toBe('chad'); // 재플러시 없음
      expect(h.ctrl.getValue()).toBe('chad');
    });
  });

  // ── docs/00 §11-D104(D98 개정): 라이브 재현이 남아 있던 잔여 구멍 2개 ────────────────────
  //  A) 비조합 flush가 재삽입 방어를 아예 무장하지 않았다 — EXACT는 compositionend 이후
  //     microtask 재평가(ev=undefined·composing=false)로 확정될 수 있고(조기 compositionend·
  //     Safari 순서 역전), 그 경로/스킵 clear() 경로에선 flushIme의 else 분기가 staleEcho를
  //     지워버려 이후 어떤 재삽입도 genuine으로 통과했다. → ko + 비어있지 않은 사전 버퍼면 무장.
  //  B) 삼킴 재플러시의 blur→focus가 같은 에코를 재유발해 국가당 예산(3)만 태우고 fail-open으로
  //     새 버퍼에 눌러앉았다. → 실제 조합 중일 때만 flushIme, 아니면 silentClear(무-blur·무-epoch).
  describe('D104 non-composing flush arming (A) / silent swallow cleanup (B)', () => {
    // N7(구멍 A 재현 ★): 비조합(microtask) EXACT 플러시 후 늦은 병합 '도대' — 무장이 됐으므로
    //   D98 부분 꼬리 스트립이 그대로 동작한다. 현행 코드에선 staleEcho 미장전 → genuine MISS로 실패.
    it('N7: after a non-composing (microtask) EXACT flush, a late merged "도대" is still stripped', async () => {
      const h = harness('ko');
      h.setNow(0);
      await reachIndiaExactViaMicrotask(h);
      expect(eventsOf(h.events, 'exact')).toHaveLength(1); // 비조합 경로로 확정됐음을 잠근다
      const before = contentCount(h.events);
      h.setNow(500); // 일반적인 플레이 호흡
      h.ctrl.setCountry(KOREA);
      h.compositionStart();
      h.type('도대', true); // 재삽입 '도' + genuine '대'
      expect(contentCount(h.events)).toBe(before + 1);
      const prog = eventsOf(h.events, 'progress');
      expect(prog.at(-1)?.detail.state).toBe('PREFIX');
      expect(prog.at(-1)?.rawValue).toBe('대');
      expect(h.ctrl.getValue()).toBe('대'); // 화면에 '도대'가 남지 않는다(라이브 증상)
      expect(eventsOf(h.events, 'miss')).toHaveLength(0);
    });

    // N8(구멍 A): 같은 비조합 flush 후 단독 늦은 에코 '도' — 전량 삼킴 분기가 의미 중재를 통과해 삼킨다.
    it('N8: after a non-composing flush, a lone late echo "도" is swallowed', async () => {
      const h = harness('ko');
      h.setNow(0);
      await reachIndiaExactViaMicrotask(h);
      const before = contentCount(h.events);
      h.setNow(500);
      h.ctrl.setCountry(KOREA);
      h.type('도'); // 조합 이벤트 없이 도착한 늦은 에코 → 삼킴 + silentClear
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe(''); // 조용히 비워짐
    });

    // N9(구멍 B ★): isComposing=false 에코가 연속 도착해도 blur→focus를 유발하지 않고(에코 재유발
    //   루프 차단) 삼킬 때마다 staleEcho가 재무장돼 3회까지 잡힌다. 4번째는 예산 소진 → fail-open.
    it('N9: consecutive non-composing echoes are swallowed via silentClear — no blur, staleEcho re-armed', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h); // 무장(조합 EXACT) — 구멍 B는 무장 경로와 독립이다
      h.ctrl.setCountry(KOREA); // reinsertFlushes=0
      const blurSpy = vi.spyOn(h.input, 'blur');
      const before = contentCount(h.events);
      for (const t of [500, 700, 900]) {
        h.setNow(t); // 매번 직전 정리 시각 + 200ms → 항상 윈도우 밖(의미 중재 경로)
        h.type('도'); // isComposing=false
        expect(h.input.value).toBe('');
      }
      expect(contentCount(h.events)).toBe(before); // 3연속 삼킴(재무장이 없으면 2번째부터 genuine)
      expect(blurSpy).not.toHaveBeenCalled(); // silentClear는 blur/focus를 유발하지 않는다
      h.setNow(1100);
      h.type('도'); // 4번째 — 예산(3) 소진 → fail-open(입력 잠금 방지)
      expect(contentCount(h.events)).toBe(before + 1);
      expect(eventsOf(h.events, 'miss').length).toBeGreaterThanOrEqual(1);
    });

    // N9b(구멍 B의 실기기 형태 ★): 재삽입 이벤트가 isComposing=true로 오는 기기 — flushIme의
    //   focus() 도중 시작된 조합이라 컨트롤러의 compositionstart 추적(this.composing)은 이미
    //   false로 덮여 있다. 여기서 이벤트 비트만 보고 blur→focus를 다시 돌리면 같은 에코를 재유발해
    //   예산만 태웠다(라이브 잔여 증상). 이제 추적 중인 조합이 없으면 blur 없이 정리한다.
    it('N9b: an echo arriving with isComposing=true but no tracked composition never re-blurs', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h); // flushIme가 this.composing을 false로 되돌린 상태
      h.ctrl.setCountry(KOREA);
      const blurSpy = vi.spyOn(h.input, 'blur');
      const before = contentCount(h.events);
      for (const t of [500, 700, 900]) {
        h.setNow(t);
        h.type('도', true); // compositionstart 없이 isComposing=true로만 도착하는 재삽입
        expect(h.input.value).toBe('');
      }
      expect(contentCount(h.events)).toBe(before);
      expect(blurSpy).not.toHaveBeenCalled(); // 에코 재유발 루프 차단
    });

    // N9c(대조): 사용자가 실제로 조합 중이면(compositionstart 추적됨) 삼킴 정리는 기존 flushIme
    //   프로토콜(blur→clear→동기 focus)을 그대로 쓴다 — blur만이 살아있는 조합을 끝낼 수 있다(§2.5).
    it('N9c: while a composition is actually tracked, swallow cleanup still uses the flush protocol', () => {
      const h = harness('ko');
      h.setNow(0);
      reachIndiaExact(h);
      h.ctrl.setCountry(KOREA);
      const blurSpy = vi.spyOn(h.input, 'blur');
      h.compositionStart(); // 실제 조합 시작(추적됨)
      h.setNow(500);
      h.type('도', true); // 삼킴 → 조합 중이므로 flushIme
      expect(blurSpy).toHaveBeenCalledTimes(1);
      expect(h.input.value).toBe('');
    });

    // N10(구멍 A — 스킵 잔여): clear()가 비조합 잔여를 비울 때도 방어를 무장한다. 스킵 직후
    //   IME가 되돌린 잔여가 다음 국가 첫 입력으로 채택되던 D70 진단 (1)의 잔여 경로.
    it('N10: residual cleared by clear() (skip) still arms the defense — a later reinsertion is swallowed', () => {
      const h = harness('ko');
      h.setNow(0);
      h.ctrl.setCountry(KOREA);
      h.type('한'); // 조합 이벤트 없는 잔여(PREFIX)
      h.ctrl.clear(); // 스킵/게임오버 등 외부 클리어 → 비조합 flush
      expect(h.input.value).toBe('');
      const before = contentCount(h.events);
      h.setNow(500);
      h.ctrl.setCountry(GHANA);
      h.type('한'); // IME가 되돌린 잔여 재삽입 → 삼킴
      expect(contentCount(h.events)).toBe(before);
      expect(h.input.value).toBe('');
    });

    // N11(대조 ★): 무장 조건은 "ko ∧ 비어있지 않은 사전 버퍼"다. (a) en 라틴 경로는 IME 재삽입이
    //   없으므로 비조합 flush여도 무장하지 않고(N6 계약 유지 — 근거가 "비조합"에서 "lang==='en'"으로
    //   바뀔 뿐), (b) 빈 버퍼 clear()는 무장이 아니라 해제다(기존 무입력 clear 계약).
    it('N11: en EXACT and an empty-buffer clear() never arm staleEcho (contrast)', () => {
      // (a) en 경로
      const en = harness('en');
      en.setNow(0);
      en.ctrl.setCountry(CHAD);
      en.type('chad'); // EXACT → 비조합 flush(사전 버퍼 'chad'는 비어있지 않지만 en)
      const beforeEn = contentCount(en.events);
      en.setNow(500);
      en.ctrl.setCountry(CUBA);
      en.type('chad'); // 옛 값과 동일해도 삼키지 않는다
      expect(contentCount(en.events)).toBe(beforeEn + 1);
      expect(en.input.value).toBe('chad');

      // (b) 빈 버퍼 clear() — 해제
      const ko = harness('ko');
      ko.setNow(0);
      reachGhanaExact(ko); // staleEcho='ㄱㅏㄴㅏ'
      ko.ctrl.clear(); // value==='' → 사전 버퍼 비어있음 → 기존대로 해제
      const beforeKo = contentCount(ko.events);
      ko.setNow(20);
      ko.ctrl.setCountry(KOREA);
      ko.type('가나', true); // 방어 해제 상태 → genuine MISS
      expect(contentCount(ko.events)).toBe(beforeKo + 1);
      expect(eventsOf(ko.events, 'miss').length).toBeGreaterThanOrEqual(1);
    });

    // N12(진단 채널): localStorage 'wt:imeTrace'==='1'일 때만 분기 결정을 console.debug로 남긴다.
    it('N12: the wt:imeTrace flag logs resolveRaw branch decisions', () => {
      localStorage.setItem('wt:imeTrace', '1');
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const h = harness('ko'); // 플래그는 생성 시 1회 캐시된다
        h.setNow(0);
        reachIndiaExact(h);
        h.setNow(500);
        h.ctrl.setCountry(KOREA);
        h.compositionStart();
        h.type('도대', true); // strip 분기 → basePrefix='도'
        h.type('대', true); // 더는 '도'로 시작하지 않음 → base-collapse 분기
        const branches = debugSpy.mock.calls.map((c) => c[1]);
        expect(branches).toContain('armed');
        expect(branches).toContain('strip');
        expect(branches).toContain('base-collapse');
      } finally {
        localStorage.removeItem('wt:imeTrace');
      }
    });

    // N12b: 프라이버시 모드/샌드박스에서 localStorage 접근이 throw해도 생성이 깨지지 않는다.
    it('N12b: a throwing localStorage disables the trace instead of breaking construction', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('access denied');
      });
      const h = harness('ko');
      h.ctrl.setCountry(GHANA);
      h.type('가', true);
      expect(eventsOf(h.events, 'progress')).toHaveLength(1);
    });
  });
});
