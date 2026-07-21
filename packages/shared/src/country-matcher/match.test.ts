// spec: docs/02 §3.3 (매칭 본체 + 테스트 표), docs/03 §2.6 (matchInputDetail), WT-M1-01 지시 3-a·3-c
import { describe, expect, it } from 'vitest';
import type { Country } from '../types/country';
import {
  commonPrefixLen,
  compileTargets,
  matchInput,
  matchInputDetail,
  type CompiledTarget,
} from './match';

/** 테스트 픽스처: compileTargets는 acceptedInputsKo/En만 읽으므로 나머지는 기본값으로 채운다. */
function country(over: Partial<Country> & Pick<Country, 'id'>): Country {
  const base: Country = {
    id: over.id,
    iso3: 'XXX',
    nameKo: '',
    nameEn: '',
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: 1,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [],
    acceptedInputsEn: [],
  };
  return Object.assign(base, over);
}

const GH = country({ id: 'GH', acceptedInputsKo: ['가나'] });
const GT = country({ id: 'GT', acceptedInputsKo: ['과테말라'] });
const KR = country({ id: 'KR', acceptedInputsKo: ['대한민국', '한국', '남한'] });
const US = country({
  id: 'US',
  acceptedInputsKo: ['미국', '미합중국'],
  acceptedInputsEn: ['unitedstates', 'usa', 'unitedstatesofamerica', 'america', 'us'],
});
const BE = country({ id: 'BE', acceptedInputsKo: ['벨기에'] });
const CI = country({
  id: 'CI',
  acceptedInputsEn: ['ivorycoast', 'cotedivoire', 'republicofcotedivoire'],
});

const ko = (c: Country): CompiledTarget[] => compileTargets(c, 'ko');
const en = (c: Country): CompiledTarget[] => compileTargets(c, 'en');
/** 목표에 대한 입력 시퀀스를 평가해 상태 배열로 반환 */
const seq = (inputs: string[], targets: CompiledTarget[], lang: 'ko' | 'en') =>
  inputs.map((i) => matchInput(i, targets, lang));

describe('docs/02 §3.3 테스트 표 (7행, 표 순서대로)', () => {
  it('1행 · 가나(GH) · "ㄱ"→"가"→"간"→"가나" → P→P→P→EXACT', () => {
    expect(seq(['ㄱ', '가', '간', '가나'], ko(GH), 'ko')).toEqual([
      'PREFIX',
      'PREFIX',
      'PREFIX',
      'EXACT',
    ]);
  });

  it('2행 · 과테말라 · "ㄱ"→"고"→"과"→"과테말라" → P→P→P→EXACT', () => {
    expect(seq(['ㄱ', '고', '과', '과테말라'], ko(GT), 'ko')).toEqual([
      'PREFIX',
      'PREFIX',
      'PREFIX',
      'EXACT',
    ]);
  });

  it('3행 · 대한민국(KR) · "한국" → EXACT (별칭)', () => {
    expect(matchInput('한국', ko(KR), 'ko')).toBe('EXACT');
  });

  it('4행 · 미국(US) · "일" → MISS', () => {
    expect(matchInput('일', ko(US), 'ko')).toBe('MISS');
  });

  // 5행 · 벨기에 · "벨"→"벩"(ㄱ 오타로 받침).
  // ⚠️ 문서 표의 기대값은 P→MISS이나, §3.3의 매처 코드(canonical 진실 함수)는 P→PREFIX를 낸다.
  // 벩=ㅂㅔㄹㄱ 는 벨기에=ㅂㅔㄹㄱㅣㅇㅔ 의 자모 접두이며(도깨비불 전이 간→가나와 동일 부류),
  // 이를 MISS로 판정하면 알고리즘이 해결하려는 바로 그 버그가 재발한다.
  // 매처 코드를 임의 수정하지 않고 canonical 동작을 검증한다(에스컬레이션: 표 5행 기대값 정정 제안).
  it('5행 · 벨기에 · "벨"→"벩" → P→PREFIX (매처 canonical; 표의 MISS는 오기)', () => {
    expect(seq(['벨', '벩'], ko(BE), 'ko')).toEqual(['PREFIX', 'PREFIX']);
    // 표의 의도(진짜 오타 → MISS)는 잘못된 자음으로 별도 검증한다.
    expect(matchInput('벨키', ko(BE), 'ko')).toBe('MISS'); // ㅂㅔㄹㅋㅣ 는 접두 아님
  });

  it("6행 · Côte d'Ivoire(CI) · \"cote divoire\" → EXACT (공백·아포스트로피 무시)", () => {
    expect(matchInput('cote divoire', en(CI), 'en')).toBe('EXACT');
  });

  it('7행 · United States(US) · "usa" / "america" → EXACT', () => {
    expect(matchInput('usa', en(US), 'en')).toBe('EXACT');
    expect(matchInput('america', en(US), 'en')).toBe('EXACT');
  });
});

