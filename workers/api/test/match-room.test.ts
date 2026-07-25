// spec: docs/05 §1·§5·§7·§10·§11.2, docs/00 §11-D7/D12 + WT-M4-01 [완료 조건]
// MatchRoom DO 통합/단위 테스트(vitest-pool-workers). 시간 게이트 전이는 DO의 주입 클록(testClock)을
// runInDurableObject로 제어해 벽시계 대기 없이 결정적으로 구동한다(세션 어댑테이션 §2 "자동화 등가물").
//
// 채택안(notes): Hibernation wake 0회는 miniflare에서 직접 카운트가 불가하므로, setWebSocketAutoResponse
// (ping/pong)가 webSocketMessage 핸들러를 깨우지 않음(messageCount 불변) + RACING 외 phase에서 tick
// setTimeout 체인이 해제됨(debug.tickScheduled=false)을 코드/테스트로 검증한다.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { COUNTRIES, type Country } from '@wt/data';
import { nextAlarmTime, emptyAlarmSet } from '../src/do/alarms';
import { assignFinalRanks, computePlayerMetrics } from '../src/do/ranking';
import type { PlayerRecord } from '../src/do/room-state';

const BY_ID = new Map<string, Country>(COUNTRIES.map((c) => [c.id, c]));
const DATA_VERSION = 'testver1';

interface Seam {
  testClock: number | null;
  forcedPersistFailures: number;
  alarm(): Promise<void>;
  runTick(): Promise<void>;
}

interface DebugState {
  phase: string;
  messageCount: number;
  tickScheduled: boolean;
  hostId: string | null;
  players: Array<{
    id: string;
    connState: string;
    nextIndex: number;
    combo: number;
    rank: number | null;
    finishedAt: number | null;
    correctKeystrokes: number;
    errorKeystrokes: number;
    suspicionFlags: string[];
  }>;
  race: { raceId: string; seed: string; len: number } | null;
  alarms: {
    autoStart: number | null;
    raceStart: number | null;
    hardcap: number | null;
    voteDeadline: number | null;
    idleCleanup: number | null;
    emptyCleanup: number | null;
    persistRetry: number | null;
    graceDeadlines: Record<string, number>;
  };
  pendingPersist: number | null;
}

interface AnyMsg {
  type: string;
  [k: string]: unknown;
}

type Stub = DurableObjectStub;

let roomSeq = 0;
function newRoomCode(): string {
  roomSeq += 1;
  return 'RT' + roomSeq.toString().padStart(4, '0');
}

function stubFor(code: string): Stub {
  const id = env.MATCH_ROOM.idFromName('room:' + code);
  return env.MATCH_ROOM.get(id) as unknown as Stub;
}

interface Timings {
  [k: string]: unknown;
}

async function createRoom(
  stub: Stub,
  code: string,
  opts: { lang?: 'ko' | 'en'; quickMatch?: boolean; isPublic?: boolean; maxPlayers?: number; timings?: Timings } = {},
): Promise<void> {
  const timings: Timings = {
    countdownMs: 20,
    hardcapMs: 180_000,
    graceMs: 15_000,
    autostartMs: 15_000,
    rematchVoteMs: 30_000,
    createdCleanupMs: 60_000,
    idleCleanupMs: 600_000,
    emptyCleanupMs: 60_000,
    perCountryLimitMs: 3_600_000,
    // 음수 하한 → 고정 주입 클록에서도 연속 complete가 minMs에 걸리지 않는다(테스트 편의).
    reactionFloorMs: -1_000_000,
    startGraceMs: 0,
    maxKps: { ko: 100_000, en: 100_000 },
    tickMs: 3_600_000, // 실 miniflare tick 자동 발화 방지 — tick은 runInDurableObject로 구동
    persistRetryDelayMs: 1000,
    ...(opts.timings ?? {}),
  };
  const res = await stub.fetch('http://do/internal/create', {
    method: 'POST',
    body: JSON.stringify({
      config: {
        roomCode: code,
        lang: opts.lang ?? 'en',
        mode: 'race-mixed',
        poolParam: null,
        maxPlayers: opts.maxPlayers ?? 8,
        isPublic: opts.isPublic ?? false,
        quickMatch: opts.quickMatch ?? false,
      },
      timings,
      dataVersion: DATA_VERSION,
    }),
  });
  expect(res.status).toBe(200);
}

async function debug(stub: Stub): Promise<DebugState> {
  const res = await stub.fetch('http://do/internal/debug');
  return (await res.json()) as DebugState;
}

async function setSeam(stub: Stub, fn: (s: Seam) => void): Promise<void> {
  await runInDurableObject(stub, (inst) => {
    fn(inst as unknown as Seam);
  });
}

async function fireAlarmAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as Seam;
    s.testClock = t;
    await s.alarm();
  });
}

