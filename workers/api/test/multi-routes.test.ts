// spec: docs/05 §2.3(퀵매치 REST)·§2.4(방 생성/참가/공개 목록)·§13-F6, docs/04 §5.3(WS 티켓),
//       docs/00 §11-D8(REST 퀵매치 + /ws/room/:code)·D17·D23 + WT-M4-02 [완료 조건].
// multi.ts 라우트 + index.ts /ws/room/:code 게이트웨이 통합(vitest-pool-workers, SELF). 방 상태
// (만석/진행중)는 env.MATCH_ROOM 스텁으로 WS를 직접 붙여 구동한다. do.config(isolatedStorage=false)
// 에서 실행 — 각 방은 /rooms가 발급한 유니크 코드로 자체 격리된다.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { signWsTicket } from '@wt/shared';
import { KV_KEYS } from '../src/lib/kv-keys';

const BASE = 'http://local/api/v1';
const RUN_SECRET = 'test-run-secret'; // vitest.do.config.ts miniflare 바인딩과 동일

type Stub = DurableObjectStub;

// WT-AUTH-02(§11-D68-①): 멀티 REST 4종은 requireAccountAuth로 게이팅됐다 — 게스트 세션은 401
// LOGIN_REQUIRED다. 따라서 정상 경로는 **계정** 세션이 필요하다. 계정 세션은 dev 심(/auth/dev,
// §11-D68-⑩)으로만 발급 가능하고 레이트리밋이 없다(auth RL은 /auth/google 전용). 다만 rooms(create)
// 레이트리밋(pid당 60초 5회)은 계정 pid에도 걸리므로, 서로 다른 sub로 만든 계정 토큰 8개를 라운드
// 로빈해 방 생성 부하를 분산한다(테스트 요청은 CF-Connecting-IP가 없어 IP 스코프는 공유). 게스트
// 토큰 1개는 로그인 게이팅(401) 검증에만 쓴다.
const POOL_SIZE = 8;
const tokens: string[] = [];
let guestTok = '';
let rr = 0;
function tok(): string {
  const t = tokens[rr % tokens.length]!;
  rr += 1;
  return t;
}

/** 계정 세션(dev 심, 고유 sub) — RL 없음. */
async function bootstrapAccount(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub: 'multi-acct-' + crypto.randomUUID() }),
  });
  return ((await res.json()) as { token: string }).token;
}

/** 게스트 세션(비계정) — 로그인 게이팅(401 LOGIN_REQUIRED) 검증 전용. */
async function bootstrapGuest(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  return ((await res.json()) as { token: string }).token;
}

beforeAll(async () => {
  for (let i = 0; i < POOL_SIZE; i += 1) tokens.push(await bootstrapAccount());
  guestTok = await bootstrapGuest();
});

