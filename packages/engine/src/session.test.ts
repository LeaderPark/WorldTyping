// spec: docs/03 §5(FSM·EngineEvent·EngineDeps·ModeRules), docs/01 §5.5(스킵)·§6.1(콤보)·§7.1(매트릭스),
//       §3.3 + docs/00 §11-D2(세계일주 체크포인트 10/20/30/40 + 종착 50), docs/07 WT-M2-02 지시 7·완료조건.
//
// 전부 가상 시계(VirtualClock)로 구동한다 — deps.now()/deps.schedule() 주입만 사용(Date.now 직접 호출 없음).
import { describe, expect, it } from 'vitest';
import type { Country } from '@wt/shared';
import {
  GameSessionEngine,
  COUNTDOWN_MS,
  RETRY_COUNTDOWN_MS,
  STATS_TICK_MS,
  type EngineDeps,
  type EngineEvent,
} from './session';
import type { TypingEvent } from './input-controller';
import type { KeystrokeDelta } from './accountant';
import type { MatchDetail } from '@wt/shared';
import { continentRules, dailyRules, raceRules, tierRules, worldtourRules, type ModeRules } from './rules';
import { RunLog, RUN_LOG_CAPACITY, type InputDigest } from './replay';

// ── 가상 시계 ────────────────────────────────────────────────────────────
interface Timer {
  due: number;
  cb: () => void;
  cancelled: boolean;
  seq: number;
}

class VirtualClock {
  nowMs = 0;
  private timers: Timer[] = [];
  private seq = 0;

  now = (): number => this.nowMs;

  schedule = (cb: () => void, ms: number): (() => void) => {
    const t: Timer = { due: this.nowMs + ms, cb, cancelled: false, seq: this.seq++ };
    this.timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };

  /** deltaMs만큼 시간을 전진시키며 만기 타이머를 시간순(동시각은 등록순)으로 실행한다. */
  advance(deltaMs: number): void {
    const target = this.nowMs + deltaMs;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.cancelled || t.due > target) continue;
        if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      this.nowMs = next.due;
      this.timers = this.timers.filter((t) => t !== next);
      next.cb(); // 새 타이머를 등록할 수 있음(statsTick 재스케줄 등)
    }
    this.nowMs = target;
  }
}

// ── 픽스처 ───────────────────────────────────────────────────────────────
function mkCountry(over: Partial<Country>): Country {
  return {
    id: 'XX',
    iso3: 'XXX',
    nameKo: '가나', // L_ko = ㄱㅏㄴㅏ = 4
    nameEn: 'Ghana',
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
    acceptedInputsKo: ['가나'],
    acceptedInputsEn: ['ghana'],
    ...over,
  };
}

/** 국가 n개(id = C0..C(n-1), nameKo='가나', L_ko=4). */
function countries(n: number): Country[] {
  return Array.from({ length: n }, (_, i) => mkCountry({ id: `C${i}` }));
}

const DUMMY_DETAIL: MatchDetail = {
  state: 'EXACT',
  bestTarget: { display: '', key: '' },
  matchedLen: 0,
  inputLen: 0,
};

function delta(added: number, correct: number): KeystrokeDelta {
  return { added, removed: 0, addedCorrect: correct, addedError: added - correct };
}

function exact(added = 4, correct = added): TypingEvent {
  return { type: 'exact', detail: DUMMY_DETAIL, delta: delta(added, correct), elapsedFromShownMs: 0 };
}
function progress(added: number, correct = added): TypingEvent {
  return { type: 'progress', detail: DUMMY_DETAIL, delta: delta(added, correct), rawValue: '' };
}
function miss(added: number, correct: number): TypingEvent {
  return { type: 'miss', detail: DUMMY_DETAIL, delta: delta(added, correct) };
}

interface Harness {
  eng: GameSessionEngine;
  clock: VirtualClock;
  events: EngineEvent[];
}

