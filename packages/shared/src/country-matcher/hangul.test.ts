// spec: docs/02 §3.3 (자모 분해), WT-M1-01 지시 3-b·3-d
import { disassemble } from 'es-hangul';
import { describe, expect, it } from 'vitest';
import { toJamoSeq } from './hangul';

describe('toJamoSeq — 분해 규칙 (WT-M1-01 3-b)', () => {
  it('복합 중성 분해: 과 → ㄱㅗㅏ', () => {
    expect(toJamoSeq('과')).toBe('ㄱㅗㅏ');
  });
  it('복합 중성 분해: 의 → ㅇㅡㅣ', () => {
    expect(toJamoSeq('의')).toBe('ㅇㅡㅣ');
  });
  it('복합 종성 분해: 닭 → ㄷㅏㄹㄱ', () => {
    expect(toJamoSeq('닭')).toBe('ㄷㅏㄹㄱ');
  });
  it('쌍자음 미분해: 까 → ㄲㅏ', () => {
    expect(toJamoSeq('까')).toBe('ㄲㅏ');
  });
  it('ㅐㅔ 미분해: 베 → ㅂㅔ', () => {
    expect(toJamoSeq('베')).toBe('ㅂㅔ');
  });

  it('모든 복합 중성 테이블을 개별 분해한다', () => {
    expect(toJamoSeq('와')).toBe('ㅇㅗㅏ'); // 와 = ㅇ + ㅘ(→ㅗㅏ)
    expect(toJamoSeq('왜')).toBe('ㅇㅗㅐ');
    expect(toJamoSeq('외')).toBe('ㅇㅗㅣ');
    expect(toJamoSeq('워')).toBe('ㅇㅜㅓ');
    expect(toJamoSeq('웨')).toBe('ㅇㅜㅔ');
    expect(toJamoSeq('위')).toBe('ㅇㅜㅣ');
    expect(toJamoSeq('희')).toBe('ㅎㅡㅣ');
  });

  it('모든 복합 종성 테이블을 개별 분해한다', () => {
    expect(toJamoSeq('몫')).toBe('ㅁㅗㄱㅅ'); // ㄳ
    expect(toJamoSeq('앉')).toBe('ㅇㅏㄴㅈ'); // ㄵ
    expect(toJamoSeq('많')).toBe('ㅁㅏㄴㅎ'); // ㄶ
    expect(toJamoSeq('읽')).toBe('ㅇㅣㄹㄱ'); // ㄺ
    expect(toJamoSeq('삶')).toBe('ㅅㅏㄹㅁ'); // ㄻ
    expect(toJamoSeq('밟')).toBe('ㅂㅏㄹㅂ'); // ㄼ
    expect(toJamoSeq('곬')).toBe('ㄱㅗㄹㅅ'); // ㄽ
    expect(toJamoSeq('핥')).toBe('ㅎㅏㄹㅌ'); // ㄾ
    expect(toJamoSeq('읊')).toBe('ㅇㅡㄹㅍ'); // ㄿ
    expect(toJamoSeq('앓')).toBe('ㅇㅏㄹㅎ'); // ㅀ
    expect(toJamoSeq('값')).toBe('ㄱㅏㅂㅅ'); // ㅄ
  });

  it('받침 없는 음절은 종성을 붙이지 않는다', () => {
    expect(toJamoSeq('가')).toBe('ㄱㅏ');
    expect(toJamoSeq('나')).toBe('ㄴㅏ');
  });

  it('낱자모(호환 자모)도 동일 테이블로 매핑한다', () => {
    expect(toJamoSeq('ㄱ')).toBe('ㄱ'); // COMPOUND 미포함 → 그대로
    expect(toJamoSeq('ㅘ')).toBe('ㅗㅏ'); // 낱자 복합 중성도 분해
    expect(toJamoSeq('ㄺ')).toBe('ㄹㄱ'); // 낱자 복합 종성도 분해
    expect(toJamoSeq('ㄲ')).toBe('ㄲ'); // 쌍자음 낱자는 미분해
  });

  it('비한글 문자(라틴·숫자·공백)는 그대로 통과한다', () => {
    expect(toJamoSeq('abc123')).toBe('abc123');
    expect(toJamoSeq('한국A1')).toBe('ㅎㅏㄴㄱㅜㄱA1');
    expect(toJamoSeq('')).toBe('');
  });
});

// WT-M1-01 3-d: es-hangul 교차 오라클 (무작위 100개 문자열)
// 정책 차이(쌍자음/ㅐㅔㅒㅖ 미분해)를 흡수하기 위해 양쪽 출력을 동일한 atomize 필터로
// 완전 원자화한 뒤 비교한다. 필터는 문맥 독립 per-char 매핑이라 양쪽에 같게 적용되므로,
// 두 구현이 어떤 표현을 택하든(ㄲ vs ㄱㄱ, ㅐ vs ㅏㅣ) 동일 서열이면 통과한다.
describe('toJamoSeq — es-hangul 교차 오라클 (WT-M1-01 3-d)', () => {
  const ATOMIZE: Record<string, string> = {
    ㄲ: 'ㄱㄱ',
    ㄸ: 'ㄷㄷ',
    ㅃ: 'ㅂㅂ',
    ㅆ: 'ㅅㅅ',
    ㅉ: 'ㅈㅈ',
    ㅐ: 'ㅏㅣ',
    ㅔ: 'ㅓㅣ',
    ㅒ: 'ㅑㅣ',
    ㅖ: 'ㅕㅣ',
  };
  const atomize = (s: string): string => [...s].map((c) => ATOMIZE[c] ?? c).join('');

  // 결정적 PRNG(재현성). WT-M1-03의 mulberry32는 아직 없으므로 테스트 로컬 LCG.
  function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  const randomSyllable = (rng: () => number): string =>
    String.fromCodePoint(0xac00 + Math.floor(rng() * (0xd7a3 - 0xac00 + 1)));

  it('무작위 100개 한글 문자열이 es-hangul disassemble와 원자화 후 일치한다', () => {
    const rng = makeRng(0x5eed_1234);
    for (let n = 0; n < 100; n++) {
      const len = 1 + Math.floor(rng() * 8);
      let s = '';
      for (let i = 0; i < len; i++) s += randomSyllable(rng);
      const mine = atomize(toJamoSeq(s));
      const oracle = atomize(disassemble(s));
      expect(mine, `문자열=${s}`).toBe(oracle);
    }
  });

  it('알려진 정책 차이 항목도 원자화 후 일치한다', () => {
    for (const s of ['까', '베', '얘', '계', '꿈', '쏘', '짱', '뛰어']) {
      expect(atomize(toJamoSeq(s)), s).toBe(atomize(disassemble(s)));
    }
  });
});