function authed(token: string, body: unknown, method = 'POST') {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

interface Grant {
  roomCode: string;
  wsUrl: string;
  ticket: string;
  mode: string;
  lang: string;
  title: string | null;
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

// ───────────────────────── 로그인 게이팅 (§11-D68-①) ─────────────────────────

describe('멀티 REST 로그인 게이팅 — 게스트는 401 LOGIN_REQUIRED', () => {
  it('POST /rooms (guest) → 401 LOGIN_REQUIRED', async () => {
    const res = await SELF.fetch(`${BASE}/rooms`, authed(guestTok, { lang: 'ko' }));
    expect(res.status).toBe(401);
    expect(errCode(await res.json())).toBe('LOGIN_REQUIRED');
  });

  it('POST /rooms/:code/join (guest) → 401 LOGIN_REQUIRED', async () => {
    const res = await SELF.fetch(`${BASE}/rooms/ABCDEF/join`, authed(guestTok, {}));
    expect(res.status).toBe(401);
    expect(errCode(await res.json())).toBe('LOGIN_REQUIRED');
  });

  it('POST /match/quick (guest) → 401 LOGIN_REQUIRED', async () => {
    const res = await SELF.fetch(`${BASE}/match/quick`, authed(guestTok, { lang: 'en' }));
    expect(res.status).toBe(401);
    expect(errCode(await res.json())).toBe('LOGIN_REQUIRED');
  });

  it('DELETE /match/quick (guest) → 401 LOGIN_REQUIRED', async () => {
    const res = await SELF.fetch(`${BASE}/match/quick`, authed(guestTok, { ticket: 'x' }, 'DELETE'));
    expect(res.status).toBe(401);
    expect(errCode(await res.json())).toBe('LOGIN_REQUIRED');
  });
});

// ───────────────────────── 퀵매치 (§2.3) ─────────────────────────

describe('POST /api/v1/match/quick', () => {
  it('401 without a session bearer', async () => {
    const res = await SELF.fetch(`${BASE}/match/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'en' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns a room + ticket + wsUrl contract', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/match/quick`, authed(token, { lang: 'en' }));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Grant & { retryOnWrongPhase: boolean };
    expect(g.mode).toBe('race-mixed');
    expect(g.wsUrl).toBe(`/ws/room/${g.roomCode}`);
    expect(g.ticket.startsWith('wt1.')).toBe(true);
    expect(g.retryOnWrongPhase).toBe(true);
  });

  it('400 on invalid lang', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/match/quick`, authed(token, { lang: 'fr' }));
    expect(res.status).toBe(400);
  });

  it('DELETE cancels the assigned seat', async () => {
    const token = tok();
    const g = (await (await SELF.fetch(`${BASE}/match/quick`, authed(token, { lang: 'en' }))).json()) as Grant;
    const res = await SELF.fetch(`${BASE}/match/quick`, authed(token, { ticket: g.ticket }, 'DELETE'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ───────────────────────── 방 생성/참가 (§2.4) ─────────────────────────

describe('POST /api/v1/rooms', () => {
  it('401 without bearer', async () => {
    const res = await SELF.fetch(`${BASE}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'ko' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a private room and returns a grant', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko', maxPlayers: 4 }));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Grant & { maxPlayers: number; isPublic: boolean };
    expect(g.lang).toBe('ko');
    expect(g.maxPlayers).toBe(4);
    expect(g.isPublic).toBe(false);
    expect(g.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });

  it('rejects a reserved (non race-mixed) mode', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko', mode: 'race-tier' }));
    expect(res.status).toBe(400);
  });

  it('accepts a clean title and echoes it in the grant (§11-D68-⑧)', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko', title: '초보 환영 방' }));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Grant;
    expect(g.title).toBe('초보 환영 방');
  });

  it('omitted title → grant.title is null', async () => {
    const token = tok();
    const g = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko' }))).json()) as Grant;
    expect(g.title).toBeNull();
  });

  it('400 INVALID_TITLE for a title violating the moderation filter (reserved prefix)', async () => {
    const token = tok();
    // 'admin*' 예약어 프리픽스 → moderation evaluateText.blocked(닉네임 필터와 동일 파이프라인).
    const res = await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko', title: 'admin 전용방' }));
    expect(res.status).toBe(400);
    expect(errCode(await res.json())).toBe('INVALID_TITLE');
  });
});

describe('POST /api/v1/rooms/:code/join', () => {
  it('404 for a well-formed but nonexistent code', async () => {
    const token = tok();
    const res = await SELF.fetch(`${BASE}/rooms/ZZZZZZ/join`, authed(token, {}));
    expect(res.status).toBe(404);
  });

  it('joins an existing waiting room', async () => {
    const token = tok();
    const created = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko' }))).json()) as Grant;
    const res = await SELF.fetch(`${BASE}/rooms/${created.roomCode}/join`, authed(token, {}));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Grant;
    expect(g.roomCode).toBe(created.roomCode);
    expect(g.ticket.startsWith('wt1.')).toBe(true);
  });

  it('409 LANG_MISMATCH when requested lang differs from the room', async () => {
    const token = tok();
    const created = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko' }))).json()) as Grant;
    const res = await SELF.fetch(`${BASE}/rooms/${created.roomCode}/join`, authed(token, { lang: 'en' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LANG_MISMATCH');
  });

  it('409 ROOM_FULL when the room is at capacity', async () => {
    const token = tok();
    const created = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'en', maxPlayers: 2 }))).json()) as Grant;
    const room = roomStub(created.roomCode);
    const c1 = await connectRoom(room, 'gf1', 'pf1');
    const c2 = await connectRoom(room, 'gf2', 'pf2');
    const res = await SELF.fetch(`${BASE}/rooms/${created.roomCode}/join`, authed(token, {}));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ROOM_FULL');
    c1.close();
    c2.close();
  });

  it('409 ROOM_IN_PROGRESS once the race has started', async () => {
    const token = tok();
    const created = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'en' }))).json()) as Grant;
    const room = roomStub(created.roomCode);
    const c1 = await connectRoom(room, 'gp1', 'pp1');
    const c2 = await connectRoom(room, 'gp2', 'pp2');
    c1.send({ type: 'start' });
    const cd = await c1.take('countdown');
    await fireRoomAlarmAt(room, cd.startAt as number); // → RACING
    const res = await SELF.fetch(`${BASE}/rooms/${created.roomCode}/join`, authed(token, {}));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ROOM_IN_PROGRESS');
    c1.close();
    c2.close();
  });
});

// ───────────────────────── 공개 방 목록 (§2.4) ─────────────────────────