function makeEngine(rules: ModeRules, cs: Country[], lang: 'ko' | 'en' = 'ko'): Harness {
  const clock = new VirtualClock();
  const deps: EngineDeps = { now: clock.now, schedule: clock.schedule, rules };
  const eng = new GameSessionEngine(deps, cs, lang);
  const events: EngineEvent[] = [];
  eng.subscribe((e) => events.push(e));
  return { eng, clock, events };
}

/** start() → 카운트다운 완료 → playing 진입까지. */
function startPlaying(h: Harness, countdownMs = COUNTDOWN_MS): void {
  h.eng.start();
  h.clock.advance(countdownMs);
}

const phases = (events: EngineEvent[]): string[] =>
  events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
const lifeSeq = (events: EngineEvent[]): number[] =>
  events.filter((e) => e.type === 'lifeChanged').map((e) => (e as { lives: number }).lives);
const comboSeq = (events: EngineEvent[]): number[] =>
  events.filter((e) => e.type === 'comboChanged').map((e) => (e as { combo: number }).combo);
function finishedEvent(events: EngineEvent[]) {
  const e = events.find((x) => x.type === 'finished');
  if (!e || e.type !== 'finished') throw new Error('finished 이벤트 없음');
  return e.result;
}

// ── FSM / 해피패스 ─────────────────────────────────────────────────────────
describe('FSM 전이 + 대륙 완주 (docs/03 §5.1)', () => {
  it('idle→countdown→playing→finished, 국가 확정마다 콤보 +1', () => {
    const h = makeEngine(continentRules(), countries(3));
    expect(h.eng.getSnapshot().phase).toBe('idle');

    h.eng.start();
    expect(h.eng.getSnapshot().phase).toBe('countdown');
    expect(h.eng.getSnapshot().countdownEndsAt).toBe(COUNTDOWN_MS);

    h.clock.advance(COUNTDOWN_MS); // 카운트다운 종료 → playing
    expect(h.eng.getSnapshot().phase).toBe('playing');
    expect(h.eng.getSnapshot().currentIndex).toBe(0);

    // 3개국을 시간 경과와 함께 클리어(lastCommitAt > playingStartedAt 경로)
    for (let i = 0; i < 3; i++) {
      h.clock.advance(1000);
      h.eng.handleInput(exact(4));
    }

    expect(phases(h.events)).toEqual(['countdown', 'playing', 'finished']);
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('completed');
    expect(r.score.completed).toBe(true);
    expect(r.stats.countriesCleared).toBe(3);
    expect(r.stats.totalKeystrokes).toBe(12);
    expect(r.stats.correctKeystrokes).toBe(12);
    expect(r.stats.maxCombo).toBe(3);
    expect(comboSeq(h.events)).toEqual([1, 2, 3]);
    expect(r.stats.elapsedMs).toBe(3000); // 마지막 확정 시각(3×1000) 기준
  });

  it('시간 경과 없이 즉시 완주하면 elapsedMs=0 (finishRun else 분기)', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.handleInput(exact(4));
    h.eng.handleInput(exact(4));
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('completed');
    expect(r.stats.elapsedMs).toBe(0);
    expect(r.score.cpm).toBe(0);
  });

  it('start()는 playing/countdown 중이면 무시된다', () => {
    const h = makeEngine(continentRules(), countries(2));
    h.eng.start();
    h.eng.start(); // 무시
    expect(phases(h.events)).toEqual(['countdown']);
  });

  it('subscribe가 반환한 해지 함수는 이후 이벤트 수신을 끊는다', () => {
    const h = makeEngine(continentRules(), countries(2));
    const seen: string[] = [];
    const off = h.eng.subscribe((e) => seen.push(e.type));
    h.eng.start(); // 'phase' 수신
    off();
    h.clock.advance(COUNTDOWN_MS); // playing 전이 — 이미 해지되어 미수신
    expect(seen).toEqual(['phase']);
  });
});

