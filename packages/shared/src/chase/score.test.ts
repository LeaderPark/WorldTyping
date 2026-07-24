// spec: docs/09 §3.6(점수 모델)·§12(테스트 표), docs/00 §11-D92(등급 예외)·D94(미배송 50%)
//
// 골든 벡터 5세트는 손계산 과정을 각 테스트 주석에 병기한다(node -e로 부동소수 결과를 사전 검증 —
// cpm/pi/finalScore는 Math.floor/Math.round를 거치는 정수이므로 toBe로, 중간 실수값(typingScore 등)은
// toBeCloseTo로 비교한다(기존 scoring/score.test.ts 골든 벡터와 동일 관례).
import { describe, expect, it } from 'vitest';
import type { DifficultyTier } from '../types/country';
import type { ScoreCountry } from '../scoring/score';
import { DEFAULT_CHASE_CONSTANTS, mergeChaseConstants } from './constants';
import type { ChaseEvent, ChaseState } from './simulate';
import { computeChaseScore, gradeChase, type ChaseCountryLookup, type ChaseTypingStats } from './score';

function country(nameKo: string, nameEn: string, difficultyTier: DifficultyTier): ScoreCountry {
  return { nameKo, nameEn, difficultyTier };
}

// requiredKeystrokes(en) = normalizeEn(nameEn).length(공백/구두점 제거, 소문자):
//   Japan→5, South Korea→10("southkorea"), Mongolia→8, China→5, Egypt→5, Brazil→6.
// baseScoreTerm = (60+8×L)×(1+0.15×(tier−1)):
//   KR(t1,L10)=140.0   JP(t1,L5)=100.0   MN(t2,L8)=(60+64)*1.15=142.6
//   CN(t2,L5)=(60+40)*1.15=115.0   EG(t2,L5)=115.0   BR(t1,L6)=108.0
const COUNTRIES: ChaseCountryLookup = {
  KR: country('대한민국', 'South Korea', 1),
  JP: country('일본', 'Japan', 1),
  MN: country('몽골', 'Mongolia', 2),
  CN: country('중국', 'China', 2),
  EG: country('이집트', 'Egypt', 2),
  BR: country('브라질', 'Brazil', 1),
};

/** ChaseState 최소 유효 스냅샷 — 필요한 필드만 override. */
function baseState(overrides: Partial<ChaseState> & Pick<ChaseState, 'visited' | 'events' | 'timeMs'>): ChaseState {
  return {
    home: 'KR',
    player: overrides.visited[overrides.visited.length - 1]!,
    stars: 0,
    police: [],
    golds: [],
    carried: [],
    arrestedAtMs: null,
    hopsProcessed: overrides.visited.length - 1,
    candidates: [],
    wantedStartMs: null,
    nextStarUpMs: null,
    lastPoliceCloseMs: -1,
    lastEscapeMs: -1,
    nextPoliceId: 1,
    rngCandidates: { seed: 0, draws: 0 },
    rngGold: { seed: 0, draws: 0 },
    rngPolice: { seed: 0, draws: 0 },
    ...overrides,
  };
}

