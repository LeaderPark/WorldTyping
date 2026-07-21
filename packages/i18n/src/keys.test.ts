// spec: docs/02 §9 ("en.json은 ko.json과 키 집합이 완전히 동일해야 하며 CI에서 diff 검사"),
// WT-M1-07 acceptance ("ko.json/en.json 키 diff 0 — 이 테스트가 곧 CI 게이트").
import { describe, expect, it } from 'vitest';
import ko from '../ko.json';
import en from '../en.json';

function keySet(obj: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(obj));
}

describe('ko/en catalog key parity', () => {
  it('has an identical key set on both sides (symmetric diff is empty)', () => {
    const koKeys = keySet(ko);
    const enKeys = keySet(en);

    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k)).sort();
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k)).sort();

    expect(missingInEn, `ko.json에만 있고 en.json에 없는 키: ${JSON.stringify(missingInEn)}`).toEqual([]);
    expect(missingInKo, `en.json에만 있고 ko.json에 없는 키: ${JSON.stringify(missingInKo)}`).toEqual([]);
  });

  it('every value is a non-empty string (no accidental nesting/null)', () => {
    for (const [k, v] of Object.entries({ ...ko, ...en })) {
      expect(typeof v, `${k}의 값이 문자열이 아님`).toBe('string');
      expect((v as string).length > 0, `${k}의 값이 빈 문자열`).toBe(true);
    }
  });

  it('key naming follows 영역.의미[.상세] (max 3 dot-segments, lowercase/kebab/camel segments)', () => {
    const keyPattern = /^[a-z][a-z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){1,2}$/;
    for (const key of keySet(ko)) {
      expect(keyPattern.test(key), `키 규약 위반: ${key}`).toBe(true);
    }
  });

  it('app.title is the launch name TypeTrip (docs/00 §11-D18)', () => {
    expect(ko['app.title']).toBe('TypeTrip');
    expect(en['app.title']).toBe('TypeTrip');
  });

  it('does not carry country names (countries.json is the sole source, docs/02 §9)', () => {
    // 참고용 가드: 대표적인 국가 상용명이 카탈로그 값에 그대로 통째로 들어있지 않은지 느슨하게 점검.
    const suspicious = ['대한민국', 'South Korea', 'Japan', '일본'];
    for (const [key, value] of Object.entries(ko)) {
      for (const name of suspicious) {
        expect(value === name, `${key}에 국가명이 그대로 들어있음(countries.json 원천 위반)`).toBe(false);
      }
    }
  });
});
