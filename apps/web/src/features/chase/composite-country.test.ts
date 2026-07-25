// spec: docs/00 §11-D97, WT-CH-06 acceptance("컨트롤러 합성-Country 배선").
import { describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import { compileTargets } from '@wt/shared';
import { CHASE_COMPOSITE_ID, buildCompositeCountry } from './composite-country';

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
    acceptedInputsEn: [p.nameEn.toLowerCase()],
    ...p,
  };
}

const MN = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia' });
const JP = mk({ id: 'JP', nameKo: '일본', nameEn: 'japan', acceptedInputsKo: ['일본'], acceptedInputsEn: ['japan'] });
const KR = mk({
  id: 'KR',
  nameKo: '대한민국',
  nameEn: 'south korea',
  acceptedInputsKo: ['대한민국', '한국'],
  acceptedInputsEn: ['southkorea', 'korea'],
});

describe('buildCompositeCountry — D97 합성 타깃', () => {
  it('빈 후보 배열은 throw(계약 위반 조기 검출)', () => {
    expect(() => buildCompositeCountry([])).toThrow();
  });

  it('센티널 id를 부여한다(실 국가 조회 불가 표식)', () => {
    const c = buildCompositeCountry([MN]);
    expect(c.id).toBe(CHASE_COMPOSITE_ID);
  });

  it('3후보의 acceptedInputsKo/En 합집합을 싣는다(중복 제거·순서 보존)', () => {
    const c = buildCompositeCountry([MN, JP, KR]);
    expect(c.acceptedInputsKo).toEqual(['몽골', '일본', '대한민국', '한국']);
    expect(c.acceptedInputsEn).toEqual(['mongolia', 'japan', 'southkorea', 'korea']);
  });

  it('compileTargets(합성, lang)가 3후보 전부를 커버해 각각 EXACT 판정을 낸다(D97 핵심 계약)', () => {
    const c = buildCompositeCountry([MN, JP, KR]);
    const targetsKo = compileTargets(c, 'ko');
    const targetsEn = compileTargets(c, 'en');
    // ko: 자모 시퀀스로 컴파일되므로 display 필드로 원문 대조.
    expect(targetsKo.map((t) => t.display)).toEqual(['몽골', '일본', '대한민국', '한국']);
    expect(targetsEn.map((t) => t.display)).toEqual(['mongolia', 'japan', 'southkorea', 'korea']);
  });

  it('나머지 필드는 첫 후보를 복제한 자리표시자(컨트롤러가 참조하지 않음)', () => {
    const c = buildCompositeCountry([JP, MN]);
    expect(c.nameKo).toBe(JP.nameKo);
    expect(c.difficultyTier).toBe(JP.difficultyTier);
  });
});
