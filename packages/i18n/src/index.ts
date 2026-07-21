// spec: docs/02 §9 (카탈로그 규칙·초기 키), docs/00 §11-D20(i18next 확정 — 이 배럴은 카탈로그
// 원천만 제공한다. 런타임 포매터/보간은 apps/web의 i18next 설정이 맡는다), §11-D18(노출명 TypeTrip)
//
// packages/i18n/{ko,en}.json이 UI 문자열의 단일 원천이다. 국가명은 여기 수록하지 않는다
// (countries.json이 원천 — docs/02 §9). 이 파일은 두 카탈로그를 배럴로 export하고, ko.json의
// 키 집합에서 타입 안전 키 유니온(I18nKey)을 생성한다. ko/en 키 집합 동일성은
// src/keys.test.ts가 강제한다(이 테스트가 CI 게이트).

import ko from '../ko.json';
import en from '../en.json';

/** ko.json의 키 전량을 소스로 하는 유니온. en.json은 키 집합이 이와 완전히 동일해야 한다. */
export type I18nKey = keyof typeof ko;

export type Locale = 'ko' | 'en';

export const catalogs: Record<Locale, Record<string, string>> = { ko, en };

export function isI18nKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(ko, key);
}
