// spec: docs/01 §7.2(서바이벌 국가당 제한시간 수식), WT-M1-02 acceptance
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_CONFIG, timeLimitMs, type TimeLimitSource } from './time-limit';

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
