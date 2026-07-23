// @vitest-environment jsdom
//
// spec: docs/03 §2.8(METRO식 슬롯+힌트+입력 에코·오타 이중 부호화·커서, docs/00 §11-D66),
//       §2.10 #1(가나 도깨비불 무오타), WT-M2-03 / WT-DC-07.
//
// [표시 모델 D66] 큰 줄 = 사용자 입력 에코. 슬롯 수 = 캐노니컬 표시단위 수, 상단 힌트 = 목표 유닛
// 문자(정적), 아래 .wt-unit = 실입력 글리프(초기 빈). 미입력 슬롯 = 빈 pending, 슬롯 초과분 = tail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileTargets, matchInputDetail, type Country, type MatchDetail } from '@wt/shared';
import { PromptRenderer } from './prompt-renderer';

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn'>): Country {
  return {
    iso3: 'XXX',
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: 1,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '🏳️',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [p.nameKo],
    acceptedInputsEn: [p.nameEn.toLowerCase().replace(/[\s.'-]/g, '')],
    ...p,
  };
}

const GHANA = mk({ id: 'GH', nameKo: '가나', nameEn: 'Ghana' });
const MONGOLIA = mk({ id: 'MN', nameKo: '몽골', nameEn: 'Mongolia' });
const KOREA = mk({
  id: 'KR',
  nameKo: '대한민국',
  nameEn: 'South Korea',
  aliasesKo: ['한국', '남한'],
  aliasesEn: ['Korea'],
  acceptedInputsKo: ['대한민국', '한국', '남한'],
  acceptedInputsEn: ['southkorea', 'korea'],
});

/** raw 입력 스냅샷 → MatchDetail (실제 컨트롤러가 쓰는 것과 동일 경로). */
function detailFor(raw: string, c: Country, lang: 'ko' | 'en') {
  return matchInputDetail(raw, compileTargets(c, lang), lang);
}

let el: HTMLElement;
let r: PromptRenderer;

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  r = new PromptRenderer();
});
afterEach(() => {
  r.unmount();
  el.remove();
  vi.useRealTimers();
});

/** 에코 글리프(.wt-unit)들. 힌트(.wt-slot__hint)는 여기 포함되지 않는다(E2E 셀렉터 계약). */
function glyphEls(): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.wt-unit'));
}
function hintEls(): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.wt-slot__hint'));
}
function glyphText(): string[] {
  return glyphEls().map((g) => g.textContent ?? '');
}
function cursorSlotIndex(): number {
  const slots = Array.from(el.querySelectorAll('.wt-slot'));
  return slots.findIndex((s) => s.classList.contains('is-cursor'));
}

describe('PromptRenderer.mount — 슬롯(힌트+에코 글리프) 생성', () => {
  it('한글: 캐노니컬 음절마다 슬롯 1개(힌트=목표 음절, 에코 글리프=빈)', () => {
    r.mount(el, MONGOLIA, 'ko');
    // 힌트는 목표어(몽골)를 보존, 에코 글리프는 비어 있다.
    expect(hintEls().map((h) => h.textContent)).toEqual(['몽', '골']);
    expect(glyphText()).toEqual(['', '']);
    // 힌트 span에는 .wt-unit class를 부여하지 않는다(E2E 셀렉터 계약).
    expect(hintEls().every((h) => !h.classList.contains('wt-unit'))).toBe(true);
    expect(glyphEls()).toHaveLength(2);
  });

  it('prompt-mount 전체 textContent = 국가명(에코 글리프가 비어 국가 전환 직후 국가명과 일치)', () => {
    r.mount(el, MONGOLIA, 'ko');
    expect(el.textContent).toBe('몽골');
  });

  it('영어: 문자마다 슬롯, 공백은 len 0 구분자(South Korea, textContent 보존)', () => {
    r.mount(el, KOREA, 'en');
    // 국가 전환 직후 textContent는 공백 포함 국가명과 정확히 일치(E2E: awaitPrompt).
    expect(el.textContent).toBe('South Korea');
    // 공백 슬롯의 에코 글리프는 wt-unit--sep(밑줄 없음), 상태는 null.
    const sep = glyphEls().find((g) => g.classList.contains('wt-unit--sep'))!;
    expect(sep).toBeTruthy();
    // 구분자 1개(공백) + 콘텐츠 10개.
    expect(glyphEls()).toHaveLength(11);
  });

  it('마운트 직후 콘텐츠 슬롯 pending, 구분자 null', () => {
    r.mount(el, MONGOLIA, 'ko');
    expect(r.getUnitStates()).toEqual(['pending', 'pending']);
    r.mount(el, KOREA, 'en');
    // 공백(index 5)만 null, 나머지 pending.
    const states = r.getUnitStates();
    expect(states[5]).toBeNull();
    expect(states.filter((s) => s === 'pending')).toHaveLength(10);
  });

  it('마운트 직후 커서는 첫 콘텐츠 슬롯', () => {
    r.mount(el, MONGOLIA, 'ko');
    expect(cursorSlotIndex()).toBe(0);
  });
});