describe('computeChaseScore — 골든 벡터 5세트(docs/09 §3.6·§12)', () => {
  // (a) 짧은 도주 → 배송 1회(×1.0) → 낮은 압박에서 자수. TypingScore=JP(100)+KR(140)=240,
  // GoldScore=배송 400(1개×1.0)+미배송 0=400, SurvivalScore=0(수배 발령 전).
  // cpm=floor(20*60000/6000)=200, acc=1, pi=floor(200*1*1)=200(→C: 120≤pi<230), comboFactor=1.05.
  // finalScore=round(240*1*1.05+400+0)=round(252+400)=652.
  it('(a) 배송 1회·저압박 자수', () => {
    const events: ChaseEvent[] = [
      { type: 'goldPicked', tMs: 1000, at: 'JP', ring: 'near', value: 400 },
      { type: 'delivered', tMs: 3000, count: 1, payout: 400, starsAfter: 0 },
    ];
    const state = baseState({ visited: ['KR', 'JP', 'KR'], events, timeMs: 6000, carried: [] });
    const stats: ChaseTypingStats = { totalKeystrokes: 20, correctKeystrokes: 20, elapsedMs: 6000, maxCombo: 5 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.cpm).toBe(200);
    expect(r.acc).toBe(1);
    expect(r.pi).toBe(200);
    expect(r.grade).toBe('C');
    expect(r.delivered).toBe(1);
    expect(r.typingScore).toBeCloseTo(240, 6);
    expect(r.goldScore).toBeCloseTo(400, 6);
    expect(r.survivalScore).toBeCloseTo(0, 6);
    expect(r.accFactor).toBeCloseTo(1, 9);
    expect(r.comboFactor).toBeCloseTo(1.05, 9);
    expect(r.finalScore).toBe(652);
  });

  // (b) 고압박 순수 도주(배송 0회) → 체포. TypingScore=MN(142.6). GoldScore=미배송 1200×0.5=600
  // (배송 0). SurvivalScore: [0,1000)★0→0 / [1000,5000)★1×4s×2=8 / [5000,8000)★2×3s×4=12 → 20.
  // cpm=floor(95*60000/8000)=712, acc=0.95, pi=floor(712*0.95²)=642(→raw S, 450컷) but delivered=0
  // → D92: S를 A로 강등. comboFactor=1+0.01*10=1.10.
  // finalScore=round(142.6*0.9025*1.10+600+20)=round(141.56615+620)=762.
  it('(b) 순수 도주(배송 0)·체포 — raw S가 D92로 A 강등', () => {
    const events: ChaseEvent[] = [
      { type: 'goldPicked', tMs: 500, at: 'MN', ring: 'far', value: 1200 },
      { type: 'starChanged', tMs: 1000, from: 0, to: 1, direction: 'up', reason: 'issued' },
      { type: 'starChanged', tMs: 5000, from: 1, to: 2, direction: 'up', reason: 'interval' },
      { type: 'arrested', tMs: 8000, by: 'chaser', at: 'MN' },
    ];
    const state = baseState({
      visited: ['KR', 'MN'],
      events,
      timeMs: 8000,
      carried: [{ value: 1200, ring: 'far' }],
      arrestedAtMs: 8000,
      stars: 2,
    });
    const stats: ChaseTypingStats = { totalKeystrokes: 100, correctKeystrokes: 95, elapsedMs: 8000, maxCombo: 10 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.cpm).toBe(712);
    expect(r.acc).toBeCloseTo(0.95, 9);
    expect(r.pi).toBe(642);
    expect(r.delivered).toBe(0);
    expect(r.grade).toBe('A'); // raw gradeFromPI(642)='S', D92가 배송0이라 A로 강등
    expect(r.typingScore).toBeCloseTo(142.6, 6);
    expect(r.goldScore).toBeCloseTo(600, 6);
    expect(r.survivalScore).toBeCloseTo(20, 6);
    expect(r.finalScore).toBe(762);
  });

  // (c) 몰아 배송 2개(×1.25) → 중간 압박에서 자수(resign, arrestedAtMs=null). TypingScore=
  // CN(115)+KR(140)=255. 배송 payout=(700+700)*(1+0.25*1)=1750(이미 계산된 값을 이벤트에 실음).
  // SurvivalScore: [0,2000)★0→0 / [2000,9000)★1×7s×2=14 → 14. 잡음 이벤트(goldSpawned/
  // policeMoved)는 score.ts가 무시함을 함께 검증.
  // cpm=floor(45*60000/9000)=300, acc=0.9, pi=floor(300*0.81)=243(→B: 230≤pi<340).
  // finalScore=round(255*0.81*1.08+1750+14)=round(223.074+1764)=1987.
  it('(c) 몰아 배송 2개(×1.25)·자수 종료·무관 이벤트 무시', () => {
    const events: ChaseEvent[] = [
      { type: 'goldSpawned', tMs: 200, at: 'BR', ring: 'near', value: 400 }, // score.ts와 무관 — 무시돼야 함
      { type: 'starChanged', tMs: 2000, from: 0, to: 1, direction: 'up', reason: 'issued' },
      { type: 'policeMoved', tMs: 2500, id: 1, from: 'JP', to: 'CN' }, // score.ts와 무관 — 무시돼야 함
      { type: 'delivered', tMs: 6000, count: 2, payout: 1750, starsAfter: 1 },
    ];
    const state = baseState({ visited: ['KR', 'CN', 'KR'], events, timeMs: 9000, carried: [], stars: 1 });
    const stats: ChaseTypingStats = { totalKeystrokes: 50, correctKeystrokes: 45, elapsedMs: 9000, maxCombo: 8 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.cpm).toBe(300);
    expect(r.acc).toBeCloseTo(0.9, 9);
    expect(r.pi).toBe(243);
    expect(r.grade).toBe('B');
    expect(r.delivered).toBe(1); // 배송 "횟수"(이벤트 수) — 이 배송의 개수(count=2)와는 별개
    expect(r.typingScore).toBeCloseTo(255, 6);
    expect(r.goldScore).toBeCloseTo(1750, 6);
    expect(r.survivalScore).toBeCloseTo(14, 6);
    expect(r.finalScore).toBe(1987);
  });

  // (d) 별 상승→도주감소 하락 왕복 + 콤보 상한(40) 적용 + 미배송 50%. TypingScore=BR(108).
  // GoldScore=0(배송)+1200×0.5=600(배송 0). SurvivalScore: [0,1000)★0→0 / [1000,3000)★1×2s×2=4 /
  // [3000,5000)★2×2s×4=8 / [5000,7000)★1(하락 후)×2s×2=4 → 16.
  // cpm=floor(190*60000/7000)=1628, acc=0.95, pi=floor(1628*0.9025)=1469(≫450→raw S, D92로 A).
  // comboFactor=1+0.01*min(57,40)=1.4(40 상한 적용 확인).
  // finalScore=round(108*0.9025*1.4+600+16)=round(136.458+616)=752.
  it('(d) 별 상승·하락 왕복 + 콤보 상한(40) + 미배송 50% + 체포(배송 0)', () => {
    const events: ChaseEvent[] = [
      { type: 'candidatesShown', tMs: 0, hopIndex: 0, candidates: ['BR', 'EG', 'MN'] }, // score.ts와 무관
      { type: 'starChanged', tMs: 1000, from: 0, to: 1, direction: 'up', reason: 'issued' },
      { type: 'starChanged', tMs: 3000, from: 1, to: 2, direction: 'up', reason: 'interval' },
      { type: 'starChanged', tMs: 5000, from: 2, to: 1, direction: 'down', reason: 'escape' },
      { type: 'arrested', tMs: 7000, by: 'heli', at: 'BR' },
    ];
    const state = baseState({
      visited: ['KR', 'BR'],
      events,
      timeMs: 7000,
      carried: [{ value: 1200, ring: 'far' }],
      arrestedAtMs: 7000,
      stars: 1,
    });
    const stats: ChaseTypingStats = { totalKeystrokes: 200, correctKeystrokes: 190, elapsedMs: 7000, maxCombo: 57 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.cpm).toBe(1628);
    expect(r.pi).toBe(1469);
    expect(r.delivered).toBe(0);
    expect(r.grade).toBe('A');
    expect(r.typingScore).toBeCloseTo(108, 6);
    expect(r.goldScore).toBeCloseTo(600, 6);
    expect(r.survivalScore).toBeCloseTo(16, 6);
    expect(r.comboFactor).toBeCloseTo(1.4, 9);
    expect(r.finalScore).toBe(752);
  });

  // (e) cfg(등급 컷 오버라이드) 주입이 grade에 반영됨을 확인(computeScore의 기존 계약과 동일 —
  // 배송 0이지만 raw grade가 애초에 'A'라 D92 캡과는 무관, cfg 플러밍 자체만 검증).
  // TypingScore=EG(115). GoldScore=0, SurvivalScore=0(수배 미발령).
  // cpm=floor(10*60000/1500)=400, acc=1, pi=400(기본 컷 A=340→raw 'A').
  // finalScore=round(115*1*1.03+0+0)=round(118.45)=118(cfg 무관 — cfg는 등급 컷에만 영향).
  it('(e) 등급 컷 cfg 오버라이드 반영(finalScore는 불변, grade만 변화)', () => {
    const state = baseState({ visited: ['KR', 'EG'], events: [], timeMs: 1500, carried: [] });
    const stats: ChaseTypingStats = { totalKeystrokes: 10, correctKeystrokes: 10, elapsedMs: 1500, maxCombo: 3 };
    const rDefault = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(rDefault.pi).toBe(400);
    expect(rDefault.delivered).toBe(0);
    expect(rDefault.grade).toBe('A'); // raw A(배송 0이어도 A는 D92 캡 대상 아님)
    expect(rDefault.finalScore).toBe(118);

    const rCustom = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS, {
      grade: { S: 501, A: 401, B: 230, C: 120 },
    });
    expect(rCustom.grade).toBe('B'); // 400 < 401(커스텀 A컷) → B
    expect(rCustom.finalScore).toBe(118); // cfg는 grade 컷에만 영향, finalScore는 불변
  });
});

