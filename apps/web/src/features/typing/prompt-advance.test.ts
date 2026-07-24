// spec: docs/00 §11-D77 (프롬프트 캡슐 고정 폭·국가명 단일행, Tweak Q) — 설계 §3.4 골든.
//
// 진행폭(em) 산식이 CSS 슬롯 기하(globals.css .wt-unit/.wt-unit--sep/.wt-prompt__glyphs gap)와
// 1:1로 맞물리는지 고정. 이 값들은 설계 §4 폰트 산식(100cqw/adv×0.98)이 가정한 값이므로
// 드리프트가 나면 최장명 한 줄 수납이 깨진다(슬롯 em 상수 변경 시 이 골든과 CSS를 함께 수정).
import { describe, expect, it } from 'vitest';
import { promptAdvanceEm } from './prompt-advance';

describe('promptAdvanceEm — 프롬프트 진행폭 골든(D77)', () => {
  // ko 콘텐츠 2슬롯: 1.14×2 + gap 0.14×2 = 2.28 + 0.28
  it('가나 = 2.56em', () => {
    expect(promptAdvanceEm('가나', 'ko')).toBe(2.56);
  });

  // en 콘텐츠 10슬롯 + 공백 1: 0.78×10 + 0.4 + gap 0.14×11 = 8.2 + 1.54
  it('South Korea = 9.74em (스샷 2행 회귀 케이스)', () => {
    expect(promptAdvanceEm('South Korea', 'en')).toBe(9.74);
  });

  // en 최장(VC, tier 5): 콘텐츠 28슬롯 + 공백 4: 0.78×28 + 0.4×4 + gap 0.14×32 = 23.44 + 4.48
  it('Saint Vincent and the Grenadines = 27.92em (en 최장)', () => {
    expect(promptAdvanceEm('Saint Vincent and the Grenadines', 'en')).toBe(27.92);
  });

  // ko 최장(BA): 콘텐츠 10슬롯 + 공백 1: 1.14×10 + 0.4 + gap 0.14×11 = 11.8 + 1.54
  it('보스니아 헤르체고비나 = 13.34em (ko 최장)', () => {
    expect(promptAdvanceEm('보스니아 헤르체고비나', 'ko')).toBe(13.34);
  });

  // 구분자(공백)는 콘텐츠 유닛(0.78)이 아니라 SEP_EM(0.4)로 계상된다.
  it('구분자(공백)는 0.4em로 계상된다', () => {
    // 'a a': 0.78 + 0.4(sep) + 0.78 + gap 0.14×3 = 1.96 + 0.42 = 2.38
    expect(promptAdvanceEm('a a', 'en')).toBe(2.38);
    // 같은 3유닛이나 구분자 대신 글자면: 'aaa' = 0.78×3 + gap 0.14×3 = 2.34 + 0.42 = 2.76
    expect(promptAdvanceEm('aaa', 'en')).toBe(2.76);
    // 두 값 차 = 콘텐츠 폭(0.78) − 구분자 폭(0.4) = 0.38 → 구분자가 0.4em임을 확인.
    expect(promptAdvanceEm('aaa', 'en') - promptAdvanceEm('a a', 'en')).toBeCloseTo(0.38, 6);
  });
});
