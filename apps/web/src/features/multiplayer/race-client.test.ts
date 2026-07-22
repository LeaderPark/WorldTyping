// spec: docs/05 §4.4(progress 스로틀)·§5(낙관-롤백)·§6(timesync·ct)·§7.2(race-sync)·§8-2·§13-F12,
//       docs/03 §6.3·§6.5·§6.6, WT-M4-03 완료조건(모의 WS: 거부 롤백/재연결/스로틀/최소 RTT).
import { describe, expect, it, vi } from 'vitest';
import type { MatchDetail, S2C_Results, S2C_Start, ServerMessage } from '@wt/shared';
import type { EngineEvent, KeystrokeDelta, TypingEvent } from '@wt/engine';
import type { ClientMessageDraft } from '../../net/ws-manager';
import { RaceClient, type RaceStore } from './race-client';
import { Timesync } from './timesync';

// ── TypingEvent 픽스처 ───────────────────────────────────────────────────
function dlt(added: number, err: number): KeystrokeDelta {
  return { added, removed: 0, addedCorrect: added - err, addedError: err };
}
function mkDetail(display: string, matchedLen: number, state: MatchDetail['state']): MatchDetail {
  return { state, bestTarget: { display, key: '' }, matchedLen, inputLen: matchedLen };
}
const exact = (display: string, err = 0): TypingEvent => ({
  type: 'exact',
  detail: mkDetail(display, 0, 'EXACT'),
  delta: dlt(2, err),
  elapsedFromShownMs: 0,
});
const progress = (ks: number, err = 0): TypingEvent => ({
  type: 'progress',
  detail: mkDetail('', ks, 'PREFIX'),
  delta: dlt(ks, err),
  rawValue: '',
});
const miss = (ks: number, err: number): TypingEvent => ({
  type: 'miss',
  detail: mkDetail('', ks, 'PREFIX'),
  delta: dlt(ks, err),
});

// ── 하네스 ───────────────────────────────────────────────────────────────
function fakeEngine() {
  const rollbacks: number[] = [];
  let handler: ((e: EngineEvent) => void) | null = null;
  return {
    rollbacks,
    rollbackTo: (i: number) => rollbacks.push(i),
    subscribe: (f: (e: EngineEvent) => void) => {
      handler = f;
      return () => {
        handler = null;
      };
    },
    emit: (e: EngineEvent) => handler?.(e),
  };
}
function fakeInput() {
  let handler: ((e: TypingEvent) => void) | null = null;
  return {
    subscribe: (f: (e: TypingEvent) => void) => {
      handler = f;
      return () => {
        handler = null;
      };
    },
    emit: (e: TypingEvent) => handler?.(e),
  };
}

interface Harness {
  rc: RaceClient;
  engine: ReturnType<typeof fakeEngine>;
  input: ReturnType<typeof fakeInput>;
  sent: ClientMessageDraft[];
  flushInput: ReturnType<typeof vi.fn>;
  store: RaceStore & Record<string, ReturnType<typeof vi.fn>>;
  clock: { t: number };
  fireTimers: () => void;
  onDesync: ReturnType<typeof vi.fn>;
}

function setup(opts: { offset?: number } = {}): Harness {
  const engine = fakeEngine();
  const input = fakeInput();
  const sent: ClientMessageDraft[] = [];
  let seq = 0;
  const clock = { t: 0 };
  const pending: Array<() => void> = [];
  const flushInput = vi.fn();
  const onDesync = vi.fn();
  const store = {
    upsertOpponent: vi.fn(),
    clearOpponents: vi.fn(),
    setServerAck: vi.fn(),
    setRaceResult: vi.fn(),
  } as unknown as RaceStore & Record<string, ReturnType<typeof vi.fn>>;
  const rc = new RaceClient({
    engine,
    inputEvents: input,
    flushInput,
    send: (d) => {
      sent.push(d);
      return ++seq;
    },
    offsetMs: () => opts.offset ?? 0,
    now: () => clock.t,
    schedule: (cb) => {
      pending.push(cb);
      return () => {};
    },
    onDesync,
    store,
  });
  rc.attach();
  return {
    rc,
    engine,
    input,
    sent,
    flushInput,
    store,
    clock,
    onDesync,
    fireTimers: () => {
      const fns = pending.splice(0);
      for (const f of fns) f();
    },
  };
}