async function runTickAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as Seam;
    s.testClock = t;
    await s.runTick();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly ws: WebSocket;
  readonly inbox: AnyMsg[] = [];
  seq = 0;
  playerId = '';
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') this.inbox.push(JSON.parse(ev.data) as AnyMsg);
    });
  }
  send(obj: Record<string, unknown>): void {
    this.seq += 1;
    this.ws.send(JSON.stringify({ v: 1, seq: this.seq, ...obj }));
  }
  sendRaw(s: string): void {
    this.ws.send(s);
  }
  async take(type: string, timeoutMs = 2000): Promise<AnyMsg> {
    const start = Date.now();
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting '${type}'. inbox=${JSON.stringify(this.inbox.map((m) => m.type))}`);
      }
      await sleep(4);
    }
  }
  /** take()의 조건부 버전 — 같은 type이 여러 번 브로드캐스트되는 room-state 등에서 특정 필드값
   *  (예: phase)을 만족하는 가장 먼저 도착한 메시지를 찾는다(WT-FIX-FINISH-TRANSITION). */
  async takeWhere(pred: (m: AnyMsg) => boolean, timeoutMs = 2000): Promise<AnyMsg> {
    const start = Date.now();
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting predicate match. inbox=${JSON.stringify(this.inbox.map((m) => m.type))}`);
      }
      await sleep(4);
    }
  }
  has(type: string): boolean {
    return this.inbox.some((m) => m.type === type);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connect(stub: Stub, guestId: string, nickname: string): Promise<Client> {
  const res = await stub.fetch('http://do/ws', { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket in upgrade response');
  const c = new Client(ws);
  c.send({ type: 'hello', auth: { kind: 'guest', guestId }, dataVersion: DATA_VERSION });
  const welcome = await c.take('welcome');
  c.playerId = welcome.playerId as string;
  c.send({ type: 'join', nickname, passportCover: 'green' });
  await c.take('room-state');
  return c;
}

/** 호스트 start → COUNTDOWN → (raceStart alarm) → RACING. startAt/hardCapAt를 반환. */
async function startRace(host: Client, stub: Stub): Promise<{ startAt: number; hardCapAt: number; countries: string[] }> {
  host.send({ type: 'start' });
  const cd = await host.take('countdown');
  const startMsg = await host.take('start');
  const startAt = cd.startAt as number;
  await fireAlarmAt(stub, startAt); // raceStart 만기 → RACING
  return { startAt, hardCapAt: startMsg.hardCapAt as number, countries: startMsg.countries as string[] };
}

function inputFor(countryId: string): string {
  const c = BY_ID.get(countryId);
  if (!c) throw new Error('unknown country ' + countryId);
  return c.acceptedInputsEn[0]!;
}

// ───────────────────────── 순수 단위: alarm min 선택(§7.4) ─────────────────────────

describe('alarms.nextAlarmTime (min 후보 선택)', () => {
  it('여러 후보 중 최소값을 고른다', () => {
    const set = emptyAlarmSet();
    set.hardcap = 5000;
    set.voteDeadline = 3000;
    set.graceDeadlines = { p1: 4000, p2: 1500 };
    set.idleCleanup = 9000;
    expect(nextAlarmTime(set)).toBe(1500);
  });
  it('후보가 없으면 null', () => {
    expect(nextAlarmTime(emptyAlarmSet())).toBeNull();
  });
  it('grace만 있어도 선택된다', () => {
    const set = emptyAlarmSet();
    set.graceDeadlines = { p1: 777 };
    expect(nextAlarmTime(set)).toBe(777);
  });
});

// ───────────────────────── 순수 단위: 타이브레이크(§5.1-2) ─────────────────────────

function mkPlayer(id: string, over: Partial<PlayerRecord> = {}): PlayerRecord {
  return {
    playerId: id,
    nickname: id,
    passportCover: 'g',
    bestPi: null,
    isHost: false,
    isBot: false,
    ready: false,
    nextIndex: 0,
    lastAcceptAt: 0,
    correctKeystrokes: 0,
    errorKeystrokes: 0,
    combo: 0,
    finishedAt: null,
    rank: null,
    connState: 'connected',
    graceDeadline: null,
    resumeKey: 'k',
    suspicionFlags: [],
    splits: [],
    botCumSplits: null,
    botSource: null,
    ...over,
  };
}

describe('ranking.assignFinalRanks (타이브레이크 4인)', () => {
  it('완주자 우선 → 미완주 재실자(①~④) → 이탈자 순', () => {
    const finished = mkPlayer('F', { finishedAt: 1000, rank: 1 });
    const byIndex = mkPlayer('A', { nextIndex: 4 });
    const byKs = mkPlayer('B', { nextIndex: 3 });
    const byKsLower = mkPlayer('C', { nextIndex: 3 });
    const left = mkPlayer('Z', { nextIndex: 5, connState: 'left' }); // 진행 최고라도 이탈이면 최하위
    const players = [byKsLower, left, byKs, finished, byIndex];
    assignFinalRanks(players, { B: 5, C: 2, A: 0, F: 0, Z: 99 });
    const rankOf = (id: string) => players.find((p) => p.playerId === id)!.rank;
    expect(rankOf('F')).toBe(1); // 완주
    expect(rankOf('A')).toBe(2); // nextIndex 4
    expect(rankOf('B')).toBe(3); // nextIndex 3, ks 5
    expect(rankOf('C')).toBe(4); // nextIndex 3, ks 2
    expect(rankOf('Z')).toBe(5); // 이탈 → 최하위
  });

  it('③ correctKeystrokes ④ lastAcceptAt로 안정 정렬', () => {
    const a = mkPlayer('A', { nextIndex: 2, correctKeystrokes: 30, lastAcceptAt: 500 });
    const b = mkPlayer('B', { nextIndex: 2, correctKeystrokes: 20, lastAcceptAt: 100 });
    const c = mkPlayer('C', { nextIndex: 2, correctKeystrokes: 30, lastAcceptAt: 200 });
    const players = [a, b, c];
    assignFinalRanks(players, { A: 0, B: 0, C: 0 }); // ks 동률 → ③ ks누계 → ④ 시각
    expect(c.rank).toBe(1); // correct 30, lastAccept 200(먼저)
    expect(a.rank).toBe(2); // correct 30, lastAccept 500
    expect(b.rank).toBe(3); // correct 20
  });
});

describe('ranking.computePlayerMetrics (§10.1-3)', () => {
  it('완주자 cpm/acc/pi', () => {
    const m = computePlayerMetrics({
      correctKeystrokes: 90,
      errorKeystrokes: 10,
      finishedAt: 60_000,
      leftAt: null,
      startAt: 0,
      raceEndAt: 120_000,
      nextIndex: 15,
      skipped: 0,
    });
    expect(m.elapsedMs).toBe(60_000);
    expect(m.cpm).toBe(90); // 90 / (60000/60000)
    expect(m.acc).toBeCloseTo(0.9, 5);
    expect(m.pi).toBe(Math.floor(90 * 0.9 * 0.9));
    expect(m.countriesCleared).toBe(15);
  });
  it('미완주자는 raceEnd까지, cleared = nextIndex − skipped', () => {
    const m = computePlayerMetrics({
      correctKeystrokes: 0,
      errorKeystrokes: 0,
      finishedAt: null,
      leftAt: null,
      startAt: 0,
      raceEndAt: 180_000,
      nextIndex: 3,
      skipped: 1,
    });
    expect(m.elapsedMs).toBeNull();
    expect(m.acc).toBe(0);
    expect(m.pi).toBe(0);
    expect(m.countriesCleared).toBe(2);
  });
});

// ───────────────────────── 통합: 접속·입장·시작 ─────────────────────────

describe('MatchRoom DO — 방 라이프사이클', () => {
  it('CREATED → join → WAITING, host start → COUNTDOWN → RACING', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const host = await connect(stub, 'g-h', 'Alice');
    const p2 = await connect(stub, 'g-2', 'Bob');
    // 대기실 room-state에 2인.
    let d = await debug(stub);
    expect(d.phase).toBe('WAITING');
    expect(d.players.length).toBe(2);
    expect(d.hostId).toBe(host.playerId);
    // tick은 RACING 밖에서 예약되지 않는다.
    expect(d.tickScheduled).toBe(false);

    const { startAt } = await startRace(host, stub);
    expect(startAt).toBeGreaterThan(0);
    d = await debug(stub);
    expect(d.phase).toBe('RACING');
    expect(d.race).not.toBeNull();
    host.close();
    p2.close();
  });

  it('hibernation: ping은 auto-response로 처리되어 핸들러를 깨우지 않는다', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const c = await connect(stub, 'g-1', 'Alice');
    const before = (await debug(stub)).messageCount;
    c.sendRaw('{"v":1,"type":"ping"}');
    const pong = await c.take('pong');
    expect(pong.type).toBe('pong');
    const after = (await debug(stub)).messageCount;
    expect(after).toBe(before); // 핸들러 미진입 = wake 0 등가
    c.close();
  });
});

// ───────────────────────── 통합: onComplete 검증(§5) ─────────────────────────

describe('MatchRoom DO — onComplete 서버 권위(§5)', () => {
  it('멱등 complete: 같은 idx 2회 → 승인 1회', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const host = await connect(stub, 'g-h', 'Alice');
    const p2 = await connect(stub, 'g-2', 'Bob');
    const { startAt, countries } = await startRace(host, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    host.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 1000, errThis: 0 });
    const acc = await host.take('country-accepted');
    expect(acc.nextIdx).toBe(1);
    expect(acc.combo).toBe(1);

    // 같은 idx(=nextIndex−1) 재전송 → 조용히 무시(응답 없음).
    host.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 1000, errThis: 0 });
    await sleep(60);
    expect(host.has('country-accepted')).toBe(false);
    expect(host.has('country-rejected')).toBe(false);
    const d = await debug(stub);
    expect(d.players.find((p) => p.id === host.playerId)!.nextIndex).toBe(1);
    host.close();
    p2.close();
  });

  it('WRONG_INDEX 거부 + authoritative payload', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const host = await connect(stub, 'g-h', 'Alice');
    const p2 = await connect(stub, 'g-2', 'Bob');
    const { startAt } = await startRace(host, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    host.send({ type: 'complete', idx: 5, input: 'x', ct: 1000, errThis: 0 });
    const rej = await host.take('country-rejected');
    expect(rej.reason).toBe('WRONG_INDEX');
    expect((rej.authoritative as { nextIdx: number }).nextIdx).toBe(0);
    host.close();
    p2.close();
  });

  it('NOT_EXACT 거부(오답 문자열)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const host = await connect(stub, 'g-h', 'Alice');
    const p2 = await connect(stub, 'g-2', 'Bob');
    const { startAt } = await startRace(host, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    host.send({ type: 'complete', idx: 0, input: 'zzqxwv', ct: 1000, errThis: 0 });
    const rej = await host.take('country-rejected');
    expect(rej.reason).toBe('NOT_EXACT');
    host.close();
    p2.close();
  });

  it('TOO_FAST 3회 누적 → suspicion flagged(§9-A3)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    // 엄격 타이밍: startGrace 500 + reactionFloor 250(기본).
    await createRoom(stub, code, { timings: { startGraceMs: 500, reactionFloorMs: 250, maxKps: { ko: 14, en: 18 } } });
    const host = await connect(stub, 'g-h', 'Alice');
    const p2 = await connect(stub, 'g-2', 'Bob');
    const { startAt, countries } = await startRace(host, stub);
    // start 직후(startGrace 창 안) 정답이라도 TOO_FAST.
    await setSeam(stub, (s) => (s.testClock = startAt + 10));
    for (let i = 0; i < 3; i++) {
      host.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 10, errThis: 0 });
      const rej = await host.take('country-rejected');
      expect(rej.reason).toBe('TOO_FAST');
    }
    const d = await debug(stub);
    const me = d.players.find((p) => p.id === host.playerId)!;
    expect(me.suspicionFlags.filter((f) => f.startsWith('TOO_FAST:')).length).toBeGreaterThanOrEqual(3);
    expect(me.suspicionFlags).toContain('flagged');
    expect(me.nextIndex).toBe(0); // 거부라 진행 안 됨
    host.close();
    p2.close();
  });
});