describe('matchInput 경계', () => {
  it('빈 입력·공백만 입력은 항상 PREFIX', () => {
    expect(matchInput('', ko(GH), 'ko')).toBe('PREFIX');
    expect(matchInput('   ', ko(GH), 'ko')).toBe('PREFIX');
    expect(matchInput('', en(US), 'en')).toBe('PREFIX');
  });
  it('짧은 별칭이 다른 별칭의 진접두여도 EXACT가 우선한다', () => {
    // "us" 는 "usa"·"unitedstates…" 의 접두이지만 자체가 acceptedInput이므로 EXACT.
    expect(matchInput('us', en(US), 'en')).toBe('EXACT');
  });
});

describe('commonPrefixLen', () => {
  it('공통 접두 길이를 센다', () => {
    expect(commonPrefixLen('abcd', 'abxy')).toBe(2);
    expect(commonPrefixLen('abc', 'abc')).toBe(3);
    expect(commonPrefixLen('', 'abc')).toBe(0);
    expect(commonPrefixLen('abc', '')).toBe(0);
    expect(commonPrefixLen('xyz', 'abc')).toBe(0);
  });
});

describe('matchInputDetail (docs/03 §2.6)', () => {
  it('빈 targets는 계약 위반으로 throw', () => {
    expect(() => matchInputDetail('가', [], 'ko')).toThrow(/targets must not be empty/);
  });

  it('EXACT: matchedLen·inputLen이 key 길이와 같다', () => {
    const d = matchInputDetail('한국', ko(KR), 'ko');
    expect(d.state).toBe('EXACT');
    expect(d.bestTarget.display).toBe('한국');
    expect(d.matchedLen).toBe(d.inputLen);
    expect(d.inputLen).toBe('ㅎㅏㄴㄱㅜㄱ'.length);
  });

  it('PREFIX: 공통 prefix가 가장 긴 타깃을 bestTarget으로 고른다', () => {
    // 입력 "unite" → "unitedstates"(공통5)를 "usa"·"us"(공통1)보다 우선.
    const d = matchInputDetail('unite', en(US), 'en');
    expect(d.state).toBe('PREFIX');
    expect(d.bestTarget.display).toBe('unitedstates');
    expect(d.matchedLen).toBe(5);
    expect(d.inputLen).toBe(5);
  });

  it('MISS: bestTarget은 최장 공통 prefix 타깃, matchedLen<inputLen', () => {
    const d = matchInputDetail('unitedz', en(US), 'en');
    expect(d.state).toBe('MISS');
    expect(d.bestTarget.display).toBe('unitedstates');
    expect(d.matchedLen).toBe(6); // "united"
    expect(d.inputLen).toBe(7);
  });

  it('빈 입력은 PREFIX (matchedLen -1, inputLen 0)', () => {
    const d = matchInputDetail('', ko(GH), 'ko');
    expect(d.state).toBe('PREFIX');
    expect(d.inputLen).toBe(0);
  });

  it('MISS 상태에서 백스페이스로 PREFIX 복귀', () => {
    const t = ko(GT); // 과테말라 = ㄱㅗㅏㅌㅔㅁㅏㄹㄹㅏ
    const miss = matchInputDetail('과주', t, 'ko'); // ㄱㅗㅏㅈㅜ — 위치3(ㅈ≠ㅌ) 불일치
    expect(miss.state).toBe('MISS');
    expect(miss.matchedLen).toBe(3); // ㄱㅗㅏ 까지 일치
    const back = matchInputDetail('과', t, 'ko'); // 백스페이스 후
    expect(back.state).toBe('PREFIX');
  });
});

describe('compileTargets', () => {
  it('ko는 자모 시퀀스 key, display는 원문', () => {
    const [t] = compileTargets(GH, 'ko');
    expect(t).toEqual({ display: '가나', key: 'ㄱㅏㄴㅏ' });
  });
  it('en은 normalize된 문자열 그대로 key', () => {
    const ts = compileTargets(US, 'en');
    expect(ts.map((t) => t.key)).toContain('usa');
    expect(ts[0]).toEqual({ display: 'unitedstates', key: 'unitedstates' });
  });
});
