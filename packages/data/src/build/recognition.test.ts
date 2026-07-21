// spec: docs/02 §4.1 (인지도 R 규칙 가산), WT-M1-05
import { describe, expect, it } from 'vitest';
import { seedRecognitionFor, seedRecognition, G20, OECD } from './recognition';

describe('seedRecognitionFor — 규칙 가산', () => {
  it('미국: G20+OECD+직항+월드컵+올림픽 = 100 클램프', () => {
    expect(seedRecognitionFor('US')).toBe(100);
  });
  it('가산 후 100 초과는 클램프', () => {
    // 여러 멤버십을 가진 국가는 100을 넘지 않는다
    expect(seedRecognitionFor('JP')).toBe(100);
    expect(seedRecognitionFor('KR')).toBeLessThanOrEqual(100);
  });
  it('어떤 멤버십도 없는 국가는 0', () => {
    expect(seedRecognitionFor('TV')).toBe(0);
    expect(seedRecognitionFor('KM')).toBe(0);
  });
  it('OECD 단독(+20) 예: 없음 방지용 — 콜롬비아는 OECD+직항+월드컵', () => {
    // CO: OECD(20) + WORLD_CUP(15) = 35 (직항 세트 미포함)
    expect(seedRecognitionFor('CO')).toBe(35);
  });
});

describe('seedRecognition — 맵 생성', () => {
  it('정렬된 키로 전 id 값을 만든다', () => {
    const rec = seedRecognition(['US', 'KR', 'TV']);
    expect(Object.keys(rec)).toEqual(['KR', 'TV', 'US']); // 정렬
    expect(rec.TV).toBe(0);
  });
  it('멤버십 집합은 서로소가 아니어도 되며 존재만 확인', () => {
    expect(G20.has('US')).toBe(true);
    expect(OECD.has('KR')).toBe(true);
  });
});
