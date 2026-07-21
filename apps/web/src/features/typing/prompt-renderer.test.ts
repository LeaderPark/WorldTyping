// @vitest-environment jsdom
//
// spec: docs/03 §2.8(음절 상태 전이·오타 이중 부호화·별칭 동결), §2.10 #1(가나 도깨비불 무오타),
//       docs/07 WT-M2-03 지시 7 + acceptance(가나 무오타는 jsdom 렌더러 테스트로 자동 검증).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileTargets, matchInputDetail, type Country } from '@wt/shared';
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

function unitEls(): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.wt-unit'));
}

describe('PromptRenderer.mount — 자모 경계 사전 계산', () => {
  it('한글: 음절 단위 span + data-jamo-start/len (몽골 = ㅁㅗㅇ|ㄱㅗㄹ)', () => {
    r.mount(el, MONGOLIA, 'ko');
    const units = unitEls();
    expect(units).toHaveLength(2);
    expect(units[0]!.textContent).toBe('몽');
    expect(units[0]!.dataset.jamoStart).toBe('0');
    expect(units[0]!.dataset.jamoLen).toBe('3');
    expect(units[0]!.dataset.unit).toBe('syllable');
    expect(units[1]!.textContent).toBe('골');
    expect(units[1]!.dataset.jamoStart).toBe('3');
    expect(units[1]!.dataset.jamoLen).toBe('3');
  });

  it('영어: 문자 단위 span, 공백은 len 0 구분자 (South Korea)', () => {
    r.mount(el, KOREA, 'en');
    const units = unitEls();
    expect(units.map((u) => u.textContent).join('')).toBe('South Korea');
    const space = units.find((u) => u.textContent === ' ')!;
    expect(space.dataset.jamoLen).toBe('0');
    expect(space.classList.contains('wt-unit--sep')).toBe(true);
    // 마지막 문자 'a'의 시작 오프셋 = "southkore".length = 9
    expect(units.at(-1)!.dataset.jamoStart).toBe('9');
  });

  it('마운트 직후 전 유닛 pending', () => {
    r.mount(el, MONGOLIA, 'ko');
    expect(r.getUnitStates()).toEqual(['pending', 'pending']);
  });
});

describe('PromptRenderer.update — 음절 상태 전이(몽골)', () => {
  it('pending → partial → done 로 전이한다', () => {
    r.mount(el, MONGOLIA, 'ko');
    // "몽" 조합 시작(ㅁ): 첫 음절 partial, 둘째 pending
    r.update(detailFor('ㅁ', MONGOLIA, 'ko'));
    expect(r.getUnitStates()).toEqual(['partial', 'pending']);
    // "몽" 완성: 첫 음절 done, 둘째 pending
    r.update(detailFor('몽', MONGOLIA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'pending']);
    // "몽고"(ㄱㅗ): 둘째 음절 partial
    r.update(detailFor('몽고', MONGOLIA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'partial']);
    // "몽골": 둘째 음절도 done(EXACT 순간의 detail)
    r.update(detailFor('몽골', MONGOLIA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'done']);
  });
});

describe('도깨비불 "가나" — 오타 표시 없음(§2.10 #1 acceptance 자동 검증)', () => {
  it('ㄱ→가→간→가나 전 과정에서 어떤 음절도 error가 되지 않는다', () => {
    r.mount(el, GHANA, 'ko');
    for (const raw of ['ㄱ', '가', '간', '가나']) {
      r.update(detailFor(raw, GHANA, 'ko'));
      expect(r.getUnitStates()).not.toContain('error');
      expect(el.querySelector('.is-error')).toBeNull();
    }
    // 특히 "간" 시점: 받침 ㄴ이 둘째 음절 커서로 흡수되어 partial(오타 아님)
    r.update(detailFor('간', GHANA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'partial']);
    // 최종 "가나": 완성
    r.update(detailFor('가나', GHANA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'done']);
  });
});

describe('오타 채색 — 적색 + 물결 밑줄(색각 이중 부호화)', () => {
  it('"가바"(가 뒤 오타 ㅂ)에서 둘째 음절이 error class를 얻는다', () => {
    r.mount(el, GHANA, 'ko');
    r.update(detailFor('가바', GHANA, 'ko'));
    expect(r.getUnitStates()).toEqual(['done', 'error']);
    const errored = unitEls()[1]!;
    expect(errored.classList.contains('is-error')).toBe(true);
    expect(errored.dataset.state).toBe('error');
  });
});

describe('별칭 경로 — 캐노니컬 채색 동결 + 미니 에코', () => {
  it('"한국"(캐노니컬 대한민국) 입력 시 캐노니컬 pending 동결 + 에코 표시', () => {
    r.mount(el, KOREA, 'ko');
    r.update(detailFor('한', KOREA, 'ko'), '한');
    // 캐노니컬 4음절은 전부 pending 그대로(억지 매핑 금지)
    expect(r.getUnitStates()).toEqual(['pending', 'pending', 'pending', 'pending']);
    const echo = el.querySelector<HTMLElement>('.wt-prompt__echo')!;
    expect(echo.classList.contains('is-visible')).toBe(true);
    expect(echo.textContent).toBe('한');

    r.update(detailFor('한국', KOREA, 'ko'), '한국');
    expect(echo.textContent).toBe('한국');
    expect(r.getUnitStates()).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('캐노니컬 접두로 복귀하면 동결 해제 + 에코 숨김', () => {
    r.mount(el, KOREA, 'ko');
    r.update(detailFor('한', KOREA, 'ko'), '한'); // 별칭 → 동결
    r.update(detailFor('ㄷ', KOREA, 'ko'), 'ㄷ'); // 캐노니컬 접두(ㄷ) → 해제
    const echo = el.querySelector<HTMLElement>('.wt-prompt__echo')!;
    expect(echo.classList.contains('is-visible')).toBe(false);
    // 'ㄷ' = 캐노니컬 첫 음절 조합 시작 → partial, 나머지 pending
    expect(r.getUnitStates()).toEqual(['partial', 'pending', 'pending', 'pending']);
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
  it('unmount 후 자식 노드와 wt-prompt class가 제거된다', () => {
    r.mount(el, GHANA, 'ko');
    expect(unitEls().length).toBeGreaterThan(0);
    r.unmount();
    expect(el.querySelector('.wt-unit')).toBeNull();
    expect(el.classList.contains('wt-prompt')).toBe(false);
    expect(r.getUnitStates()).toEqual([]);
  });
});
