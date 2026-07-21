// spec: docs/02 §10 Step 8 (generated 상수), §3.3 (자모 오라클 198 전수), WT-M1-05
import { disassemble } from 'es-hangul';
import { describe, expect, it } from 'vitest';
import { toJamoSeq } from '@wt/shared';
import { COUNTRIES, CountriesDatasetSchema } from './index';

describe('@wt/data — 배럴 export', () => {
  it('COUNTRIES 상수는 198개', () => {
    expect(COUNTRIES.length).toBe(198);
  });
  it('COUNTRIES 는 id 오름차순', () => {
    const ids = COUNTRIES.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
  it('COUNTRIES 각 레코드가 스키마를 만족', () => {
    // dataset 스키마로 전체를 한 번에 검증(서버 번들 상수의 무결성)
    const ds = {
      schemaVersion: 2 as const,
      builtAt: '2026-07-21T00:00:00.000Z',
      sources: { worldCountries: '5.1.0', worldAtlas: '2.0.2' },
      countries: COUNTRIES,
    };
    expect(() => CountriesDatasetSchema.parse(ds)).not.toThrow();
  });
});

// WT-M1-01 3-d 의 완성: es-hangul 교차 오라클을 198개국 nameKo 전수로 확장.
// 정책 차이(쌍자음/ㅐㅔㅒㅖ 미분해)를 흡수하려 양쪽을 동일 atomize 필터로 완전 원자화 후 비교.
describe('nameKo 198 전수 — es-hangul 교차 오라클 (§3.3)', () => {
  const ATOMIZE: Record<string, string> = {
    ㄲ: 'ㄱㄱ', ㄸ: 'ㄷㄷ', ㅃ: 'ㅂㅂ', ㅆ: 'ㅅㅅ', ㅉ: 'ㅈㅈ',
    ㅐ: 'ㅏㅣ', ㅔ: 'ㅓㅣ', ㅒ: 'ㅑㅣ', ㅖ: 'ㅕㅣ',
  };
  const atomize = (s: string): string => [...s].map((c) => ATOMIZE[c] ?? c).join('');
  // 공백은 양쪽 처리 차이를 피하려 제거하고 순수 한글 음절열만 대조한다.
  const strip = (s: string): string => s.replace(/\s/g, '');

  it('198개국 nameKo 자모 분해가 es-hangul 과 원자화 후 일치', () => {
    for (const c of COUNTRIES) {
      const s = strip(c.nameKo);
      expect(atomize(toJamoSeq(s)), `${c.id} ${c.nameKo}`).toBe(atomize(disassemble(s)));
    }
  });

  it('acceptedInputsKo(정규화 완료) 전수도 오라클과 일치', () => {
    for (const c of COUNTRIES) {
      for (const input of c.acceptedInputsKo) {
        // 라틴 포함 별칭(UAE, DR콩고 등)은 한글 구간만 비교 대상이 아니므로 스킵
        if (/[^가-힣]/.test(input)) continue;
        expect(atomize(toJamoSeq(input)), `${c.id} ${input}`).toBe(atomize(disassemble(input)));
      }
    }
  });
});