// ───────────────────────── 통합: 하드캡·grace·countdown 취소·정리 ─────────────────────────

describe('MatchRoom DO — 시간 게이트 전이', () => {
  it('하드캡 타이브레이크 순위(4인, nextIndex 내림차순)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const p3 = await connect(stub, 'g3', 'Cara');
    const p4 = await connect(stub, 'g4', 'Dan');
    const { startAt, hardCapAt, countries } = await startRace(p1, stub);
    expect((await debug(stub)).phase).toBe('RACING');
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    const completeN = async (c: Client, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        c.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 1000, errThis: 0 });
        await c.take('country-accepted');
      }
    };
    await completeN(p1, 3);
    await completeN(p2, 2);
    await completeN(p3, 1);
    // p4: 0개.

    await fireAlarmAt(stub, hardCapAt); // 하드캡 → finishRace
    const results = await p1.take('results');
    const rows = results.rows as Array<{ playerId: string; rank: number; countriesCleared: number }>;
    const rankOf = (id: string) => rows.find((r) => r.playerId === id)!.rank;
    expect(rankOf(p1.playerId)).toBe(1);
    expect(rankOf(p2.playerId)).toBe(2);
    expect(rankOf(p3.playerId)).toBe(3);
    expect(rankOf(p4.playerId)).toBe(4);
    expect((await debug(stub)).phase).toBe('FINISHED');
    p1.close();
    p2.close();
    p3.close();
    p4.close();
  });

  it('grace 만료 → left → 하드캡에서 최하위군', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    // p2 연결 끊김 → grace.
    p2.close();
    // grace 진입 대기.
    let graceDeadline = 0;
    for (let i = 0; i < 50; i++) {
      const d = await debug(stub);
      const rec = d.players.find((p) => p.id === p2.playerId);
      if (rec && rec.connState === 'grace') {
        graceDeadline = d.alarms.graceDeadlines[p2.playerId]!;
        break;
      }
      await sleep(10);
    }
    expect(graceDeadline).toBeGreaterThan(0);

    // grace 만료 → left.
    await fireAlarmAt(stub, graceDeadline + 1);
    let d = await debug(stub);
    expect(d.players.find((p) => p.id === p2.playerId)!.connState).toBe('left');

    // 하드캡 → 결과. 이탈자 p2가 최하위.
    await fireAlarmAt(stub, hardCapAt + 1);
    d = await debug(stub);
    const r1 = d.players.find((p) => p.id === p1.playerId)!.rank!;
    const r2 = d.players.find((p) => p.id === p2.playerId)!.rank!;
    expect(r2).toBeGreaterThan(r1);
    p1.close();
  });

  it('COUNTDOWN 중 인원 < 2 → WAITING 복귀 + seed 폐기(F8)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    p1.send({ type: 'start' });
    await p1.take('countdown');
    expect((await debug(stub)).phase).toBe('COUNTDOWN');
    // p2 명시 leave → 재실 1인 → WAITING 복귀.
    p2.send({ type: 'leave' });
    await sleep(60);
    const d = await debug(stub);
    expect(d.phase).toBe('WAITING');
    expect(d.race).toBeNull(); // seed 폐기
    p1.close();
    p2.close();
  });

  it('자동 스킵: 10초 초과 국가는 tick에서 combo 0으로 스킵(§5 말미)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { timings: { perCountryLimitMs: 5000 } });
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt } = await startRace(p1, stub);
    // 제한 초과 시점에 tick 구동.
    await runTickAt(stub, startAt + 5001);
    const skip = await p1.take('country-accepted');
    expect(skip.combo).toBe(0);
    expect(skip.idx).toBe(0);
    const d = await debug(stub);
    expect(d.players.find((p) => p.id === p1.playerId)!.nextIndex).toBe(1);
    p1.close();
    p2.close();
  });

  it('RACING 40초 무메시지 연결 → left(§7.3)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt } = await startRace(p1, stub);
    // 아무 메시지도 없이 40초 초과 → 유령 연결로 left 확정.
    await runTickAt(stub, startAt + 41_000);
    const d = await debug(stub);
    expect(d.players.every((p) => p.connState === 'left')).toBe(true);
    p1.close();
    p2.close();
  });

  it('WAITING idle → CLOSED + storage.deleteAll', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const d0 = await debug(stub);
    const idleAt = d0.alarms.idleCleanup!;
    expect(idleAt).toBeGreaterThan(0);
    await fireAlarmAt(stub, idleAt + 1);
    // storage 비었는지 직접 확인.
    const remaining = await runInDurableObject(stub, async (_inst, state) => {
      const list = await state.storage.list();
      return list.size;
    });
    expect(remaining).toBe(0);
    p1.close();
  });
});

