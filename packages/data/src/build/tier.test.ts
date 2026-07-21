// spec: docs/02 §4.1 (F 산식), §4.2 (경계값), WT-M1-05
import { describe, expect, it } from 'vitest';
import { clamp, populationScore, nameLengthPenalty, familiarity, tierFromF, computeTier } from './tier';

describe('clamp', () => {
  it('범위로 자른다', () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});

describe('populationScore P (§4.1)', () => {
  it('인구 10만(10^5) → 0', () => {
    expect(populationScore(100_000)).toBeCloseTo(0, 5);
  });
  it('0 이하 인구는 0', () => {
    expect(populationScore(0)).toBe(0);
    expect(populationScore(-1)).toBe(0);
  });
  it('미국(3.41억) → 84 (§4.3 표와 일치)', () => {
    expect(Math.round(populationScore(341_000_000))).toBe(84);
  });
  it('한국(5,170만) → 65 (§4.3 표와 일치)', () => {
    expect(Math.round(populationScore(51_712_619))).toBe(65);
  });
  it('중국(14.1억)은 거의 만점(§4.3 표의 P≈97 은 반올림 근사)', () => {
    // 산식 정의(§4.1)를 그대로 적용한 값. KR·US 는 표와 정확히 일치하며, CN 표기값 97 은 근사치다.
    expect(populationScore(1_410_000_000)).toBeGreaterThan(97);
    expect(Math.round(populationScore(1_410_000_000))).toBe(99);
  });
  it('상한 클램프(초거대 인구)', () => {
    expect(populationScore(1e12)).toBe(100);
  });
});

describe('nameLengthPenalty L (§4.1, 음절 수)', () => {
  it('≤3음절 → 0', () => {
    expect(nameLengthPenalty('미국')).toBe(0);
    expect(nameLengthPenalty('프랑스')).toBe(0);
  });
  it('4음절 → 25', () => {
    expect(nameLengthPenalty('대한민국')).toBe(25);
  });
  it('5음절 → 45', () => {
    expect(nameLengthPenalty('아르헨티나')).toBe(45);
  });
  it('6-7음절 → 70', () => {
    expect(nameLengthPenalty('우즈베키스탄')).toBe(70); // 6음절
    expect(nameLengthPenalty('보스니아헤르체')).toBe(70); // 7음절
  });
  it('≥8음절 → 100', () => {
    expect(nameLengthPenalty('스리자야와르데네푸라코테')).toBe(100);
  });
  it('공백·구두점은 음절에서 제외', () => {
    expect(nameLengthPenalty('콩고 공화국')).toBe(nameLengthPenalty('콩고공화국')); // 5음절 → 45
    expect(nameLengthPenalty('콩고 공화국')).toBe(45);
  });
});

describe('familiarity F & 경계(§4.2)', () => {
  it('F = 0.5R + 0.35P + 0.15(100−L)', () => {
    // R=100, P=0, L=0 → 0.5*100 + 0 + 0.15*100 = 65
    expect(familiarity(100, 100_000, '가나')).toBeCloseTo(65, 5);
  });
  it('경계값 배정', () => {
    expect(tierFromF(72)).toBe(1);
    expect(tierFromF(71.9)).toBe(2);
    expect(tierFromF(55)).toBe(2);
    expect(tierFromF(54.9)).toBe(3);
    expect(tierFromF(38)).toBe(3);
    expect(tierFromF(37.9)).toBe(4);
    expect(tierFromF(22)).toBe(4);
    expect(tierFromF(21.9)).toBe(5);
    expect(tierFromF(0)).toBe(5);
  });
  it('computeTier 는 산식→경계 파이프', () => {
    // 투발루: R=0, pop=11000(P=0), L=0(3음절) → F=15 → T5
    expect(computeTier(0, 11_000, '투발루')).toBe(5);
  });
});