describe('PromptRenderer.update — 입력 에코(몽골)', () => {
  it('한 음절씩 친 대로 슬롯에 done 에코, 나머지는 빈 pending + 커서 전진', () => {
    r.mount(el, MONGOLIA, 'ko');

    // "ㅁ"(조합 시작): 첫 슬롯에 'ㅁ' done, 둘째 pending, 커서 둘째로.
    r.update(detailFor('ㅁ', MONGOLIA, 'ko'), 'ㅁ');
    expect(r.getUnitStates()).toEqual(['done', 'pending']);
    expect(glyphText()).toEqual(['ㅁ', '']);
    expect(cursorSlotIndex()).toBe(1);

    // "몽": 첫 슬롯 글리프가 '몽'으로 갱신(여전히 done).
    r.update(detailFor('몽', MONGOLIA, 'ko'), '몽');
    expect(glyphText()).toEqual(['몽', '']);
    expect(r.getUnitStates()).toEqual(['done', 'pending']);

    // "몽고": 둘째 슬롯에 사용자가 친 '고'가 done으로 에코(캐노니컬 '골'이 아니라 실입력).
    r.update(detailFor('몽고', MONGOLIA, 'ko'), '몽고');
    expect(glyphText()).toEqual(['몽', '고']);
    expect(r.getUnitStates()).toEqual(['done', 'done']);
  });

  it('EXACT("몽골"): 전 슬롯을 캐노니컬 글리프 done으로 채우고 커서 제거', () => {
    r.mount(el, MONGOLIA, 'ko');
    r.update(detailFor('몽고', MONGOLIA, 'ko'), '몽고'); // 실입력 '고'
    const exact = detailFor('몽골', MONGOLIA, 'ko');
    expect(exact.state).toBe('EXACT');
    // EXACT 시 rawValue는 플러시로 비어 있다(§2.5) — 캐노니컬로 되메운다.
    r.update(exact, '');
    expect(glyphText()).toEqual(['몽', '골']); // '고' → 캐노니컬 '골'로 확정 표시
    expect(r.getUnitStates()).toEqual(['done', 'done']);
    expect(cursorSlotIndex()).toBe(-1); // 커서 제거
  });
});

describe('도깨비불 "가나" — 오타 표시 없음(§2.10 #1)', () => {
  it('ㄱ→가→간→가나 전 과정에서 어떤 슬롯도 error가 되지 않는다', () => {
    r.mount(el, GHANA, 'ko');
    for (const raw of ['ㄱ', '가', '간']) {
      r.update(detailFor(raw, GHANA, 'ko'), raw);
      expect(r.getUnitStates()).not.toContain('error');
      expect(el.querySelector('.is-error')).toBeNull();
    }
    // "간" 시점: 받침 ㄴ이 다음 음절 커서로 흡수 → 첫 슬롯 done('간' 에코), 둘째 빈 pending.
    r.update(detailFor('간', GHANA, 'ko'), '간');
    expect(r.getUnitStates()).toEqual(['done', 'pending']);
    expect(glyphText()).toEqual(['간', '']);
    // 최종 "가나": EXACT → 캐노니컬 done.
    const exact = detailFor('가나', GHANA, 'ko');
    r.update(exact, '');
    expect(r.getUnitStates()).toEqual(['done', 'done']);
    expect(glyphText()).toEqual(['가', '나']);
  });
});

describe('오타 채색 — 적색 + 물결 밑줄(색각 이중 부호화)', () => {
  it('"가바"(가 뒤 오타 ㅂ): 첫 슬롯 done, 둘째 슬롯이 실입력 "바"를 error로 에코', () => {
    r.mount(el, GHANA, 'ko');
    r.update(detailFor('가바', GHANA, 'ko'), '가바');
    expect(r.getUnitStates()).toEqual(['done', 'error']);
    const errored = glyphEls()[1]!;
    expect(errored.textContent).toBe('바'); // 캐노니컬 '나'가 아니라 실제 친 '바'
    expect(errored.classList.contains('is-error')).toBe(true);
    expect(errored.dataset.state).toBe('error');
  });
});