describe('computeChaseScore — 배송 콤보 배수 경계값(1/2/4개 → ×1.0/×1.25/×1.75, D94)', () => {
  it('배송 payout은 이미 §3.5 배수식이 적용된 이벤트값을 그대로 합산한다(재계산 없음)', () => {
    // 재사용 원칙: score.ts는 haulStep을 재계산하지 않고 이벤트의 payout을 신뢰한다.
    // 1개: 400*(1+0.25*0)=400(×1.0) / 2개: (400*2)*(1+0.25*1)=1000(×1.25) / 4개: (400*4)*(1+0.25*3)=2800(×1.75)
    const events: ChaseEvent[] = [
      { type: 'delivered', tMs: 1000, count: 1, payout: 400, starsAfter: 0 },
      { type: 'delivered', tMs: 2000, count: 2, payout: 1000, starsAfter: 0 },
      { type: 'delivered', tMs: 3000, count: 4, payout: 2800, starsAfter: 0 },
    ];
    const state = baseState({ visited: ['KR'], events, timeMs: 5000, carried: [] });
    // totalKeystrokes=0 → acc=0 → accFactor=0 → typingScore 항이 통째로 0이 되어 goldScore만 남는다(isolation).
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.goldScore).toBeCloseTo(400 + 1000 + 2800, 6); // = 4200
    expect(r.delivered).toBe(3);
    expect(r.survivalScore).toBeCloseTo(0, 6);
    expect(r.finalScore).toBe(4200);
  });
});