// ── 콤보 리셋 타이밍 (docs/01 §6.1) ────────────────────────────────────────
describe('콤보: 오타 발생 국가는 "확정 시점"에 0 (확정 전 표시 유지)', () => {
  it('클린 국가 → +1, 오타 국가 → miss 시점엔 유지, 확정 시 0', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);

    // 국가0: 클린 → 콤보 1
    h.eng.handleInput(exact(4));
    expect(comboSeq(h.events)).toEqual([1]);

    // 국가1: 오타(miss) — 이 시점엔 콤보 이벤트 없음(표시 유지)
    h.eng.handleInput(miss(1, 0));
    expect(comboSeq(h.events)).toEqual([1]); // 여전히 1
    expect(h.eng.getSnapshot().combo).toBe(1);

    // 국가1 확정 → 오타 있었으므로 0
    h.eng.handleInput(progress(3, 3));
    h.eng.handleInput(exact(1, 1));
    expect(comboSeq(h.events)).toEqual([1, 0]);
    const r = finishedEvent(h.events);
    expect(r.stats.maxCombo).toBe(1);
    // 국가1 오타 1 → totalKeystrokes 국가0(4) + 국가1(1+3+1=5) = 9, correct = 4 + (0+3+1)=8
    expect(r.stats.totalKeystrokes).toBe(9);
    expect(r.stats.correctKeystrokes).toBe(8);
  });
});

// ── 서바이벌(티어) 타임아웃 → 라이프 → 라이프 0 종료 ─────────────────────────
describe('티어 서바이벌 (docs/01 §7.1)', () => {
  it('첫 국가 제한시간 ×2 (docs/01 §7.2 예외)', () => {
    const h = makeEngine(tierRules('ko'), [
      mkCountry({ id: 'US1', nameKo: '미국' }),
      mkCountry({ id: 'US2', nameKo: '미국' }),
    ]);
    startPlaying(h);
    // 국가0을 즉시 클리어해 국가1 countryShown을 얻는다
    h.eng.handleInput(exact(5));
    const shown = h.events.filter((e) => e.type === 'countryShown') as Array<{
      timeLimitMs: number | null;
    }>;
    expect(shown[0]!.timeLimitMs).toBe(8200); // 첫 국가 ×2
    expect(shown[1]!.timeLimitMs).toBe(4100);
    expect(shown[0]!.timeLimitMs).toBe(2 * shown[1]!.timeLimitMs!);
  });

  it('타임아웃 → 자동 스킵 → 라이프 −1, 3회 소진 시 게임오버(부분 점수)', () => {
    const h = makeEngine(tierRules('ko'), countries(5));
    startPlaying(h);
    // 아무 입력 없이 충분히 진행 → 국가0,1,2 연속 타임아웃 → 라이프 3→0
    h.clock.advance(300_000);

    expect(lifeSeq(h.events)).toEqual([3, 2, 1, 0]); // 시작 시 3, 스킵마다 −1
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('gameover');
    expect(r.score.completed).toBe(false);
    expect(r.stats.countriesSkipped).toBe(3);
    expect(r.stats.countriesCleared).toBe(0);
    // 미완주 → 최대 B (docs/01 §6.3). PI가 낮으므로 D 근처지만 상한 규칙 자체는 grade.ts가 보장.
    expect(['B', 'C', 'D']).toContain(r.score.grade);
    // 스킵 3국 × L=4 전량 오타 → totalKeystrokes 12, correct 0
    expect(r.stats.totalKeystrokes).toBe(12);
    expect(r.stats.correctKeystrokes).toBe(0);
  });
});

// ── 데일리: 라이프 1 → 첫 스킵에 즉시 종료 ─────────────────────────────────
describe('데일리 (docs/01 §7.1: 라이프 1)', () => {
  it('첫 스킵(ESC)에 라이프 0 → 즉시 종료', () => {
    const h = makeEngine(dailyRules('ko'), countries(10));
    startPlaying(h);
    h.eng.handleInput({ type: 'skipRequested' });
    expect(lifeSeq(h.events)).toEqual([1, 0]);
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('gameover');
    expect(r.stats.countriesSkipped).toBe(1);
  });
});

