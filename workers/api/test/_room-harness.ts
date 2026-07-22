// spec: WT-M4-05 — ghost.test.ts / reconnect.test.ts 공용 MatchRoom DO 하네스.
// match-room.test.ts의 인라인 헬퍼와 동일 계약을 export로 노출한다(중복 제거). `.test.ts`가
// 아니므로 vitest include 글롭에 잡히지 않는다(suite 미수집 — §0.4-7 거짓 그린 방지와 무관).
//
// 시간 게이트 전이는 주입 클록(testClock)을 runInDurableObject로 제어해 벽시계 대기 없이
// 결정적으로 구동한다(세션 어댑테이션 §2 "자동화 등가물").
import { env, runInDurableObject } from 'cloudflare:test';
import { COUNTRIES, type Country } from '@wt/data';

export const DATA_VERSION = 'testver1';

const BY_ID = new Map<string, Country>(COUNTRIES.map((c) => [c.id, c]));

/** 국가 id → en 첫 accepted 입력(테스트 complete 페이로드용). */
export function inputFor(countryId: string): string {
  const c = BY_ID.get(countryId);
  if (!c) throw new Error('unknown country ' + countryId);
  return c.acceptedInputsEn[0]!;
}

export interface Seam {
  testClock: number | null;
  forcedPersistFailures: number;
  alarm(): Promise<void>;
  runTick(): Promise<void>;
}

export interface DebugPlayer {
  id: string;
  connState: string;
  nextIndex: number;
  combo: number;
  rank: number | null;
  finishedAt: number | null;
  correctKeystrokes: number;
  errorKeystrokes: number;
  suspicionFlags: string[];
  isBot: boolean;
  nickname: string;
  botScheduleLen: number | null;
  splitsLen: number;
}

export interface DebugState {
  phase: string;
  messageCount: number;
  tickScheduled: boolean;
  hostId: string | null;
  players: DebugPlayer[];
  race: { raceId: string; seed: string; len: number } | null;
  alarms: {
    autoStart: number | null;
    botOffer: number | null;
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

export interface AnyMsg {
  type: string;
  [k: string]: unknown;
}

export type Stub = DurableObjectStub;

// vitest는 테스트 파일마다 이 모듈을 별도 인스턴스로 로드하므로(roomSeq가 파일별로 0에서 시작),
// 로드 시각 랜덤 프리픽스를 붙여 파일 간 방 코드 충돌(→ 같은 DO 공유 → 상태 바레)을 막는다.
const CODE_PREFIX = 'GH' + Math.random().toString(36).slice(2, 7).toUpperCase();
let roomSeq = 0;
export function newRoomCode(): string {
  roomSeq += 1;
  return CODE_PREFIX + roomSeq.toString().padStart(4, '0');
}

export function stubFor(code: string): Stub {
  const id = env.MATCH_ROOM.idFromName('room:' + code);
  return env.MATCH_ROOM.get(id) as unknown as Stub;
}

export interface Timings {
  [k: string]: unknown;
}

export async function createRoom(
  stub: Stub,
  code: string,
  opts: {
    lang?: 'ko' | 'en';
    quickMatch?: boolean;
    isPublic?: boolean;
    maxPlayers?: number;
    timings?: Timings;
  } = {},
): Promise<void> {
  const timings: Timings = {
    countdownMs: 20,
    hardcapMs: 180_000,
    graceMs: 15_000,
    autostartMs: 15_000,
    botOfferMs: 60_000,
    rematchVoteMs: 30_000,
    createdCleanupMs: 60_000,
    idleCleanupMs: 600_000,
    emptyCleanupMs: 60_000,
    perCountryLimitMs: 3_600_000,
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
  if (res.status !== 200) throw new Error('createRoom failed: ' + res.status);
}

export async function debug(stub: Stub): Promise<DebugState> {
  const res = await stub.fetch('http://do/internal/debug');
  return (await res.json()) as DebugState;
}

export async function setSeam(stub: Stub, fn: (s: Seam) => void): Promise<void> {
  await runInDurableObject(stub, (inst) => {
    fn(inst as unknown as Seam);
  });
}

export async function fireAlarmAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as Seam;
    s.testClock = t;
    await s.alarm();
  });
}

export async function runTickAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as Seam;
    s.testClock = t;
    await s.runTick();
  });
}

/** DO 인스턴스에 임의 조작(env 바인딩 스파이 주입 등)을 가한다. */
export async function withInstance<T>(stub: Stub, fn: (inst: unknown) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stub, (inst) => fn(inst));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Client {
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

export async function rawConnect(stub: Stub): Promise<Client> {
  const res = await stub.fetch('http://do/ws', { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket in upgrade response');
  return new Client(ws);
}

export async function connect(stub: Stub, guestId: string, nickname: string): Promise<Client> {
  const c = await rawConnect(stub);
  c.send({ type: 'hello', auth: { kind: 'guest', guestId }, dataVersion: DATA_VERSION });
  const welcome = await c.take('welcome');
  c.playerId = welcome.playerId as string;
  c.send({ type: 'join', nickname, passportCover: 'green' });
  await c.take('room-state');
  return c;
}

/** 호스트 start → COUNTDOWN → (raceStart alarm) → RACING. startAt/hardCapAt/countries 반환. */
export async function startRace(
  host: Client,
  stub: Stub,
): Promise<{ startAt: number; hardCapAt: number; raceId: string; countries: string[] }> {
  host.send({ type: 'start' });
  const cd = await host.take('countdown');
  const startMsg = await host.take('start');
  const startAt = cd.startAt as number;
  await fireAlarmAt(stub, startAt); // raceStart 만기 → RACING
  return {
    startAt,
    hardCapAt: startMsg.hardCapAt as number,
    raceId: startMsg.raceId as string,
    countries: startMsg.countries as string[],
  };
}