function startMsg(over: Partial<S2C_Start> = {}): ServerMessage {
  return {
    v: 1,
    type: 'start',
    raceId: 'r1',
    seed: '0'.repeat(32),
    countries: ['KR', 'BR', 'DE', 'TH', 'EG'],
    dataVersion: 'abc',
    startAt: 0,
    hardCapAt: 180_000,
    perCountryLimitMs: 10_000,
    ...over,
  };
}
const completes = (sent: ClientMessageDraft[]) => sent.filter((m) => m.type === 'complete');
const progresses = (sent: ClientMessageDraft[]) => sent.filter((m) => m.type === 'progress');

describe('RaceClient 낙관 complete 전송(§5, §9-A4)', () => {
  it('exact → complete{idx,input원문,ct,errThis} 전송 후 idx 전진', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.clock.t = 1234;
    h.input.emit(exact('태국'));
    const c = completes(h.sent);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: 'complete', idx: 0, input: '태국', ct: 1234, errThis: 0 });
    expect(h.rc.getRaceIdx()).toBe(1);
    // 점수·순위·경과시간은 절대 전송하지 않는다(§9-A4) — complete 필드만.
    expect(Object.keys(c[0]!).sort()).toEqual(['ct', 'errThis', 'idx', 'input', 'type', 'v']);
  });

  it('ct는 startAt − offset 기준 로컬 경과시간(§6)', () => {
    const h = setup({ offset: 200 });
    h.rc.handleMessage(startMsg({ startAt: 1000 })); // localStartPerf = 1000 − 200 = 800
    h.clock.t = 850;
    h.input.emit(exact('KR'));
    expect(completes(h.sent)[0]!.ct).toBe(50);
  });

  it('errThis는 국가별 누적 오타이고 exact 후 리셋', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.input.emit(miss(1, 1)); // 오타 1
    h.input.emit(exact('KR')); // complete.errThis = 1
    h.input.emit(miss(1, 2)); // 다음 국가 오타 2
    h.input.emit(exact('BR')); // complete.errThis = 2
    const c = completes(h.sent);
    expect(c.map((x) => x.errThis)).toEqual([1, 2]);
    expect(c.map((x) => x.idx)).toEqual([0, 1]);
  });

  it('레이스 시작 전 입력은 무시(localStart 미설정)', () => {
    const h = setup();
    h.input.emit(exact('KR'));
    expect(completes(h.sent)).toHaveLength(0);
  });
});

describe('RaceClient progress 스로틀(§4.4 100ms + 변화 시)', () => {
  it('첫 신고 즉시 전송, 무변화 스킵, 100ms 내 변화는 타이머로 지연', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.clock.t = 0;
    h.input.emit(progress(1)); // 즉시 전송
    expect(progresses(h.sent)).toHaveLength(1);
    h.input.emit(progress(1)); // 무변화 → 스킵
    expect(progresses(h.sent)).toHaveLength(1);
    h.clock.t = 50;
    h.input.emit(progress(3)); // 변화 but 100ms 미경과 → 타이머 예약
    expect(progresses(h.sent)).toHaveLength(1);
    h.fireTimers(); // 타이머 만기 → 전송
    expect(progresses(h.sent)).toHaveLength(2);
    expect(progresses(h.sent).at(-1)).toMatchObject({ idx: 0, ks: 3 });
  });
});