// ── 세계일주 체크포인트 ─────────────────────────────────────────────────────
describe('세계일주 체크포인트 (docs/00 §11-D2: 10/20/30/40 + 종착)', () => {
  it('10번째 확정 시 checkpoint{legIndex:0} 이벤트', () => {
    const h = makeEngine(worldtourRules(), countries(12));
    startPlaying(h);
    for (let i = 0; i < 10; i++) {
      h.clock.advance(500);
      h.eng.handleInput(exact(4));
    }
    const cps = h.events.filter((e) => e.type === 'checkpoint') as Array<{
      legIndex: number;
      splitMs: number;
    }>;
    expect(cps).toHaveLength(1);
    expect(cps[0]!.legIndex).toBe(0);
    expect(cps[0]!.splitMs).toBe(5000); // 10×500
    // 종착(마지막 국가)은 체크포인트 이벤트가 아니다 — 나머지 클리어 후에도 leg 1 없음
    for (let i = 10; i < 12; i++) {
      h.clock.advance(500);
      h.eng.handleInput(exact(4));
    }
    expect(h.events.filter((e) => e.type === 'checkpoint')).toHaveLength(1);
    expect(finishedEvent(h.events).outcome).toBe('completed');
  });

  it('라이프 0 게임오버 → resumeFromCheckpoint(): 마지막 체크포인트로 되감기 + viaCheckpoint', () => {
    const h = makeEngine(worldtourRules(), countries(15));
    startPlaying(h);
    for (let i = 0; i < 10; i++) h.eng.handleInput(exact(4)); // 체크포인트 10 통과
    // 라이프 3 → 스킵 3회로 게임오버(index 10,11,12)
    h.eng.handleInput({ type: 'skipRequested' }); // lives 2
    h.eng.handleInput({ type: 'skipRequested' }); // lives 1
    h.eng.handleInput({ type: 'skipRequested' }); // lives 0 → gameover
    expect(finishedEvent(h.events).outcome).toBe('gameover');
    expect(h.eng.getSnapshot().checkpointResumeAvailable).toBe(true);

    const ok = h.eng.resumeFromCheckpoint();
    expect(ok).toBe(true);
    const snap = h.eng.getSnapshot();
    expect(snap.phase).toBe('playing');
    expect(snap.lives).toBe(3); // 복원
    expect(snap.currentIndex).toBe(10); // 체크포인트 10으로 되감기
    expect(snap.countriesCleared).toBe(10);
    expect(snap.countriesSkipped).toBe(0); // 스킵 기록 잘려나감
    expect(snap.viaCheckpoint).toBe(true);
    expect(snap.checkpointResumeAvailable).toBe(false); // 1회 소진

    // 두 번째 resume 시도는 거부(이미 사용) — finished 상태가 아니므로도 false
    expect(h.eng.resumeFromCheckpoint()).toBe(false);

    // 나머지 5개국 완주
    for (let i = 10; i < 15; i++) h.eng.handleInput(exact(4));
    const finals = h.events.filter((e) => e.type === 'finished');
    const last = finals[finals.length - 1]!;
    if (last.type !== 'finished') throw new Error('finished 없음');
    expect(last.result.outcome).toBe('completed');
    expect(last.result.viaCheckpoint).toBe(true); // 랭킹 제출 제외 플래그 유지
  });

  it('resume은 완주(gameover 아님)·비-worldtour에서는 거부', () => {
    // 완주한 worldtour → resume 거부
    const h = makeEngine(worldtourRules(), countries(3));
    startPlaying(h);
    for (let i = 0; i < 3; i++) h.eng.handleInput(exact(4));
    expect(finishedEvent(h.events).outcome).toBe('completed');
    expect(h.eng.resumeFromCheckpoint()).toBe(false);

    // continent(비 worldtour) 완주 → resume 거부
    const h2 = makeEngine(continentRules(), countries(2));
    startPlaying(h2);
    h2.eng.handleInput(exact(4));
    h2.eng.handleInput(exact(4));
    expect(h2.eng.resumeFromCheckpoint()).toBe(false);

    // playing 중 resume 거부(finished 아님)
    const h3 = makeEngine(worldtourRules(), countries(12));
    startPlaying(h3);
    expect(h3.eng.resumeFromCheckpoint()).toBe(false);
  });

  it('resume: 첫 체크포인트 이전 게임오버 → 처음(index 0)부터', () => {
    const h = makeEngine(worldtourRules(), countries(12));
    startPlaying(h);
    h.eng.handleInput({ type: 'skipRequested' }); // lives 2
    h.eng.handleInput({ type: 'skipRequested' }); // lives 1
    h.eng.handleInput({ type: 'skipRequested' }); // lives 0 → gameover (index 2)
    expect(finishedEvent(h.events).outcome).toBe('gameover');
    expect(h.eng.resumeFromCheckpoint()).toBe(true);
    const snap = h.eng.getSnapshot();
    expect(snap.currentIndex).toBe(0); // 통과 체크포인트 없음 → 처음부터
    expect(snap.countriesCleared).toBe(0);
    expect(snap.countriesSkipped).toBe(0);
  });
});