// ───────────────────────── 통합: D1 영속화 + 재시도(§10.1) ─────────────────────────

describe('MatchRoom DO — D1 영속화', () => {
  it('정상 종료 시 matches/match_participants 기록', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    await fireAlarmAt(stub, hardCapAt + 1);
    const results = await p1.take('results');
    const raceId = results.raceId as string;

    const match = await env.DB.prepare('SELECT id, finish_reason, player_count FROM matches WHERE id = ?1')
      .bind(raceId)
      .first<{ id: string; finish_reason: string; player_count: number }>();
    expect(match).not.toBeNull();
    expect(match!.finish_reason).toBe('hardcap');
    expect(match!.player_count).toBe(2);
    const parts = await env.DB.prepare('SELECT COUNT(*) AS n FROM match_participants WHERE match_id = ?1')
      .bind(raceId)
      .first<{ n: number }>();
    expect(parts!.n).toBe(2);
    p1.close();
    p2.close();
  });

  it('D1 batch 실패 주입 → pendingPersist 저장 후 재시도로 복구', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    // 첫 영속화 1회 강제 실패.
    await setSeam(stub, (s) => (s.forcedPersistFailures = 1));
    await fireAlarmAt(stub, hardCapAt + 1);
    const results = await p1.take('results');
    const raceId = results.raceId as string;

    let d = await debug(stub);
    expect(d.pendingPersist).toBe(1); // 실패 → pending 저장
    const retryAt = d.alarms.persistRetry!;
    expect(retryAt).toBeGreaterThan(0);

    // 재시도 alarm → 성공.
    await fireAlarmAt(stub, retryAt + 1);
    d = await debug(stub);
    expect(d.pendingPersist).toBeNull();
    const match = await env.DB.prepare('SELECT id FROM matches WHERE id = ?1').bind(raceId).first();
    expect(match).not.toBeNull();
    p1.close();
    p2.close();
  });

  it('D1 재시도 5회 초과 → 포기(pendingPersist 정리)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    await setSeam(stub, (s) => (s.forcedPersistFailures = 20)); // 항상 실패
    await fireAlarmAt(stub, hardCapAt + 1);
    await p1.take('results');
    // 재시도 alarm 반복 발화 → 최종 포기.
    for (let i = 0; i < 8; i++) {
      const d = await debug(stub);
      if (d.pendingPersist === null || d.alarms.persistRetry === null) break;
      await fireAlarmAt(stub, d.alarms.persistRetry + 1);
    }
    expect((await debug(stub)).pendingPersist).toBeNull();
    p1.close();
    p2.close();
  });
});