describe('별칭 입력 — 에코가 그대로 표시(구 캐노니컬 동결 폐기)', () => {
  it('"한"(별칭 한국 경로) 입력 시 첫 슬롯에 "한" done 에코, EXACT("한국")에 캐노니컬로 확정', () => {
    r.mount(el, KOREA, 'ko');
    // 힌트는 캐노니컬 대한민국.
    expect(hintEls().map((h) => h.textContent)).toEqual(['대', '한', '민', '국']);

    // 별칭 접두 '한'은 bestTarget=한국 기준으로 matched되어 첫 슬롯에 '한' done으로 에코된다.
    r.update(detailFor('한', KOREA, 'ko'), '한');
    expect(r.getUnitStates()).toEqual(['done', 'pending', 'pending', 'pending']);
    expect(glyphText()[0]).toBe('한');

    // '한국' = 별칭 EXACT → 캐노니컬(대한민국) 전 슬롯 done.
    const exact = detailFor('한국', KOREA, 'ko');
    expect(exact.state).toBe('EXACT');
    r.update(exact, '');
    expect(r.getUnitStates()).toEqual(['done', 'done', 'done', 'done']);
    expect(glyphText()).toEqual(['대', '한', '민', '국']);
  });
});

describe('오버플로 — 슬롯 초과 입력은 tail로(error색, 최대 4유닛)', () => {
  it('2슬롯 "가나"에 5음절 입력: 슬롯 2개 done, 나머지는 tail, 커서는 tail', () => {
    r.mount(el, GHANA, 'ko');
    // '가나다라마' — '가나'까지 정타(done), '다라마'는 초과 → tail.
    r.update(detailFor('가나다라마', GHANA, 'ko'), '가나다라마');
    expect(r.getUnitStates()).toEqual(['done', 'done']);
    expect(glyphText()).toEqual(['가', '나']);
    const tail = el.querySelector<HTMLElement>('.wt-prompt__tail')!;
    expect(tail.textContent).toBe('다라마');
    expect(tail.classList.contains('is-cursor')).toBe(true);
    expect(cursorSlotIndex()).toBe(-1); // 커서는 슬롯이 아니라 tail
  });

  it('tail은 최대 4유닛만 표시(초과분 잘림)', () => {
    r.mount(el, GHANA, 'ko');
    r.update(detailFor('가나다라마바사', GHANA, 'ko'), '가나다라마바사');
    const tail = el.querySelector<HTMLElement>('.wt-prompt__tail')!;
    expect(tail.textContent).toBe('다라마바'); // 다라마바사 → 앞 4유닛
  });
});

describe('조합 중 partial — 산식 전용(composition 이벤트 미사용)', () => {
  it('matched가 유닛 자모 구간 안에 들면(오타 없음) 슬롯이 partial(조합 중)로 렌더된다', () => {
    r.mount(el, MONGOLIA, 'ko');
    // 크래프트 detail: '고'(ㄱㅗ, [0,2)) 입력 중 matched=1(ㄱ만 정타 확정, !hasError).
    // 실입력 파이프라인에선 matched=inputLen이라 드문 경계지만, 렌더 규칙을 산식으로만
    // 결정한다는 계약(§2.8)을 검증한다.
    const crafted: MatchDetail = {
      state: 'PREFIX',
      bestTarget: { display: '몽골', key: 'ㅁㅗㅇㄱㅗㄹ' },
      matchedLen: 1,
      inputLen: 1,
    };
    r.update(crafted, '고');
    expect(r.getUnitStates()).toEqual(['partial', 'pending']);
    const g = glyphEls()[0]!;
    expect(g.textContent).toBe('고');
    expect(g.classList.contains('is-partial')).toBe(true);
  });
});

describe('juice — 팝/셰이크 (transform/opacity, 끌 수 있음)', () => {
  it('juice≥1: pop/shake가 class를 붙였다가 타이머로 제거한다', () => {
    vi.useFakeTimers();
    r.mount(el, GHANA, 'ko');
    r.setJuiceLevel(2);
    r.pop();
    expect(el.classList.contains('wt-prompt--pop')).toBe(true);
    r.shake();
    expect(el.classList.contains('wt-prompt--shake')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(el.classList.contains('wt-prompt--pop')).toBe(false);
    expect(el.classList.contains('wt-prompt--shake')).toBe(false);
  });

  it('juice 0: pop/shake는 no-op', () => {
    r.mount(el, GHANA, 'ko');
    r.setJuiceLevel(0);
    r.pop();
    r.shake();
    expect(el.classList.contains('wt-prompt--pop')).toBe(false);
    expect(el.classList.contains('wt-prompt--shake')).toBe(false);
  });
});

describe('unmount — DOM/타이머 정리', () => {
  it('unmount 후 슬롯과 wt-prompt class가 제거된다', () => {
    r.mount(el, GHANA, 'ko');
    expect(glyphEls().length).toBeGreaterThan(0);
    r.unmount();
    expect(el.querySelector('.wt-slot')).toBeNull();
    expect(el.querySelector('.wt-unit')).toBeNull();
    expect(el.classList.contains('wt-prompt')).toBe(false);
    expect(r.getUnitStates()).toEqual([]);
  });
});