describe('RaceClient 서버 권위 롤백(§5, §6.3)', () => {
  it('rejected → engine.rollbackTo + 입력 flush + idx 되감기, 이후 complete가 권위 인덱스와 일치', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.input.emit(exact('KR')); // idx0 → 1
    h.input.emit(exact('BR')); // idx1 → 2
    h.input.emit(exact('DE')); // idx2 → 3
    expect(h.rc.getRaceIdx()).toBe(3);

    h.rc.handleMessage({
      v: 1,
      type: 'country-rejected',
      ack: 1,
      idx: 2,
      reason: 'WRONG_INDEX',
      authoritative: { nextIdx: 1, serverElapsedMs: 5000, combo: 0 },
    });
    expect(h.engine.rollbacks).toEqual([1]);
    expect(h.flushInput).toHaveBeenCalledTimes(1);
    expect(h.rc.getRaceIdx()).toBe(1);

    h.input.emit(exact('BR')); // 재타이핑 → 권위 인덱스 1로 complete
    expect(completes(h.sent).at(-1)).toMatchObject({ idx: 1, input: 'BR' });
  });

  it('3연속 rejected → onDesync 1회 호출(F12 재동기)', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    for (let i = 0; i < 3; i++) {
      h.rc.handleMessage({
        v: 1,
        type: 'country-rejected',
        ack: i + 1,
        idx: 0,
        reason: 'NOT_EXACT',
        authoritative: { nextIdx: 0, serverElapsedMs: 100, combo: 0 },
      });
    }
    expect(h.onDesync).toHaveBeenCalledTimes(1);
    expect(h.engine.rollbacks).toEqual([0, 0, 0]);
  });

  it('accepted가 사이에 오면 연속 카운트가 리셋된다', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    const reject = () =>
      h.rc.handleMessage({
        v: 1,
        type: 'country-rejected',
        ack: 1,
        idx: 0,
        reason: 'NOT_EXACT',
        authoritative: { nextIdx: 0, serverElapsedMs: 0, combo: 0 },
      });
    reject();
    reject();
    h.rc.handleMessage({
      v: 1,
      type: 'country-accepted',
      ack: 9,
      idx: 0,
      nextIdx: 1,
      serverElapsedMs: 100,
      combo: 1,
      finished: false,
      rank: null,
    });
    reject();
    reject();
    expect(h.onDesync).not.toHaveBeenCalled();
  });
});

describe('RaceClient race-sync 재동기(§7.2)', () => {
  it('me.nextIdx로 엔진 복원 + tick 반영', () => {
    const h = setup();
    h.rc.handleMessage({
      v: 1,
      type: 'race-sync',
      phase: 'RACING',
      start: startMsg() as S2C_Start,
      me: { nextIdx: 3, serverElapsedMs: 20_000, combo: 2, errorKeystrokes: 4 },
      tick: {
        v: 1,
        type: 'progress-tick',
        at: 20_000,
        players: [{ id: 'o1', idx: 4, ksPct: 10, combo: 4, state: 'racing', rank: null }],
      },
    });
    expect(h.engine.rollbacks).toEqual([3]);
    expect(h.rc.getRaceIdx()).toBe(3);
    expect(h.store.upsertOpponent).toHaveBeenCalledWith('o1', expect.objectContaining({ idx: 4 }));
  });
});

describe('RaceClient progress-tick(§8-2 보간·셰이크)', () => {
  it('at 역전/중복은 폐기, combo 0 리셋 tick은 missFlash', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    const tick = (at: number, combo: number): ServerMessage => ({
      v: 1,
      type: 'progress-tick',
      at,
      players: [{ id: 'o1', idx: 1, ksPct: 20, combo, state: 'racing', rank: null }],
    });
    h.rc.handleMessage(tick(100, 3));
    h.rc.handleMessage(tick(90, 5)); // 역전 → 폐기
    h.rc.handleMessage(tick(110, 0)); // combo 0 리셋 → missFlash
    expect(h.store.upsertOpponent).toHaveBeenCalledTimes(2);
    expect(h.store.upsertOpponent).toHaveBeenLastCalledWith(
      'o1',
      expect.objectContaining({ combo: 0, missFlash: true }),
    );
  });
});