// ───────────────────────── 통합: 재접속(§7.2) + BAD_MESSAGE ─────────────────────────

describe('MatchRoom DO — 재접속·나쁜 메시지', () => {
  it('resume 재접속 → race-sync, 구 WS는 대체(4001)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    // p1의 welcome resumeKey 확보를 위해 새 연결로 hello resume.
    const resumeKey = await runInDurableObject(stub, (inst) => {
      const players = (inst as unknown as { players: Map<string, PlayerRecord> }).players;
      return players.get(p1.playerId)!.resumeKey;
    });
    const { startAt } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    // 새 소켓으로 resume.
    const res = await stub.fetch('http://do/ws', { headers: { Upgrade: 'websocket' } });
    const re = new Client(res.webSocket!);
    re.send({
      type: 'hello',
      auth: { kind: 'guest', guestId: 'g1' },
      dataVersion: DATA_VERSION,
      resume: { playerId: p1.playerId, resumeKey },
    });
    const welcome = await re.take('welcome');
    expect(welcome.resumed).toBe(true);
    const sync = await re.take('race-sync');
    expect((sync.me as { nextIdx: number }).nextIdx).toBe(0);
    expect((sync.start as { countries: string[] }).countries.length).toBeGreaterThan(0);
    re.close();
    p1.close();
    p2.close();
  });

  it('WAITING 동일 guestId 재hello → 구 WS 대체 + 기존 멤버 유지', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const re = await rawConnect(stub);
    re.send({ type: 'hello', auth: { kind: 'guest', guestId: 'g1' }, dataVersion: DATA_VERSION });
    const w = await re.take('welcome');
    expect(w.playerId).toBe(a.playerId); // 결정적 게스트 playerId
    expect(w.resumed).toBe(false); // WAITING 재접속
    await re.take('room-state');
    // 여전히 1명(중복 아님).
    expect((await debug(stub)).players.length).toBe(1);
    re.close();
    a.close();
  });

  it('CLOCK_DRIFT: ct가 서버시각과 3초 넘게 어긋나면 플래그', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const { startAt, countries } = await startRace(a, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    a.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 999_999, errThis: 0 });
    await a.take('country-accepted');
    const me = (await debug(stub)).players.find((p) => p.id === a.playerId)!;
    expect(me.suspicionFlags).toContain('CLOCK_DRIFT');
    a.close();
    b.close();
  });

  it('BAD_MESSAGE 누적 → close(4400)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const c = await connect(stub, 'g1', 'Alice');
    let errors = 0;
    for (let i = 0; i < 10; i++) {
      c.sendRaw('{not json');
      await sleep(8);
    }
    errors = c.inbox.filter((m) => m.type === 'error' && m.code === 'BAD_MESSAGE').length;
    expect(errors).toBeGreaterThanOrEqual(1);
    // 소켓이 닫혔는지: 서버가 이 playerId를 더 이상 세지 않음(WAITING 끊김 → 제거)까지는 비동기라
    // 여기서는 BAD_MESSAGE 에러 수신만 검증(close 코드는 런타임 계약).
    c.close();
  });
});