// ── 스킵 페널티 (docs/01 §5.5) ──────────────────────────────────────────────
describe('스킵 페널티 (docs/01 §5.5)', () => {
  it('대륙(라이프 없음): 스킵 → 콤보 0, 필요 타수 전량 오타, 라이프 이벤트 없음', () => {
    const h = makeEngine(continentRules(), countries(3));
    startPlaying(h);
    h.eng.handleInput(exact(4)); // 국가0 클린 → 콤보 1
    h.eng.handleInput({ type: 'skipRequested' }); // 국가1 스킵

    expect(lifeSeq(h.events)).toEqual([]); // 라이프 없는 모드
    const committed = h.events.filter((e) => e.type === 'countryCommitted') as Array<{
      skipped: boolean;
      combo: number;
      errors: number;
    }>;
    expect(committed[1]!.skipped).toBe(true);
    expect(committed[1]!.combo).toBe(0);
    expect(committed[1]!.errors).toBe(4); // L=4 전량 오타
    expect(comboSeq(h.events)).toEqual([1, 0]);

    h.eng.handleInput(exact(4)); // 국가2 클린 → 완주
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('completed'); // 스킵은 미완주 사유 아님
    expect(r.stats.countriesSkipped).toBe(1);
    // total = 국가0(4) + 스킵 L(4) + 국가2(4) = 12, correct = 4 + 0 + 4 = 8
    expect(r.stats.totalKeystrokes).toBe(12);
    expect(r.stats.correctKeystrokes).toBe(8);
  });
});

// ── practice 강등 ───────────────────────────────────────────────────────────
describe('practice 강등 (docs/07 지시 2)', () => {
  it('bulkInsert → degradedToPractice{bulk}, 결과 practice=true, 중복은 1회만', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.handleInput({ type: 'bulkInsert' });
    h.eng.handleInput({ type: 'bulkInsert' }); // 중복 — 이벤트 추가 없음
    const deg = h.events.filter((e) => e.type === 'degradedToPractice') as Array<{ reason: string }>;
    expect(deg).toHaveLength(1);
    expect(deg[0]!.reason).toBe('bulk');
    h.eng.handleInput(exact(4));
    h.eng.handleInput(exact(4));
    expect(finishedEvent(h.events).practice).toBe(true);
  });

  it('blurred(playing 중) → degradedToPractice{blur}', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.handleInput({ type: 'blurred' });
    const deg = h.events.filter((e) => e.type === 'degradedToPractice') as Array<{ reason: string }>;
    expect(deg[0]!.reason).toBe('blur');
    expect(h.eng.getSnapshot().practice).toBe(true);
  });

  it('latinInKoMode/refocused는 엔진 상태 무관(무시)', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.handleInput({ type: 'latinInKoMode' });
    h.eng.handleInput({ type: 'refocused' });
    expect(h.eng.getSnapshot().practice).toBe(false);
    expect(h.eng.getSnapshot().currentIndex).toBe(0);
  });

  it('playing이 아닐 때 입력은 무시된다', () => {
    const h = makeEngine(continentRules(), countries(2));
    h.eng.handleInput(exact(4)); // idle 상태 — 무시
    expect(h.eng.getSnapshot().totalKeystrokes).toBe(0);
  });
});

