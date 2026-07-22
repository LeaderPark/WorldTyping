// spec: docs/05 §2.3(퀵매치 흐름·좌석 배정/회수·자동 시작)·§2.2(방 코드 충돌 재생성)·§13-F6,
//       docs/00 §11-D8/D17/D23 + WT-M4-02 [완료 조건].
// Matchmaker DO 단위/통합(vitest-pool-workers). 좌석 회계·30초 회수·F6 신선도는 DO의 주입
// 클록(testClock)/코드생성기(codeGen)를 runInDurableObject로 제어해 결정적으로 구동한다
// (세션 어댑테이션 §2 "자동화 등가물"). 각 테스트는 유니크 mm/room 이름으로 자체 격리한다
// (do.config는 isolatedStorage=false).
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

type Stub = DurableObjectStub;

interface MmSeam {
  testClock: number | null;
  codeGen: (() => string) | null;
  alarm(): Promise<void>;
}

interface DebugState {
  openRoom: { roomCode: string; maxPlayers: number; fillTarget: number } | null;
  reservationCount: number;
  reservations: Array<{ key: string; roomCode: string; playerId: string; expiresAt: number }>;
}

let seq = 0;
function mmStub(): { stub: Stub; name: string } {
  seq += 1;
  const name = `mm-test-${seq}`;
  const id = env.MATCHMAKER.idFromName(name);
  return { stub: env.MATCHMAKER.get(id) as unknown as Stub, name };
}

function roomStub(code: string): Stub {
  const id = env.MATCH_ROOM.idFromName('room:' + code);
  return env.MATCH_ROOM.get(id) as unknown as Stub;
}

async function setSeam(stub: Stub, fn: (s: MmSeam) => void): Promise<void> {
  await runInDurableObject(stub, (inst) => {
    fn(inst as unknown as MmSeam);
  });
}

async function fireAlarmAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as MmSeam;
    s.testClock = t;
    await s.alarm();
  });
}

interface QuickRes {
  roomCode: string;
  ticket: string;
  wsUrl: string;
  mode: string;
  lang: string;
  retryOnWrongPhase: boolean;
}