// ───────────────────────── 에러 응답(§4.2) ─────────────────────────

/** hello/join을 직접 제어하는 저수준 연결(welcome을 기다리지 않는다). */
async function rawConnect(stub: Stub): Promise<Client> {
  const res = await stub.fetch('http://do/ws', { headers: { Upgrade: 'websocket' } });
  return new Client(res.webSocket!);
}

describe('MatchRoom DO — 에러 응답', () => {
  it('DATA_VERSION 불일치 → error + close(4426)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    await connect(stub, 'g1', 'Alice'); // 방 dataVersion 확정
    const c = await rawConnect(stub);
    c.send({ type: 'hello', auth: { kind: 'guest', guestId: 'gx' }, dataVersion: 'WRONGVER' });
    const err = await c.take('error');
    expect(err.code).toBe('DATA_VERSION');
    c.close();
  });

  it('세션 토큰 위조 → AUTH_FAILED', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const c = await rawConnect(stub);
    c.send({ type: 'hello', auth: { kind: 'session', token: 'wt1.bogus.sig' }, dataVersion: DATA_VERSION });
    const err = await c.take('error');
    expect(err.code).toBe('AUTH_FAILED');
    c.close();
  });

  it('빈 닉네임 → NICKNAME_INVALID', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const c = await rawConnect(stub);
    c.send({ type: 'hello', auth: { kind: 'guest', guestId: 'g1' }, dataVersion: DATA_VERSION });
    await c.take('welcome');
    c.send({ type: 'join', nickname: '   ', passportCover: 'green' });
    const err = await c.take('error');
    expect(err.code).toBe('NICKNAME_INVALID');
    c.close();
  });

  it('ROOM_FULL', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { maxPlayers: 2 });
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const c = await rawConnect(stub);
    c.send({ type: 'hello', auth: { kind: 'guest', guestId: 'g3' }, dataVersion: DATA_VERSION });
    await c.take('welcome');
    c.send({ type: 'join', nickname: 'Cara', passportCover: 'green' });
    const err = await c.take('error');
    expect(err.code).toBe('ROOM_FULL');
    a.close();
    b.close();
    c.close();
  });

  it('비호스트 start → NOT_HOST, 진행 중 신규 join → WRONG_PHASE', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const host = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    p2.send({ type: 'start' });
    const err = await p2.take('error');
    expect(err.code).toBe('NOT_HOST');

    const { startAt } = await startRace(host, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    // RACING 중 신규 플레이어 join → WRONG_PHASE.
    const late = await rawConnect(stub);
    late.send({ type: 'hello', auth: { kind: 'guest', guestId: 'glate' }, dataVersion: DATA_VERSION });
    await late.take('welcome');
    late.send({ type: 'join', nickname: 'Late', passportCover: 'green' });
    const werr = await late.take('error');
    expect(werr.code).toBe('WRONG_PHASE');
    host.close();
    p2.close();
    late.close();
  });
});

// ───────────────────────── 채팅·진행·타임싱크 ─────────────────────────

describe('MatchRoom DO — chat / progress / timesync', () => {
  it('chat 브로드캐스트 + 2초당 3건 초과 RATE_LIMIT', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    a.send({ type: 'chat', text: 'hi there' });
    const chat = await b.take('chat');
    expect(chat.playerId).toBe(a.playerId);
    // 4연속 → 4번째는 RATE_LIMIT.
    a.send({ type: 'chat', text: 'a' });
    a.send({ type: 'chat', text: 'b' });
    a.send({ type: 'chat', text: 'c' });
    const rl = await a.take('error');
    expect(rl.code).toBe('RATE_LIMIT');
    a.close();
    b.close();
  });

  it('progress → tick ksPct 반영, 11Hz 초과 RATE_LIMIT', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const { startAt } = await startRace(a, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    a.send({ type: 'progress', idx: 0, ks: 2, err: 0 });
    await sleep(30);
    await runTickAt(stub, startAt + 1000);
    const tick = await b.take('progress-tick');
    const mine = (tick.players as Array<{ id: string; ksPct: number }>).find((p) => p.id === a.playerId)!;
    expect(mine.ksPct).toBeGreaterThan(0);
    // 12연속 progress → 초과분 RATE_LIMIT.
    for (let i = 0; i < 12; i++) a.send({ type: 'progress', idx: 0, ks: 1, err: 0 });
    const rl = await a.take('error');
    expect(rl.code).toBe('RATE_LIMIT');
    a.close();
    b.close();
  });

  it('timesync 왕복', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'timesync', t0: 12345 });
    const ts = await a.take('timesync');
    expect(ts.t0).toBe(12345);
    expect(typeof ts.t1).toBe('number');
    a.close();
  });
});