// ── retry / abort ───────────────────────────────────────────────────────────
describe('retry / abort', () => {
  it('retry() → 상태 완전 초기화 후 countdown 재진입', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.clock.advance(1000);
    h.eng.handleInput(exact(4));
    h.eng.handleInput(exact(4));
    expect(h.eng.getSnapshot().phase).toBe('finished');
    expect(h.eng.getSnapshot().countriesCleared).toBe(2);

    h.eng.retry();
    expect(h.eng.getSnapshot().phase).toBe('countdown');
    expect(h.eng.getSnapshot().countdownEndsAt).toBe(h.clock.nowMs + RETRY_COUNTDOWN_MS);
    h.clock.advance(RETRY_COUNTDOWN_MS);
    const snap = h.eng.getSnapshot();
    expect(snap.phase).toBe('playing');
    expect(snap.currentIndex).toBe(0);
    expect(snap.countriesCleared).toBe(0);
    expect(snap.combo).toBe(0);
    expect(snap.maxCombo).toBe(0);
    expect(snap.totalKeystrokes).toBe(0);
    expect(snap.viaCheckpoint).toBe(false);
  });

  it('retry()는 finished가 아니면 무시', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.retry(); // playing 중 — 무시
    expect(h.eng.getSnapshot().phase).toBe('playing');
  });

  it('abort() → aborted, 이후 start()로 재개 가능', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.eng.abort();
    expect(h.eng.getSnapshot().phase).toBe('aborted');
    expect(phases(h.events)).toContain('aborted');

    h.eng.start(); // aborted → countdown 허용
    expect(h.eng.getSnapshot().phase).toBe('countdown');
  });

  it('abort()는 idle/finished에서 무시', () => {
    const h = makeEngine(continentRules(), countries(2));
    h.eng.abort(); // idle — 무시
    expect(h.eng.getSnapshot().phase).toBe('idle');
  });

  it('abort()는 countdown 중에도 허용', () => {
    const h = makeEngine(continentRules(), countries(2));
    h.eng.start();
    h.eng.abort();
    expect(h.eng.getSnapshot().phase).toBe('aborted');
  });
});

// ── statsTick ───────────────────────────────────────────────────────────────
describe('statsTick (500ms 스로틀)', () => {
  it('playing 동안 500ms마다 statsTick emit', () => {
    const h = makeEngine(continentRules(), countries(5));
    startPlaying(h);
    h.eng.handleInput(progress(4, 4)); // 미확정 버퍼(실시간 표시에 반영)
    h.clock.advance(STATS_TICK_MS * 3 + 10); // 3틱
    const ticks = h.events.filter((e) => e.type === 'statsTick') as Array<{
      cpm: number;
      acc: number;
      elapsedMs: number;
    }>;
    expect(ticks.length).toBe(3);
    expect(ticks[0]!.elapsedMs).toBe(STATS_TICK_MS);
    expect(ticks[0]!.acc).toBe(1); // 4/4
    expect(ticks[0]!.cpm).toBeGreaterThan(0);
  });

  it('playing 이탈 후 남은 statsTick 콜백은 no-op (방어 가드)', () => {
    // schedule 취소를 무시하는 "누수" deps로 finished 이후 콜백이 실행되는 상황을 재현.
    const pending: Array<() => void> = [];
    let now = 0;
    const deps: EngineDeps = {
      now: () => now,
      schedule: (cb) => {
        pending.push(cb);
        return () => {
          /* 취소 무시(누수 시뮬레이션) */
        };
      },
      rules: continentRules(),
    };
    const eng = new GameSessionEngine(deps, countries(1), 'ko');
    eng.start();
    pending.shift()!(); // countdown 콜백 → beginPlaying(statsTick 스케줄)
    eng.handleInput(exact(4)); // 유일 국가 클리어 → finished (cancel은 누수라 무효)

    const events: EngineEvent[] = [];
    eng.subscribe((e) => events.push(e));
    now = STATS_TICK_MS;
    for (const cb of pending.splice(0)) cb(); // 남은 statsTick 콜백 수동 실행
    expect(events.filter((e) => e.type === 'statsTick')).toHaveLength(0); // phase!=='playing' → 무시
  });
});