describe('computeChaseScore — 체포 시 미배송 금 50%(D94)', () => {
  it('carried 잔량은 가치의 unbankedOnArrestFactor(기본 0.5)만 가산', () => {
    const state = baseState({
      visited: ['KR'],
      events: [],
      timeMs: 5000,
      carried: [
        { value: 1000, ring: 'mid' },
        { value: 2000, ring: 'far' },
      ],
    });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.goldScore).toBeCloseTo((1000 + 2000) * 0.5, 6); // = 1500
    expect(r.delivered).toBe(0);
    expect(r.finalScore).toBe(1500);
  });

  it('KV config:chase로 unbankedOnArrestFactor를 오버라이드하면 그 값이 실제로 반영된다(하드코딩 아님)', () => {
    const constants = mergeChaseConstants({ score: { unbankedOnArrestFactor: 0.25 } });
    const state = baseState({ visited: ['KR'], events: [], timeMs: 1000, carried: [{ value: 1000, ring: 'mid' }] });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', constants);
    expect(r.goldScore).toBeCloseTo(250, 6); // 1000×0.25
  });
});

describe('computeChaseScore — SurvivalScore 별단계 가중(Σ_{s=1..5} 생존초×2s, §3.6)', () => {
  it('★1~★5 각 1초씩 생존 시 2+4+6+8+10=30점', () => {
    // ★1 1초=2점 / ★2 1초=4점 / ★3 1초=6점 / ★4 1초=8점 / ★5 1초=10점(스펙 주석 그대로).
    const events: ChaseEvent[] = [
      { type: 'starChanged', tMs: 1000, from: 0, to: 1, direction: 'up', reason: 'issued' },
      { type: 'starChanged', tMs: 2000, from: 1, to: 2, direction: 'up', reason: 'interval' },
      { type: 'starChanged', tMs: 3000, from: 2, to: 3, direction: 'up', reason: 'interval' },
      { type: 'starChanged', tMs: 4000, from: 3, to: 4, direction: 'up', reason: 'interval' },
      { type: 'starChanged', tMs: 5000, from: 4, to: 5, direction: 'up', reason: 'interval' },
    ];
    const state = baseState({ visited: ['KR'], events, timeMs: 6000, carried: [], stars: 5 });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.survivalScore).toBeCloseTo(30, 6);
    expect(r.finalScore).toBe(30);
  });

  it('★0 구간은 기여 0(공식은 s=1..5만 합산)', () => {
    const state = baseState({ visited: ['KR'], events: [], timeMs: 10_000, carried: [] });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.survivalScore).toBe(0);
  });

  it('KV config:chase로 survivalStarMultiplier를 오버라이드하면 그 값이 실제로 반영된다', () => {
    const constants = mergeChaseConstants({ score: { survivalStarMultiplier: 4 } });
    const events: ChaseEvent[] = [{ type: 'starChanged', tMs: 0, from: 0, to: 1, direction: 'up', reason: 'issued' }];
    const state = baseState({ visited: ['KR'], events, timeMs: 1000, carried: [], stars: 1 });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', constants);
    expect(r.survivalScore).toBeCloseTo(4, 6); // 1초 × 4(mult) × 1(★) = 4 (기본값이면 2)
  });
});