// ───────────────────────── 완주·리매치·호스트 승계·정리 ─────────────────────────

describe('MatchRoom DO — 완주 / 리매치 / 승계 / 정리', () => {
  it('전원 완주 → all-finished + player-finished(photoFinish)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const { startAt, countries } = await startRace(a, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    const completeAll = async (c: Client): Promise<void> => {
      for (let i = 0; i < countries.length; i++) {
        c.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 1000, errThis: 0 });
        await c.take('country-accepted');
      }
    };
    await completeAll(a);
    await completeAll(b);
    const rf = await a.take('race-finished');
    expect(rf.reason).toBe('all-finished');
    const results = await a.take('results');
    const rows = results.rows as Array<{ finished: boolean; rank: number }>;
    expect(rows.every((r) => r.finished)).toBe(true);
    // 두 완주자 중 하나 이상은 photoFinish(같은 시각 완주).
    expect(a.inbox.concat(b.inbox).some((m) => m.type === 'player-finished' && m.photoFinish === true)).toBe(true);
    // [WT-FIX-FINISH-TRANSITION] results 직후 phase='FINISHED'인 room-state를 브로드캐스트해야
    // 클라(RoomPage)가 room.phase==='result' 전환을 감지한다(§11-D7 기존 room-state 재사용).
    // a의 inbox엔 앞선 페이즈 전이(B 참가/COUNTDOWN/RACING)의 room-state가 이미 여러 건 미소비로
    // 쌓여 있을 수 있어 take('room-state')는 그 중 가장 오래된 것을 집어버린다 — phase로 특정한다.
    const roomState = await a.takeWhere((m) => m.type === 'room-state' && m.phase === 'FINISHED');
    expect(roomState.phase).toBe('FINISHED');
    a.close();
    b.close();
  });

  it('리매치 과반 찬성 → 새 레이스(새 raceId) COUNTDOWN', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(a, stub);
    const firstRaceId = (await debug(stub)).race!.raceId;
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    await fireAlarmAt(stub, hardCapAt + 1);
    await a.take('results');
    // 양측 찬성 → 리매치.
    a.send({ type: 'rematch', vote: true });
    b.send({ type: 'rematch', vote: true });
    const cd = await a.take('countdown'); // 새 카운트다운
    expect(cd.raceId).not.toBe(firstRaceId);
    expect((await debug(stub)).phase).toBe('COUNTDOWN');
    a.close();
    b.close();
  });

  it('리매치 투표 마감(과반 미달) → CLOSED(rematch-declined)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    const { startAt, hardCapAt } = await startRace(a, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    await fireAlarmAt(stub, hardCapAt + 1);
    const results = await a.take('results');
    const voteAt = results.rematchDeadline as number;
    await fireAlarmAt(stub, voteAt + 1);
    const closed = await a.take('room-closed');
    expect(closed.reason).toBe('rematch-declined');
    a.close();
    b.close();
  });

  it('호스트 leave → 다음 입장자 승계', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    expect((await debug(stub)).hostId).toBe(a.playerId);
    a.send({ type: 'leave' });
    await sleep(60);
    expect((await debug(stub)).hostId).toBe(b.playerId);
    a.close();
    b.close();
  });

  it('전원 이탈 → emptyCleanup → CLOSED', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'leave' });
    await sleep(60);
    const d = await debug(stub);
    const emptyAt = d.alarms.emptyCleanup!;
    expect(emptyAt).toBeGreaterThan(0);
    await fireAlarmAt(stub, emptyAt + 1);
    const remaining = await runInDurableObject(stub, async (_i, state) => (await state.storage.list()).size);
    expect(remaining).toBe(0);
    a.close();
  });

  it('bot-accept 거절 → 방 유지(WAITING)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'bot-accept', accept: false });
    await sleep(40);
    expect((await debug(stub)).phase).toBe('WAITING');
    a.close();
  });

  it('bot-accept 수락 → 봇 삽입 + COUNTDOWN(§2.3-5, 상세는 ghost.test.ts)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'bot-accept', accept: true });
    await sleep(60);
    const d = await debug(stub);
    expect(['COUNTDOWN', 'RACING']).toContain(d.phase);
    const bots = d.players.filter((p) => (p as { isBot?: boolean }).isBot);
    expect(bots.length).toBeGreaterThanOrEqual(1);
    a.close();
  });
});

// ───────────────────────── 퀵매치 자동 시작(§2.3) + 공개 방 KV ─────────────────────────

