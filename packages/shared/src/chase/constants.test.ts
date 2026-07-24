// spec: docs/09 §3(수치)·§9.4(KV config:chase zod 검증·병합), docs/00 §11-D91·D93·D94
import { describe, expect, it } from 'vitest';
import {
  CHASE_CONSTANTS_VERSION,
  ChaseConstantsOverrideSchema,
  DEFAULT_CHASE_CONSTANTS,
  mergeChaseConstants,
  parseChaseConstants,
} from './constants';

describe('ChaseConstants 기본값(§3 전사)', () => {
  it('docs/09 §3 수치를 1:1로 담는다', () => {
    const c = DEFAULT_CHASE_CONSTANTS;
    expect(c.nearestPoolSize).toBe(12);
    expect(c.prevHopsExcluded).toBe(2);
    expect(c.firstWantedHops).toBe(3);
    expect(c.firstWantedDistanceKm).toBe(2000);
    expect(c.wantedIntervalMs).toBe(45_000);
    expect(c.wantedMax).toBe(5);
    expect(c.deliveryStarDrop).toBe(2);
    expect(c.wantedFloor).toBe(1);
    expect(c.escapeReduction).toEqual({
      enabled: true,
      windowMs: 20_000,
      distanceKm: 3000,
      cooldownMs: 30_000,
      starDrop: 1,
      floor: 1,
    });
    expect(c.police.chaserBaseTickMs).toBe(4200);
    expect(c.police.chaserTickPerStarMs).toBe(300);
    expect(c.police.chaserMinTickMs).toBe(3000);
    expect(c.police.interceptorTickMs).toBe(4200);
    expect(c.police.heliTickMs).toBe(1800);
    expect(c.police.interceptorChaseSwitchHops).toBe(2);
    expect(c.police.heliRingHops).toBe(4);
    expect(c.police.chaserSpawnHopsBack).toBe(2);
    // ★5 추격조 틱 = 4200 − 300×4 = 3000(minTick과 일치).
    expect(c.police.chaserBaseTickMs - c.police.chaserTickPerStarMs * 4).toBe(c.police.chaserMinTickMs);
    expect(c.gold.activeCount).toBe(4);
    expect([c.gold.ringNearProb, c.gold.ringMidProb, c.gold.ringFarProb]).toEqual([0.3, 0.45, 0.25]);
    expect(c.gold.ringNearProb + c.gold.ringMidProb + c.gold.ringFarProb).toBeCloseTo(1, 10);
    expect([c.gold.valueNear, c.gold.valueMid, c.gold.valueFar]).toEqual([400, 700, 1200]);
    expect(c.gold.highTierWeight).toBe(2);
    expect(c.gold.highTierMinTier).toBe(4);
    expect(c.score.haulStep).toBe(0.25);
    expect(c.score.survivalStarMultiplier).toBe(2);
    expect(c.score.unbankedOnArrestFactor).toBe(0.5);
  });

  it('기본값 객체는 동결(런타임 변경 금지)', () => {
    expect(Object.isFrozen(DEFAULT_CHASE_CONSTANTS)).toBe(true);
  });

  it('버전 상수를 노출한다(§9.4)', () => {
    expect(CHASE_CONSTANTS_VERSION).toBe(1);
  });
});

describe('KV config:chase 오버라이드 zod .strict() 검증', () => {
  it('빈 오버라이드는 기본값과 동일', () => {
    expect(mergeChaseConstants({})).toEqual(DEFAULT_CHASE_CONSTANTS);
    expect(mergeChaseConstants()).toEqual(DEFAULT_CHASE_CONSTANTS);
  });

  it('최상위 스칼라 partial 치환', () => {
    const merged = mergeChaseConstants({ wantedIntervalMs: 30_000, wantedMax: 4 });
    expect(merged.wantedIntervalMs).toBe(30_000);
    expect(merged.wantedMax).toBe(4);
    expect(merged.firstWantedHops).toBe(DEFAULT_CHASE_CONSTANTS.firstWantedHops); // 나머지 보존
  });

  it('중첩 객체는 필드 단위 병합(다른 필드 보존)', () => {
    const merged = mergeChaseConstants({
      escapeReduction: { enabled: false },
      police: { heliTickMs: 1500 },
      gold: { valueFar: 2000 },
      score: { haulStep: 0.5 },
    });
    expect(merged.escapeReduction.enabled).toBe(false);
    expect(merged.escapeReduction.windowMs).toBe(20_000); // 보존
    expect(merged.police.heliTickMs).toBe(1500);
    expect(merged.police.chaserBaseTickMs).toBe(4200); // 보존
    expect(merged.gold.valueFar).toBe(2000);
    expect(merged.gold.valueNear).toBe(400); // 보존
    expect(merged.score.haulStep).toBe(0.5);
    expect(merged.score.unbankedOnArrestFactor).toBe(0.5); // 보존
    // 기본값 원본은 불변.
    expect(DEFAULT_CHASE_CONSTANTS.escapeReduction.enabled).toBe(true);
  });

  it('미지의 키는 .strict()로 거부', () => {
    expect(ChaseConstantsOverrideSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(ChaseConstantsOverrideSchema.safeParse({ police: { bogus: 1 } }).success).toBe(false);
    expect(ChaseConstantsOverrideSchema.safeParse({ escapeReduction: { enabled: true } }).success).toBe(true);
  });

  it('parseChaseConstants: 유효 원문은 병합, 무효/부적합은 기본값 폴백(§9.4)', () => {
    expect(parseChaseConstants({ wantedMax: 3 }).wantedMax).toBe(3);
    // 미지의 키 → 폴백.
    expect(parseChaseConstants({ nope: true })).toEqual(DEFAULT_CHASE_CONSTANTS);
    // 타입 부적합 → 폴백.
    expect(parseChaseConstants({ wantedMax: 'x' })).toEqual(DEFAULT_CHASE_CONSTANTS);
    // null/undefined → 기본값.
    expect(parseChaseConstants(null)).toEqual(DEFAULT_CHASE_CONSTANTS);
    expect(parseChaseConstants(undefined)).toEqual(DEFAULT_CHASE_CONSTANTS);
    // unbankedOnArrestFactor 범위(0~1) 밖 → 폴백.
    expect(parseChaseConstants({ score: { unbankedOnArrestFactor: 2 } })).toEqual(DEFAULT_CHASE_CONSTANTS);
  });
});