describe('RaceClient 결승 게이트(§6.3)·결과 권위(§6.6)·자동 스킵 미러(§5)', () => {
  it('완주 연출은 accepted{finished:true} 수신 후에만', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.input.emit(exact('KR'));
    expect(h.rc.isFinishConfirmed()).toBe(false);
    h.rc.handleMessage({
      v: 1,
      type: 'country-accepted',
      ack: 1,
      idx: 0,
      nextIdx: 5,
      serverElapsedMs: 30_000,
      combo: 5,
      finished: true,
      rank: 1,
    });
    expect(h.rc.isFinishConfirmed()).toBe(true);
  });

  it('results는 서버 값을 그대로 스토어에 반영', () => {
    const h = setup();
    const results: S2C_Results = {
      v: 1,
      type: 'results',
      raceId: 'r1',
      rows: [],
      rematchDeadline: 999,
    };
    h.rc.handleMessage(results);
    expect(h.store.setRaceResult).toHaveBeenCalledWith(results);
  });

  it('엔진 자동 스킵(countryCommitted{skipped}) → complete 없이 idx 전진', () => {
    const h = setup();
    h.rc.handleMessage(startMsg());
    h.engine.emit({
      type: 'countryCommitted',
      index: 0,
      id: 'KR',
      ms: 10_000,
      errors: 4,
      skipped: true,
      combo: 0,
    });
    expect(completes(h.sent)).toHaveLength(0);
    expect(h.rc.getRaceIdx()).toBe(1);
  });
});

// ── Timesync 최소 RTT 표본 채택(§6.1) — 블록 완료조건 "timesync 최소 RTT 선택" ──────────
describe('Timesync 최소 RTT 표본 + 30ms 유지(§6.1)', () => {
  it('최소 RTT의 offset을 채택하되 30ms 미만 변화는 유지, 큰 RTT 표본은 무시', () => {
    const clock = { t: 1000 };
    const sent: number[] = [];
    const scheduled: Array<{ cb: () => void }> = [];
    const ts = new Timesync({
      now: () => clock.t,
      send: (t0) => sent.push(t0),
      schedule: (cb) => {
        const e = { cb };
        scheduled.push(e);
        return () => {};
      },
    });
    ts.start(); // 즉시 1회 ping(t0=1000) + 버스트 4 + 주기 1 스케줄
    expect(sent[0]).toBe(1000);

    // 표본1: rtt=40 → offset = 5000 + 20 − 1040 = 3980
    clock.t = 1040;
    ts.onReply({ t0: 1000, t1: 5000 });
    expect(ts.getOffset()).toBeCloseTo(3980);
    expect(ts.getRttMs()).toBe(40);

    // 표본2: 더 작은 rtt=10, offset 변화 15ms(<30) → offset 유지, minRtt만 갱신
    clock.t = 1200;
    scheduled[0]!.cb(); // 버스트 200ms ping → t0=1200
    clock.t = 1210;
    ts.onReply({ t0: 1200, t1: 5170 }); // candidate = 5170 + 5 − 1210 = 3965
    expect(ts.getOffset()).toBeCloseTo(3980); // 유지
    expect(ts.getRttMs()).toBe(10);

    // 표본3: 더 작은 rtt=5, offset 변화 큼(≥30) → 채택
    clock.t = 1400;
    scheduled[1]!.cb();
    clock.t = 1405;
    ts.onReply({ t0: 1400, t1: 5500 }); // candidate = 5500 + 2.5 − 1405 = 4097.5
    expect(ts.getOffset()).toBeCloseTo(4097.5);

    // 표본4: 더 큰 rtt=100 → 무시(offset 불변)
    clock.t = 1600;
    scheduled[2]!.cb();
    clock.t = 1700;
    ts.onReply({ t0: 1600, t1: 5650 });
    expect(ts.getOffset()).toBeCloseTo(4097.5);
  });
});