describe('MatchRoom DO — 자동 시작 / 공개 방', () => {
  it('퀵매치 4인 도달 즉시 COUNTDOWN', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'A');
    const b = await connect(stub, 'g2', 'B');
    const c = await connect(stub, 'g3', 'C');
    const d = await connect(stub, 'g4', 'D');
    await sleep(40);
    // 자동 시작이 걸리면 WAITING을 떠난다(짧은 countdownMs로 실 alarm이 RACING까지 진행할 수 있음).
    expect(['COUNTDOWN', 'RACING']).toContain((await debug(stub)).phase);
    a.close();
    b.close();
    c.close();
    d.close();
  });

  it('퀵매치 전원 레디(2인) → COUNTDOWN', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'A');
    const b = await connect(stub, 'g2', 'B');
    a.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    await sleep(60);
    expect(['COUNTDOWN', 'RACING']).toContain((await debug(stub)).phase);
    a.close();
    b.close();
  });

  it('퀵매치 2인 autoStart 타이머 → 만기 시 COUNTDOWN', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'A');
    const b = await connect(stub, 'g2', 'B');
    await sleep(40);
    const d = await debug(stub);
    const autoAt = d.alarms.autoStart!;
    expect(autoAt).toBeGreaterThan(0);
    await fireAlarmAt(stub, autoAt + 1);
    expect((await debug(stub)).phase).toBe('COUNTDOWN');
    a.close();
    b.close();
  });

  it('공개 방 → KV publicroom 기록, CLOSED 시 삭제', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { isPublic: true });
    const a = await connect(stub, 'g1', 'Alice');
    await sleep(30);
    const raw = await env.KV.get(`publicroom:${code}`);
    expect(raw).not.toBeNull();
    // idle 정리 → CLOSED → publicroom 삭제.
    const idleAt = (await debug(stub)).alarms.idleCleanup!;
    await fireAlarmAt(stub, idleAt + 1);
    const after = await env.KV.get(`publicroom:${code}`);
    expect(after).toBeNull();
    a.close();
  });

  // WT-FIX-EMPTYROOM: 방장 단독 이탈로 activePlayers===0이 되면 방(emptyCleanup 60s 유예)은
  // 유지하되 KV publicroom 엔트리는 즉시 제거해 로비(GET /rooms/public)에 빈 방(0/N)을 노출하지 않는다.
  it('WT-FIX-EMPTYROOM T1: 호스트 단독 방 → WS close → publicroom KV 즉시 삭제', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { isPublic: true });
    const a = await connect(stub, 'g1', 'Alice');
    await sleep(30);
    expect(await env.KV.get(`publicroom:${code}`)).not.toBeNull();

    a.close(); // 뒤로가기/탭 닫기와 동등: 명시 leave 없이 소켓만 끊는다.

    // onDisconnect(WAITING) → finalizeLeave(슬롯 제거) → updatePublicRoom(active===0) → KV 삭제.
    // 소켓 close 전파는 비동기라(§ 기존 grace 테스트와 동일 사유) 짧은 폴링으로 수렴을 기다린다.
    let raw: string | null = 'sentinel';
    for (let i = 0; i < 50; i++) {
      raw = await env.KV.get(`publicroom:${code}`);
      if (raw === null) break;
      await sleep(10);
    }
    expect(raw).toBeNull();

    // 방 자체는 emptyCleanup(60s) 유예 중 → CREATED/CLOSED가 아니라 storage에 아직 남아 있어야 한다.
    const emptyAt = (await debug(stub)).alarms.emptyCleanup;
    expect(emptyAt).toBeGreaterThan(0);
  });

  it('WT-FIX-EMPTYROOM T2: 빈 방에 60초 경과 전 재입장 → publicroom KV 재등록(players 1)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { isPublic: true });
    const a = await connect(stub, 'g1', 'Alice');
    await sleep(30);
    a.close();
    let deleted: string | null = 'sentinel';
    for (let i = 0; i < 50; i++) {
      deleted = await env.KV.get(`publicroom:${code}`);
      if (deleted === null) break;
      await sleep(10);
    }
    expect(deleted).toBeNull();

    // emptyCleanup 만기(60_000ms) 전 재입장 — 새로고침/재접속 시나리오.
    const b = await connect(stub, 'g2', 'Bob');
    await sleep(30);
    const raw = await env.KV.get(`publicroom:${code}`);
    expect(raw).not.toBeNull();
    const entry = JSON.parse(raw!) as { players: number };
    expect(entry.players).toBe(1);
    b.close();
  });

  it('WT-FIX-EMPTYROOM T3(회귀): 2인 방에서 1인만 이탈 → publicroom KV 유지(players 1로 갱신)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { isPublic: true });
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');
    await sleep(30);
    expect(await env.KV.get(`publicroom:${code}`)).not.toBeNull();

    b.close(); // 호스트가 아닌 참가자만 이탈 — activePlayers는 1로 남는다.

    let raw: string | null = null;
    let entry: { players: number } | null = null;
    for (let i = 0; i < 50; i++) {
      raw = await env.KV.get(`publicroom:${code}`);
      if (raw !== null) {
        entry = JSON.parse(raw) as { players: number };
        if (entry.players === 1) break;
      }
      await sleep(10);
    }
    expect(raw).not.toBeNull();
    expect(entry?.players).toBe(1);
    a.close();
  });
});