describe('GET /api/v1/rooms/public', () => {
  it('lists a public room after a player enters it', async () => {
    const token = tok();
    const created = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'ko', isPublic: true }))).json()) as Grant;
    const room = roomStub(created.roomCode);
    const c1 = await connectRoom(room, 'gpub', 'ppub'); // WAITING 진입 → KV publicroom:{code} 기록
    await env.KV.delete(KV_KEYS.publicRoomsListCache); // 이전 테스트의 3초 캐시 무시

    const res = await SELF.fetch(`${BASE}/rooms/public`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rooms: Array<{ code: string; lang: string }> };
    expect(body.rooms.some((r) => r.code === created.roomCode)).toBe(true);
    c1.close();
  });

  it('공개 방만 상세로 노출하고 비공개는 counts로만 집계한다(§11-D68-⑧)', async () => {
    const pub = (await (
      await SELF.fetch(`${BASE}/rooms`, authed(tok(), { lang: 'ko', isPublic: true, title: '공개 레이스' }))
    ).json()) as Grant;
    const priv = (await (
      await SELF.fetch(`${BASE}/rooms`, authed(tok(), { lang: 'en', isPublic: false }))
    ).json()) as Grant;
    // 두 방 모두 첫 입장 → WAITING → KV 레지스트리 기록(공개·비공개 모두 등록).
    const c1 = await connectRoom(roomStub(pub.roomCode), 'gcp', 'pcp');
    const c2 = await connectRoom(roomStub(priv.roomCode), 'gcv', 'pcv');
    await env.KV.delete(KV_KEYS.publicRoomsListCache); // 3초 캐시 무시하고 재조립

    const res = await SELF.fetch(`${BASE}/rooms/public`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rooms: Array<{ code: string; lang: string; players: number; maxPlayers: number; title: string | null; phase: string; hostCover: string | null }>;
      counts: { public: number; private: number };
    };

    // 공개 방은 상세 카드로 노출(제목·phase·hostCover 포함).
    const card = body.rooms.find((r) => r.code === pub.roomCode);
    expect(card).toBeDefined();
    expect(card!.title).toBe('공개 레이스');
    expect(card!.phase).toBe('WAITING'); // 레지스트리는 입장 가능 방만 → 항상 WAITING
    expect(card!.hostCover).toBe('green'); // connectRoom join의 passportCover
    expect(card!.players).toBe(1);

    // 비공개 방은 상세에 절대 나오지 않는다.
    expect(body.rooms.some((r) => r.code === priv.roomCode)).toBe(false);

    // counts는 공개/비공개 모두 최소 1(같은 파일의 다른 방도 누적될 수 있어 정확값 대신 하한).
    expect(body.counts.public).toBeGreaterThanOrEqual(1);
    expect(body.counts.private).toBeGreaterThanOrEqual(1);

    c1.close();
    c2.close();
  });
});

// ───────────────────────── /ws/room/:code 티켓 게이트웨이 (§5.3, §11-D8) ─────────────────────────

function wsFetch(path: string): Promise<Response> {
  return SELF.fetch(`http://local${path}`, { headers: { Upgrade: 'websocket' } });
}

describe('GET /ws/room/:code (WS 티켓 게이트웨이)', () => {
  it('401 when the ticket is missing', async () => {
    const res = await wsFetch('/ws/room/ABCDEF');
    expect(res.status).toBe(401);
  });

  it('401 when the ticket signature is garbage', async () => {
    const res = await wsFetch('/ws/room/ABCDEF?ticket=wt1.bogus.sig');
    expect(res.status).toBe(401);
  });

  it('401 when the ticket is for a different room', async () => {
    const wrong = await signWsTicket(RUN_SECRET, 'p1', 'OTHER1');
    const res = await wsFetch(`/ws/room/ABCDEF?ticket=${wrong}`);
    expect(res.status).toBe(401);
  });

  it('101 upgrade with a valid room ticket, and single-use rejects reuse', async () => {
    const token = tok();
    const g = (await (await SELF.fetch(`${BASE}/rooms`, authed(token, { lang: 'en' }))).json()) as Grant;
    const url = `/ws/room/${g.roomCode}?ticket=${encodeURIComponent(g.ticket)}`;

    const first = await wsFetch(url);
    expect(first.status).toBe(101);
    expect(first.webSocket).not.toBeNull();
    try {
      first.webSocket?.accept();
      first.webSocket?.close();
    } catch {
      /* ignore */
    }

    // 같은 티켓 재사용 → DO usedTickets가 거부(1회용, §5.3).
    const second = await wsFetch(url);
    expect(second.status).toBe(401);
  });
});

// ───────────────────────── 방 WS 헬퍼 ─────────────────────────

function roomStub(code: string): Stub {
  return env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName('room:' + code)) as unknown as Stub;
}

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
