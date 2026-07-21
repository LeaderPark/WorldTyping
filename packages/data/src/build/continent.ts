// spec: docs/02 §5.1 (대륙 배정 규칙), docs/00 §11-D3 (대륙 국가 수 확정), WT-M1-05
//
// world-countries region/subregion → 게임 continent. 명시 override가 규칙보다 우선한다.
// 결과 카운트(un195): asia 47 / europe 45 / africa 54 / NA 23 / SA 12 / OC 14 = 195.

import type { Continent } from '@wt/shared';

/** id별 명시 override(§5.1). 수도/지정학 기준의 확정 배정. */
const CONTINENT_OVERRIDE: Record<string, Continent> = {
  RU: 'europe', // 수도(모스크바) 기준
  TR: 'asia',
  CY: 'europe',
  GE: 'asia',
  AM: 'asia',
  AZ: 'asia',
  TL: 'asia',
  EH: 'africa',
};

export function assignContinent(id: string, region: string, subregion: string): Continent {
  const override = CONTINENT_OVERRIDE[id];
  if (override) return override;
  switch (region) {
    case 'Asia':
      return 'asia';
    case 'Europe':
      return 'europe';
    case 'Africa':
      return 'africa';
    case 'Oceania':
      return 'oceania';
    case 'Americas':
      return subregion === 'South America' ? 'south-america' : 'north-america';
    default:
      throw new Error(`assignContinent: unknown region "${region}" for ${id} (docs/02 §5.1)`);
  }
}

/** un195 기준 대륙별 기대 국가 수(§5.1, §11-D3). 이탈 시 빌드 throw. */
export const EXPECTED_CONTINENT_COUNTS: Record<Continent, number> = {
  asia: 47,
  europe: 45,
  africa: 54,
  'north-america': 23,
  'south-america': 12,
  oceania: 14,
};