describe('gradeChase — D92 S/A 등급 배송조건 경계(배송0→A캡, 배송1→S가능)', () => {
  it('raw S(pi≥450)는 delivered=0이면 A로 강등, delivered≥1이면 S 그대로', () => {
    expect(gradeChase(500, 0)).toBe('A');
    expect(gradeChase(500, 1)).toBe('S');
    expect(gradeChase(450, 0)).toBe('A'); // 컷 경계값에서도 동일 적용
    expect(gradeChase(450, 1)).toBe('S');
  });

  it('raw A/B/C/D는 배송 여부와 무관하게 그대로(캡은 S에만 적용)', () => {
    expect(gradeChase(449, 0)).toBe('A');
    expect(gradeChase(449, 1)).toBe('A');
    expect(gradeChase(230, 0)).toBe('B');
    expect(gradeChase(119, 0)).toBe('D');
  });

  it('cfg 오버라이드 컷을 사용한다', () => {
    expect(gradeChase(100, 0, { S: 100, A: 90, B: 80, C: 70 })).toBe('A'); // raw S(100≥100컷) → 배송0 → A
    expect(gradeChase(100, 1, { S: 100, A: 90, B: 80, C: 70 })).toBe('S');
  });

  it('computeChaseScore 전체 파이프라인에서도 delivered 유무에 따라 grade가 갈린다(pi 동일)', () => {
    const stats: ChaseTypingStats = { totalKeystrokes: 100, correctKeystrokes: 95, elapsedMs: 8000, maxCombo: 10 };
    const withoutDelivery = baseState({
      visited: ['KR', 'MN'],
      events: [{ type: 'arrested', tMs: 8000, by: 'chaser', at: 'MN' }],
      timeMs: 8000,
      arrestedAtMs: 8000,
    });
    const withDelivery = baseState({
      visited: ['KR', 'MN'],
      events: [
        { type: 'delivered', tMs: 4000, count: 1, payout: 1, starsAfter: 0 },
        { type: 'arrested', tMs: 8000, by: 'chaser', at: 'MN' },
      ],
      timeMs: 8000,
      arrestedAtMs: 8000,
    });
    const rWithout = computeChaseScore(withoutDelivery, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    const rWith = computeChaseScore(withDelivery, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(rWithout.pi).toBe(rWith.pi); // 동일 타이핑 통계 → 동일 pi
    expect(rWithout.pi).toBeGreaterThanOrEqual(450); // raw grade가 S에 해당함을 전제로 확인
    expect(rWithout.grade).toBe('A'); // 배송 0 → 강등
    expect(rWith.grade).toBe('S'); // 배송 1 → 그대로
  });
});

describe('computeChaseScore — 계약 위반 방어', () => {
  it('countryLookup에 방문국이 없으면 throw(계약 위반 조기 검출)', () => {
    const state = baseState({ visited: ['KR', 'ZZ'], events: [], timeMs: 1000 });
    const stats: ChaseTypingStats = { totalKeystrokes: 1, correctKeystrokes: 1, elapsedMs: 100, maxCombo: 1 };
    expect(() => computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS)).toThrow(
      /countryLookup/,
    );
  });

  it('홉이 없으면(홈에서 즉시 종료) typingScore=0', () => {
    const state = baseState({ visited: ['KR'], events: [], timeMs: 0 });
    const stats: ChaseTypingStats = { totalKeystrokes: 0, correctKeystrokes: 0, elapsedMs: 0, maxCombo: 0 };
    const r = computeChaseScore(state, COUNTRIES, stats, 'en', DEFAULT_CHASE_CONSTANTS);
    expect(r.typingScore).toBe(0);
    expect(r.cpm).toBe(0); // elapsedMs<=0 가드
    expect(r.acc).toBe(0); // totalKeystrokes<=0 가드
  });
});
