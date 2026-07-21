// spec: docs/01 §6.2·§7.2(L_i), docs/00 §11-D4, WT-M1-02 지시 4(제약: 재구현 금지)
import { describe, expect, it } from 'vitest';
import { toJamoSeq } from '../country-matcher/hangul';
import { normalizeEn, normalizeKo } from '../country-matcher/normalize';
import { requiredKeystrokes } from './keystrokes';

describe('requiredKeystrokes — L_i는 WT-M1-01의 normalize/toJamoSeq에 위임한다(재구현 아님)', () => {
  it('ko: toJamoSeq(normalizeKo(nameKo)).length과 정확히 같다', () => {
    const cases = ['대한민국', '가나', '상투메 프린시페', '파푸아 뉴기니', '과테말라'];
    for (const nameKo of cases) {
      expect(requiredKeystrokes({ nameKo, nameEn: '' }, 'ko')).toBe(
        toJamoSeq(normalizeKo(nameKo)).length,
      );
    }
  });

  it('en: normalizeEn(nameEn).length과 정확히 같다(공백 제거 후 — §11-D4)', () => {
    const cases = ['United States', "Côte d'Ivoire", 'Papua New Guinea', 'Peru'];
    for (const nameEn of cases) {
      expect(requiredKeystrokes({ nameKo: '', nameEn }, 'en')).toBe(normalizeEn(nameEn).length);
    }
  });

  it('알려진 값: "가나" → 4자모(ㄱㅏㄴㅏ)', () => {
    expect(requiredKeystrokes({ nameKo: '가나', nameEn: '' }, 'ko')).toBe(4);
  });

  it('알려진 값: "peru"(en) → 4문자', () => {
    expect(requiredKeystrokes({ nameKo: '', nameEn: 'peru' }, 'en')).toBe(4);
  });

  it('en 공백 제거 확인: "United States" → 12("unitedstates")', () => {
    expect(requiredKeystrokes({ nameKo: '', nameEn: 'United States' }, 'en')).toBe(12);
  });

  it('docs/01 §7.2 예시 문자열의 실제 자모수(사실 확인용, 미해결 사안은 time-limit.test.ts 참조): 미국=5, 상투메프린시페=16', () => {
    // docs/01 §7.2 본문은 "미국(4타)"·"상투메 프린시페(15타)"라고 쓰지만 실제 toJamoSeq
    // 결과는 각각 5·16이다(자음+모음+받침 전수 계상, WT-M1-01 정책 그대로). 이 테스트는
    // toJamoSeq/normalizeKo가 정확히 계산됨을 확인할 뿐, doc 수치와의 불일치를 어떻게
    // 해소할지는 결정하지 않는다 — 그 결정은 docs/00 §11 리드 승인 대기(escalations 기록).
    expect(requiredKeystrokes({ nameKo: '미국', nameEn: '' }, 'ko')).toBe(5);
    expect(requiredKeystrokes({ nameKo: '상투메 프린시페', nameEn: '' }, 'ko')).toBe(16);
  });
});