// ── race: 10초 타임아웃 + 하드캡 ──────────────────────────────────────────────
describe('race (docs/01 §7.1: 10초/180초, 라이프 없음)', () => {
  it('국가당 10초 타임아웃 → 자동 스킵(라이프 이벤트 없음)', () => {
    const h = makeEngine(raceRules(), countries(2));
    startPlaying(h);
    h.clock.advance(10_000); // 국가0 타임아웃
    const committed = h.events.filter((e) => e.type === 'countryCommitted') as Array<{
      skipped: boolean;
    }>;
    expect(committed[0]!.skipped).toBe(true);
    expect(lifeSeq(h.events)).toEqual([]); // 라이프 없음
    h.clock.advance(10_000); // 국가1 타임아웃 → 완주(모든 국가 진행)
    expect(finishedEvent(h.events).outcome).toBe('completed');
  });

  it('하드캡 도달 → 강제 종료(입력 없음, finishRun else 분기)', () => {
    // 하드캡만 걸고 국가당 제한은 없는 규칙으로 하드캡 경로를 격리 검증.
    const rules: ModeRules = {
      id: 'race',
      lives: null,
      timeLimitMs: () => null,
      onSkip: () => {},
      hardCapMs: 180_000,
    };
    const h = makeEngine(rules, countries(5));
    startPlaying(h);
    h.clock.advance(180_000);
    const r = finishedEvent(h.events);
    expect(r.outcome).toBe('gameover');
    expect(r.score.completed).toBe(false);
    expect(r.stats.countriesCleared).toBe(0);
    expect(r.stats.elapsedMs).toBe(180_000); // 커밋 없음 → now-playingStart
  });
});

// ── 제출 페이로드 (docs/06 §3.2) ────────────────────────────────────────────
describe('buildSubmission (docs/06 §3.2 RunSubmission)', () => {
  it('perCountry(keystrokes 포함) + inputDigest 조립', () => {
    const h = makeEngine(continentRules(), countries(2));
    startPlaying(h);
    h.clock.advance(100);
    h.eng.handleInput(progress(2, 2));
    h.clock.advance(100);
    h.eng.handleInput(exact(2, 2)); // 국가0: 4타
    h.clock.advance(100);
    h.eng.handleInput(exact(4, 4)); // 국가1: 4타
    finishedEvent(h.events);

    const sub = h.eng.buildSubmission('wt1.token');
    expect(sub.token).toBe('wt1.token');
    expect(sub.perCountry).toHaveLength(2);
    expect(sub.perCountry[0]).toMatchObject({ code: 'C0', keystrokes: 4, errors: 0, skipped: false });
    const digest = JSON.parse(sub.inputDigest) as InputDigest;
    expect(digest.n).toBeGreaterThan(0);
    expect(digest.burstMax).toBe(4);
    expect(typeof digest.mean).toBe('number');

    // 기본 토큰은 빈 문자열
    expect(h.eng.buildSubmission().token).toBe('');
  });
});

