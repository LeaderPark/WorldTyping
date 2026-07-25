// spec: docs/01 §7.2(서바이벌 국가당 제한시간 수식), WT-M1-02 acceptance,
//       docs/00 §11-D107(티어 서바이벌 전용 제한시간 계수, WT-TIER-DIFFICULTY)
import { describe, expect, it } from 'vitest';
import type { DifficultyTier } from '../types/country';
import {
  DEFAULT_TIME_LIMIT_CONFIG,
  TIER_TIME_FACTOR,
  tierTimeLimitMs,
  timeLimitMs,
  type TimeLimitSource,
} from './time-limit';

// docs/01 §7.2 본문의 예시("미국(4타)" → 3.58초, "상투메 프린시페(15타)" → 7.5초)는
// 공식 자체(clamp/tierRelax)를 확인하려는 것이었으나, keystrokes.test.ts에서 확인했듯
// 실제 toJamoSeq 결과는 미국=5자모·상투메프린시페=16자모로 문서 수치와 어긋난다(docs/01
// §7.2 자체의 손 계산 오차 — escalations 기록). 이 테스트는 문서가 검증하려던 "공식"은
// 그대로 유지하면서, 그 공식이 요구하는 L 값(4·15)을 정확히 만족하는 대체 예시로
// clamp·tierRelax·첫 국가 배수를 검증한다.
describe('timeLimitMs — 공식 검증 (docs/01 §7.2)', () => {
  it('T1, L=4 → 3.58s(±0.01) — "peru"(4문자)로 문서 미국 예시의 L=4를 재현', () => {
    const country: TimeLimitSource = { nameKo: '', nameEn: 'Peru', difficultyTier: 1 };
    const ms = timeLimitMs(country, 1, 'en'); // indexInRun=1(첫 국가 아님) — 배수 미적용 상태에서 공식만 검증
    expect(ms / 1000).toBeCloseTo(3.58, 2);
  });

  it('T5, L=15 → 7.5s — 15문자 합성 문자열로 문서 상투메 프린시페 예시의 L=15를 재현', () => {
    const country: TimeLimitSource = {
      nameKo: '',
      nameEn: 'abcdefghijklmno',
      difficultyTier: 5,
    };
    const ms = timeLimitMs(country, 1, 'en');
    expect(ms / 1000).toBeCloseTo(7.5, 2);
  });

  it('첫 국가(indexInRun=0)는 결과가 정확히 ×2', () => {
    const country: TimeLimitSource = { nameKo: '', nameEn: 'Peru', difficultyTier: 1 };
    const normal = timeLimitMs(country, 1, 'en');
    const first = timeLimitMs(country, 0, 'en');
    expect(first).toBe(normal * 2);
  });

  it('clamp 하한 3.0s: 매우 짧은 국가(L=1,T5) — 1.5+1*0.4*1.0=1.9 → 3.0으로 clamp', () => {
    const country: TimeLimitSource = { nameKo: '', nameEn: 'a', difficultyTier: 5 };
    const ms = timeLimitMs(country, 1, 'en');
    expect(ms / 1000).toBeCloseTo(3.0, 2);
  });

  it('clamp 상한 15.0s: 매우 긴 국가(L=50,T1) — 1.5+50*0.4*1.3=27.5 → 15.0으로 clamp', () => {
    const country: TimeLimitSource = {
      nameKo: '',
      nameEn: 'a'.repeat(50),
      difficultyTier: 1,
    };
    const ms = timeLimitMs(country, 1, 'en');
    expect(ms / 1000).toBeCloseTo(15.0, 2);
  });

  it('tierRelax: T1=1.30, T3=1.15, T5=1.00 (동일 L=10 기준 결과가 티어에 따라 달라짐)', () => {
    const base = (tier: 1 | 2 | 3 | 4 | 5): TimeLimitSource => ({
      nameKo: '',
      nameEn: 'kazakhstan', // L=10
      difficultyTier: tier,
    });
    const t1 = timeLimitMs(base(1), 1, 'en') / 1000; // 1.5+10*0.4*1.30=6.7
    const t3 = timeLimitMs(base(3), 1, 'en') / 1000; // 1.5+10*0.4*1.15=6.1
    const t5 = timeLimitMs(base(5), 1, 'en') / 1000; // 1.5+10*0.4*1.00=5.5
    expect(t1).toBeCloseTo(6.7, 2);
    expect(t3).toBeCloseTo(6.1, 2);
    expect(t5).toBeCloseTo(5.5, 2);
    expect(t1).toBeGreaterThan(t3);
    expect(t3).toBeGreaterThan(t5);
  });

  it('cfg 주입으로 계수를 덮어쓸 수 있다(KV config:client 핫스왑 경로)', () => {
    const country: TimeLimitSource = { nameKo: '', nameEn: 'peru', difficultyTier: 1 };
    const ms = timeLimitMs(country, 1, 'en', {
      baseSec: 0,
      perCharSec: 1,
      tierRelaxBase: 1,
      tierRelaxStep: 0,
    });
    expect(ms).toBe(4000); // L=4 × 1 × 1 = 4s, clamp(3,4,15)=4 → 4000ms
  });

  it('DEFAULT_TIME_LIMIT_CONFIG는 docs/01 §7.2 계수와 일치', () => {
    expect(DEFAULT_TIME_LIMIT_CONFIG).toEqual({
      minSec: 3.0,
      maxSec: 15.0,
      baseSec: 1.5,
      perCharSec: 0.4,
      tierRelaxBase: 1.3,
      tierRelaxStep: 0.075,
      firstCountryMultiplier: 2,
    });
  });

  it('한국어(lang=ko) 경로도 동작한다(자모 기준 L)', () => {
    const country: TimeLimitSource = { nameKo: '가나', nameEn: '', difficultyTier: 1 };
    // L=4(ㄱㅏㄴㅏ) → 1.5+4*0.4*1.30=3.58
    const ms = timeLimitMs(country, 1, 'ko');
    expect(ms / 1000).toBeCloseTo(3.58, 2);
  });

  // docs/00 §11-D27 확정: 01 §7.2 예시의 L값이 산수 오류였고(미국=5자모, 상투메프린시페=16자모),
  // 공식·자모 계상 규칙은 불변. 아래 리터럴 테스트는 D27 정정 수치를 검증한다.
  it('[D27] "미국"(T1) → L=5(ㅁㅣㄱㅜㄱ) → 4.10s(±0.01)', () => {
    const country: TimeLimitSource = { nameKo: '미국', nameEn: 'United States', difficultyTier: 1 };
    const ms = timeLimitMs(country, 1, 'ko');
    expect(ms / 1000).toBeCloseTo(4.1, 2);
  });

  it('[D27] "상투메 프린시페"(T5) → L=16 → 7.90s', () => {
    const country: TimeLimitSource = {
      nameKo: '상투메 프린시페',
      nameEn: 'Sao Tome and Principe',
      difficultyTier: 5,
    };
    const ms = timeLimitMs(country, 1, 'ko');
    expect(ms / 1000).toBeCloseTo(7.9, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11-D107 — 티어 서바이벌 전용 제한시간 계수
// ─────────────────────────────────────────────────────────────────────────────
describe('tierTimeLimitMs — 티어별 계수 (docs/00 §11-D107)', () => {
  const TIERS: DifficultyTier[] = [1, 2, 3, 4, 5];
  /** L=10(en 'kazakhstan') 고정 — 티어만 바꿔 계수 효과를 분리한다. */
  const kz = (tier: DifficultyTier): TimeLimitSource => ({
    nameKo: '',
    nameEn: 'kazakhstan',
    difficultyTier: tier,
  });

  it('계수 표가 D107 확정값과 일치', () => {
    expect(TIER_TIME_FACTOR).toEqual({ 1: 1.2, 2: 1.1, 3: 1.0, 4: 0.85, 5: 0.7 });
  });

  it('T3(계수 1.0)는 §7.2 원 수식과 완전히 동일하다', () => {
    for (const idx of [0, 1, 7]) {
      expect(tierTimeLimitMs(kz(3), idx, 'en')).toBe(timeLimitMs(kz(3), idx, 'en'));
    }
  });

  it('L=10 고정 시 티어별 결과(§7.2 tierRelax × D107 계수)', () => {
    // §7.2 원값: T1 6700 / T2 6400 / T3 6100 / T4 5800 / T5 5500 (ms)
    expect(tierTimeLimitMs(kz(1), 1, 'en')).toBe(8040); // 6700×1.2
    expect(tierTimeLimitMs(kz(2), 1, 'en')).toBe(7040); // 6400×1.1
    expect(tierTimeLimitMs(kz(3), 1, 'en')).toBe(6100); // 6100×1.0
    expect(tierTimeLimitMs(kz(4), 1, 'en')).toBe(4930); // 5800×0.85
    expect(tierTimeLimitMs(kz(5), 1, 'en')).toBe(3850); // 5500×0.7
  });

  it('티어가 올라갈수록 단조 감소한다(난이도 축 추가의 목적)', () => {
    const ms = TIERS.map((t) => tierTimeLimitMs(kz(t), 1, 'en'));
    for (let i = 1; i < ms.length; i++) expect(ms[i]!).toBeLessThan(ms[i - 1]!);
    // T5는 T1의 절반 이하 — "낯설지만 짧아서 쉬운" 상위 티어 문제를 실제로 조인다.
    expect(ms[4]!).toBeLessThan(ms[0]! * 0.5);
  });

  it('[D27 예시] "미국"(T1, ko) → 4100ms → ×1.2 = 4920ms, 첫 국가는 9840ms', () => {
    const usa: TimeLimitSource = { nameKo: '미국', nameEn: 'United States', difficultyTier: 1 };
    expect(timeLimitMs(usa, 1, 'ko')).toBe(4100);
    expect(tierTimeLimitMs(usa, 1, 'ko')).toBe(4920);
    expect(tierTimeLimitMs(usa, 0, 'ko')).toBe(9840);
    expect(tierTimeLimitMs(usa, 0, 'ko')).toBe(2 * tierTimeLimitMs(usa, 1, 'ko'));
  });

  it('경계값 — clamp 하한(3.0s) 이후 계수 적용, 재-clamp 하지 않는다', () => {
    // L=1·T5 → §7.2 raw 1.9s → clamp 3.0s(=3000ms) → ×0.7 = 2100ms.
    // 첫 국가 ×2와 동일한 규약: clamp는 §7.2 공식의 일부고, 그 뒤의 배수/계수는 clamp 밖이다.
    const tiny: TimeLimitSource = { nameKo: '', nameEn: 'a', difficultyTier: 5 };
    expect(timeLimitMs(tiny, 1, 'en')).toBe(3000);
    expect(tierTimeLimitMs(tiny, 1, 'en')).toBe(2100);
    const tinyT1: TimeLimitSource = { nameKo: '', nameEn: 'a', difficultyTier: 1 };
    expect(tierTimeLimitMs(tinyT1, 1, 'en')).toBe(3600); // 3000×1.2 — 상한도 재-clamp 없음
  });

  it('경계값 — clamp 상한(15.0s) 이후 계수 적용', () => {
    const long = (tier: DifficultyTier): TimeLimitSource => ({
      nameKo: '',
      nameEn: 'a'.repeat(50),
      difficultyTier: tier,
    });
    expect(timeLimitMs(long(1), 1, 'en')).toBe(15_000);
    expect(tierTimeLimitMs(long(1), 1, 'en')).toBe(18_000); // 15000×1.2
    expect(tierTimeLimitMs(long(5), 1, 'en')).toBe(10_500); // 15000×0.7
  });

  it('반올림 — 항상 정수 ms이고 base×factor의 최근접 정수다(부동소수 잔차 제거)', () => {
    for (const tier of TIERS) {
      for (let len = 1; len <= 40; len++) {
        for (const idx of [0, 1]) {
          const c: TimeLimitSource = { nameKo: '', nameEn: 'a'.repeat(len), difficultyTier: tier };
          const base = timeLimitMs(c, idx, 'en');
          const got = tierTimeLimitMs(c, idx, 'en');
          expect(Number.isInteger(got)).toBe(true);
          expect(Math.abs(got - base * TIER_TIME_FACTOR[tier])).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('cfg(KV config:client 핫스왑)는 계수 적용 전 §7.2 계수에 그대로 전달된다', () => {
    const c: TimeLimitSource = { nameKo: '', nameEn: 'peru', difficultyTier: 4 };
    // L=4 × 1 × 1 = 4s → clamp(3,4,15)=4s=4000ms → ×0.85 = 3400ms
    expect(
      tierTimeLimitMs(c, 1, 'en', { baseSec: 0, perCharSec: 1, tierRelaxBase: 1, tierRelaxStep: 0 }),
    ).toBe(3400);
  });

  it('ko 경로도 동일 계수(언어별 L_i는 §7.2가 이미 처리)', () => {
    const c: TimeLimitSource = { nameKo: '가나', nameEn: '', difficultyTier: 5 };
    const base = timeLimitMs(c, 1, 'ko');
    expect(tierTimeLimitMs(c, 1, 'ko')).toBe(Math.round(base * 0.7));
  });
});
