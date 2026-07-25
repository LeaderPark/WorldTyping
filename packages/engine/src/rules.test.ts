// spec: docs/01 §7.1 모드별 규칙 매트릭스, docs/03 §5.2 ModeRules, docs/07 WT-M2-02 지시 4·완료조건.
// 규칙 5종의 lives/timeLimitMs(첫 국가 ×2)/hardCapMs/checkpoints/onSkip(라이프 정책)을 매트릭스 1:1로 검증.
import { describe, expect, it } from 'vitest';
import {
  timeLimitMs as sharedTimeLimitMs,
  tierTimeLimitMs as sharedTierTimeLimitMs,
  type Country,
} from '@wt/shared';
import {
  continentRules,
  createModeRules,
  dailyRules,
  raceRules,
  tierRules,
  worldtourRules,
  type MutableRunState,
} from './rules';

function mkCountry(over: Partial<Country>): Country {
  return {
    id: 'XX',
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
    ...over,
  };
}

// docs/00 §11-D27: "미국" L_ko = 5(ㅁㅣㄱㅜㄱ), T1 → 4.10s = 4100ms(비-첫국가), 첫 국가 ×2 = 8200ms.
const USA = mkCountry({ id: 'US', nameKo: '미국', nameEn: 'United States', difficultyTier: 1 });

describe('continentRules (docs/01 §7.1 대륙별: 라이프·제한·하드캡 전무)', () => {
  const r = continentRules();
  it('id/lives/timeLimit/hardCap/checkpoints', () => {
    expect(r.id).toBe('continent');
    expect(r.lives).toBeNull();
    expect(r.timeLimitMs(USA, 0)).toBeNull();
    expect(r.timeLimitMs(USA, 3)).toBeNull();
    expect(r.hardCapMs).toBeNull();
    expect(r.checkpoints).toBeUndefined();
  });
  it('onSkip은 라이프를 건드리지 않는다(§5.5 공통 페널티는 엔진 소관)', () => {
    const s: MutableRunState = { lives: null };
    r.onSkip(s);
    expect(s.lives).toBeNull();
  });
});

describe('tierRules (docs/01 §7.1 티어별: 서바이벌, 라이프 3, 제한시간 §7.2)', () => {
  const r = tierRules('ko');
  it('id/lives/hardCap/checkpoints', () => {
    expect(r.id).toBe('tier');
    expect(r.lives).toBe(3);
    expect(r.hardCapMs).toBeNull();
    expect(r.checkpoints).toBeUndefined();
  });
  it('제한시간은 @wt/shared 수식 위임 + 첫 국가 ×2 + 티어 계수(§11-D107)', () => {
    // §7.2 원값 4100ms × TIER_TIME_FACTOR[1]=1.2 = 4920ms(티어 모드 전용 계수).
    expect(r.timeLimitMs(USA, 1)).toBe(4920);
    expect(r.timeLimitMs(USA, 0)).toBe(9840); // 첫 국가 ×2
    expect(r.timeLimitMs(USA, 0)).toBe(2 * r.timeLimitMs(USA, 1)!);
    expect(r.timeLimitMs(USA, 2)).toBe(sharedTierTimeLimitMs(USA, 2, 'ko'));
  });
  it('en 바인딩도 각자 lang으로 계산', () => {
    const en = tierRules('en');
    expect(en.timeLimitMs(USA, 1)).toBe(sharedTierTimeLimitMs(USA, 1, 'en'));
  });
  it('[§11-D107] 계수는 티어 모드에만 — 같은 국가라도 daily와 값이 갈린다', () => {
    const T5 = mkCountry({ id: 'ST', nameKo: '상투메 프린시페', difficultyTier: 5 });
    expect(tierRules('ko').timeLimitMs(T5, 1)).toBe(
      Math.round(sharedTimeLimitMs(T5, 1, 'ko') * 0.7),
    );
    expect(dailyRules('ko').timeLimitMs(T5, 1)).toBe(sharedTimeLimitMs(T5, 1, 'ko'));
    expect(tierRules('ko').timeLimitMs(T5, 1)).toBeLessThan(dailyRules('ko').timeLimitMs(T5, 1)!);
  });
  it('onSkip → 라이프 −1', () => {
    const s: MutableRunState = { lives: 3 };
    r.onSkip(s);
    expect(s.lives).toBe(2);
  });
});

describe('worldtourRules (docs/01 §7.1 세계일주 + docs/00 §11-D2 체크포인트)', () => {
  const r = worldtourRules();
  it('id/lives/timeLimit/hardCap/checkpoints [10,20,30,40]', () => {
    expect(r.id).toBe('worldtour');
    expect(r.lives).toBe(3);
    expect(r.timeLimitMs(USA, 0)).toBeNull();
    expect(r.hardCapMs).toBeNull();
    expect(r.checkpoints).toEqual([10, 20, 30, 40]);
  });
  it('onSkip → 라이프 −1', () => {
    const s: MutableRunState = { lives: 3 };
    r.onSkip(s);
    expect(s.lives).toBe(2);
  });
});

describe('dailyRules (docs/01 §7.1 데일리: 서바이벌 변형, 라이프 1)', () => {
  const r = dailyRules('ko');
  it('id/lives/timeLimit/hardCap', () => {
    expect(r.id).toBe('daily');
    expect(r.lives).toBe(1);
    expect(r.timeLimitMs(USA, 1)).toBe(4100);
    expect(r.timeLimitMs(USA, 0)).toBe(8200);
    expect(r.hardCapMs).toBeNull();
  });
  it('onSkip → 라이프 −1 (라이프 1이면 0 → 엔진에서 즉시 종료)', () => {
    const s: MutableRunState = { lives: 1 };
    r.onSkip(s);
    expect(s.lives).toBe(0);
  });
});

describe('raceRules (docs/01 §7.1 멀티 레이스: 10초 고정, 180초 하드캡, 라이프 없음)', () => {
  const r = raceRules();
  it('id/lives/timeLimit 10초 고정/hardCap 180초', () => {
    expect(r.id).toBe('race');
    expect(r.lives).toBeNull();
    expect(r.timeLimitMs(USA, 0)).toBe(10_000);
    expect(r.timeLimitMs(USA, 7)).toBe(10_000); // index 무관 고정
    expect(r.hardCapMs).toBe(180_000);
    expect(r.checkpoints).toBeUndefined();
  });
  it('onSkip은 라이프를 건드리지 않는다', () => {
    const s: MutableRunState = { lives: null };
    r.onSkip(s);
    expect(s.lives).toBeNull();
  });
});

describe('createModeRules 팩토리', () => {
  it('모든 GameMode → 올바른 id', () => {
    expect(createModeRules('continent', 'ko').id).toBe('continent');
    expect(createModeRules('tier', 'ko').id).toBe('tier');
    expect(createModeRules('worldtour', 'ko').id).toBe('worldtour');
    expect(createModeRules('daily', 'ko').id).toBe('daily');
    expect(createModeRules('race', 'en').id).toBe('race');
  });
  it('tier/daily는 lang 바인딩을 반영', () => {
    expect(createModeRules('tier', 'en').timeLimitMs(USA, 1)).toBe(
      sharedTierTimeLimitMs(USA, 1, 'en'),
    );
    expect(createModeRules('daily', 'en').timeLimitMs(USA, 1)).toBe(
      sharedTimeLimitMs(USA, 1, 'en'),
    );
  });
});