async function quick(stub: Stub, playerId: string, lang: 'ko' | 'en' = 'en'): Promise<QuickRes> {
  const res = await stub.fetch('http://mm/internal/quick', {
    method: 'POST',
    body: JSON.stringify({ lang, playerId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as QuickRes;
}

async function cancel(stub: Stub, ticket: string, playerId: string): Promise<{ ok: boolean }> {
  const res = await stub.fetch('http://mm/internal/cancel', {
    method: 'POST',
    body: JSON.stringify({ ticket, playerId }),
  });
  return (await res.json()) as { ok: boolean };
}

async function debug(stub: Stub): Promise<DebugState> {
  const res = await stub.fetch('http://mm/internal/debug');
  return (await res.json()) as DebugState;
}

// ───────────────────────── 좌석 배정 (§2.3) ─────────────────────────

describe('Matchmaker 좌석 배정', () => {
  it('요청자 4인은 같은 방에 모이고, fillTarget 도달 후 5번째는 새 방을 받는다', async () => {
    const { stub } = mmStub();
    const r1 = await quick(stub, 'p1');
    const r2 = await quick(stub, 'p2');
    const r3 = await quick(stub, 'p3');
    const r4 = await quick(stub, 'p4');
    expect(r2.roomCode).toBe(r1.roomCode);
    expect(r3.roomCode).toBe(r1.roomCode);
    expect(r4.roomCode).toBe(r1.roomCode);
    const r5 = await quick(stub, 'p5');
    expect(r5.roomCode).not.toBe(r1.roomCode); // 4인 봉인 → 새 방

    const d = await debug(stub);
    expect(d.openRoom?.roomCode).toBe(r5.roomCode); // 새 방이 열린 방
  });

  it('응답 계약: race-mixed 모드 + wsUrl 경로 + F6 재요청 플래그', async () => {
    const { stub } = mmStub();
    const r = await quick(stub, 'p1', 'ko');
    expect(r.mode).toBe('race-mixed');
    expect(r.lang).toBe('ko');
    expect(r.wsUrl).toBe(`/ws/room/${r.roomCode}`);
    expect(r.retryOnWrongPhase).toBe(true);
    expect(r.ticket.startsWith('wt1.')).toBe(true);
  });
});

// ───────────────────────── 취소 (§2.3 큐 이탈) ─────────────────────────

describe('Matchmaker 취소', () => {
  it('취소하면 예약(좌석)이 풀에서 제거된다', async () => {
    const { stub } = mmStub();
    const r = await quick(stub, 'p1');
    expect((await debug(stub)).reservationCount).toBe(1);
    const out = await cancel(stub, r.ticket, 'p1');
    expect(out.ok).toBe(true);
    expect((await debug(stub)).reservationCount).toBe(0);
  });

  it('타인 pid의 취소 요청은 좌석을 제거하지 않는다', async () => {
    const { stub } = mmStub();
    const r = await quick(stub, 'p1');
    const out = await cancel(stub, r.ticket, 'someone-else');
    expect(out.ok).toBe(false);
    expect((await debug(stub)).reservationCount).toBe(1);
  });
});

// ───────────────────────── 좌석 30초 회수 (§2.3) ─────────────────────────

describe('Matchmaker 좌석 30초 회수', () => {
  it('WS join이 30초 내 오지 않은 예약은 alarm에서 회수된다', async () => {
    const { stub } = mmStub();
    const T = 1_000_000;
    await setSeam(stub, (s) => {
      s.testClock = T;
    });
    await quick(stub, 'p1'); // expiresAt = T + 30_000
    expect((await debug(stub)).reservationCount).toBe(1);

    await fireAlarmAt(stub, T + 30_001); // 만료 → 회수
    expect((await debug(stub)).reservationCount).toBe(0);
  });
});

// ───────────────────────── 방 코드 충돌 재생성 (§2.2) ─────────────────────────

describe('Matchmaker 방 코드 충돌', () => {
  it('이미 활성인 코드를 만나면 재생성한다', async () => {
    // 먼저 코드 XCOLL1를 활성 방으로 점유한다(직접 internal/create).
    const taken = 'XKF3QW';
    const free = 'YMP7RT';
    const takenRoom = roomStub(taken);
    const created = await takenRoom.fetch('http://do/internal/create', {
      method: 'POST',
      body: JSON.stringify({
        config: { roomCode: taken, lang: 'en', mode: 'race-mixed', poolParam: null, maxPlayers: 8, isPublic: false, quickMatch: true },
      }),
    });
    expect(created.status).toBe(200);

    const { stub } = mmStub();
    // codeGen이 먼저 taken(충돌) → 다음 free를 내도록 주입.
    await setSeam(stub, (s) => {
      const seqCodes = [taken, free];
      let i = 0;
      s.codeGen = () => seqCodes[Math.min(i++, seqCodes.length - 1)]!;
    });
    const r = await quick(stub, 'p1');
    expect(r.roomCode).toBe(free); // 충돌 회피 후 빈 코드 채택
  });
});

// ───────────────────────── F6: 이미 시작된 openRoom 신선도 (§13-F6) ─────────────────────────

describe('Matchmaker F6 (열린 방이 이미 시작됨)', () => {
  it('openRoom이 RACING이면 폐기하고 새 방을 발급한다', async () => {
    const { stub } = mmStub();
    const r1 = await quick(stub, 'p1'); // 방 R 생성
    const R = roomStub(r1.roomCode);

    // R을 2인 입장 → 호스트 start → COUNTDOWN → raceStart alarm → RACING으로 몰아간다.
    const c1 = await connectRoom(R, 'g1', 'p1n');
    const c2 = await connectRoom(R, 'g2', 'p2n');
    c1.send({ type: 'start' });
    const cd = await c1.take('countdown');
    await fireRoomAlarmAt(R, cd.startAt as number); // raceStart 만기 → RACING
    c1.close();
    c2.close();

    const r2 = await quick(stub, 'p9'); // openRoom(R) stale → 새 방
    expect(r2.roomCode).not.toBe(r1.roomCode);
  });
});

// ───────────────────────── 방 WS 헬퍼(F6용 최소 구현) ─────────────────────────

interface AnyMsg {
  type: string;
  [k: string]: unknown;
}
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

class RoomClient {
  readonly ws: WebSocket;
  readonly inbox: AnyMsg[] = [];
  seq = 0;
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
      if (Date.now() - start > timeoutMs) throw new Error(`timeout '${type}'`);
      await sleep(4);
    }
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connectRoom(stub: Stub, guestId: string, nickname: string): Promise<RoomClient> {
  const res = await stub.fetch('http://do/ws', { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket');
  const c = new RoomClient(ws);
  c.send({ type: 'hello', auth: { kind: 'guest', guestId }, dataVersion: 'testver1' });
  await c.take('welcome');
  c.send({ type: 'join', nickname, passportCover: 'green' });
  await c.take('room-state');
  return c;
}

async function fireRoomAlarmAt(stub: Stub, t: number): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    const s = inst as unknown as { testClock: number | null; alarm(): Promise<void> };
    s.testClock = t;
    await s.alarm();
  });
}