// ── RunLog 직접 (docs/03 §5.4 · docs/06 §3.4) ─────────────────────────────────
describe('RunLog ring buffer + inputDigest', () => {
  const ev = (): TypingEvent => ({ type: 'bulkInsert' });

  it('용량 초과 시 가장 오래된 엔트리부터 덮어쓴다', () => {
    const log = new RunLog();
    const N = RUN_LOG_CAPACITY + 3;
    for (let i = 0; i < N; i++) log.append(ev(), i, 0);
    expect(log.size).toBe(RUN_LOG_CAPACITY);
    const entries = log.entries();
    expect(entries).toHaveLength(RUN_LOG_CAPACITY);
    expect(entries[0]!.tRelMs).toBe(3); // 앞 3개(0,1,2) 밀려남
    expect(entries[RUN_LOG_CAPACITY - 1]!.tRelMs).toBe(N - 1);
  });

  it('reset → 비움', () => {
    const log = new RunLog();
    log.append(ev(), 0, 0);
    log.reset();
    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  it('computeDigest: 간격 없음 → 전부 0', () => {
    const log = new RunLog();
    log.append(exact(4), 100, 4); // 타건 1개 → 간격 0개
    log.append(ev(), 200, 0); // 비타건은 간격 계산 제외
    const d = log.computeDigest();
    expect(d).toEqual({ n: 0, mean: 0, stdev: 0, p10: 0, p50: 0, p90: 0, burstMax: 4 });
  });

  it('computeDigest: 간격 [100,200,300] 통계 + 백분위 선형보간', () => {
    const log = new RunLog();
    for (const [t, added] of [
      [0, 1],
      [100, 2],
      [300, 3],
      [600, 1],
    ] as const) {
      log.append(progress(added, added), t, added);
    }
    const d = log.computeDigest();
    expect(d.n).toBe(3);
    expect(d.mean).toBe(200); // (100+200+300)/3
    expect(d.burstMax).toBe(3);
    expect(d.p50).toBe(200); // lo===hi 분기
    expect(d.p10).toBeCloseTo(120, 6); // 100*0.8 + 200*0.2
    expect(d.p90).toBeCloseTo(280, 6); // 200*0.2 + 300*0.8
    expect(d.stdev).toBeCloseTo(Math.sqrt(((100 - 200) ** 2 + 0 + (300 - 200) ** 2) / 3), 6);
  });

  it('computeDigest: 간격 1개 → 백분위=그 값(length 1 분기)', () => {
    const log = new RunLog();
    log.append(progress(1, 1), 0, 1);
    log.append(progress(1, 1), 150, 1);
    const d = log.computeDigest();
    expect(d.n).toBe(1);
    expect(d.mean).toBe(150);
    expect(d.stdev).toBe(0);
    expect(d.p10).toBe(150);
    expect(d.p50).toBe(150);
    expect(d.p90).toBe(150);
  });

  it('toSubmissionPayload: token/perCountry 사본/digest 직렬화', () => {
    const log = new RunLog();
    log.append(progress(2, 2), 0, 2);
    const pc = [{ code: 'C0', ms: 100, keystrokes: 4, errors: 0, skipped: false }];
    const sub = log.toSubmissionPayload(pc, 'tok');
    expect(sub.token).toBe('tok');
    expect(sub.perCountry).toEqual(pc);
    expect(sub.perCountry).not.toBe(pc); // 사본
    expect(() => JSON.parse(sub.inputDigest)).not.toThrow();
  });
});

// ── 생성자 계약 ─────────────────────────────────────────────────────────────
describe('생성자', () => {
  it('빈 countries는 throw', () => {
    const clock = new VirtualClock();
    expect(
      () =>
        new GameSessionEngine(
          { now: clock.now, schedule: clock.schedule, rules: continentRules() },
          [],
          'ko',
        ),
    ).toThrow(/countries must not be empty/);
  });
});
