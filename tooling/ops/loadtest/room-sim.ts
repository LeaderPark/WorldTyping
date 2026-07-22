// spec: docs/05 §4.4(progress ≤10Hz·tick 250ms 코얼레싱·대역폭)·§1(RACING alarm), docs/00 §1.4 SLO
//       (tick p95 <400ms), WT-M4-06 (500 동시 방 tick 부하 스모크)
//
// workerd(wrangler dev, 기본 8787) 대상 동시 방 부하 시뮬레이터. 방당 봇 2개(Node 내장 WebSocket
// 클라)가 붙어 RACING까지 올린 뒤 progress를 스로틀 이하로 흘려보내고, "progress 전송 → 그것이
// 반영된 progress-tick 수신"까지의 E2E 지연을 히스토그램으로 집계한다(p50/p95/p99).
//
// [세션 레이트리밋 우회는 하지 않되 임계는 불변] 세션/티켓을 REST(POST /session·/match/quick)로
// 받으면 session(10/60s/IP) 상한에 즉시 막힌다. 대신 @wt/shared의 signSessionToken/signWsTicket으로
// 토큰을 직접 발급한다 — 서버 검증(requireAuth·consumeTicket)은 그대로 통과하므로 서버 임계값을
// 완화하지 않는다(작업 지시 준수). 방 생성만은 POST /rooms(rooms(create): 5/60s/pid)를 쓰되, 방
// 5개마다 새 creator pid를 써서 per-pid 상한 안에 머문다.
//
// 사용:
//   pnpm --filter @wt/api run dev            # 또는 e2e:dev — wrangler dev @ 8787
//   ROOMS=100 node --import tsx tooling/ops/loadtest/room-sim.ts
//   ROOMS=300 ... / ROOMS=500 ...            # 규모별 반복

// tooling/은 워크스페이스 패키지가 아니라 @wt/* 런타임 해석이 안 된다(build-data.ts와 동일 —
// 런타임 코드는 상대경로, 타입만 @wt/*). 그래서 shared 서명 함수는 소스 상대경로로 가져온다.
import { signSessionToken, signWsTicket } from '../../../packages/shared/src/index';

const BASE = process.env.WT_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ROOMS = Number(process.env.ROOMS ?? 100);
const LANG = (process.env.LANG_SIM ?? 'en') as 'ko' | 'en';
const RACE_SECONDS = Number(process.env.RACE_SECONDS ?? 15);
const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS ?? 300);
const CONNECT_BATCH = Number(process.env.CONNECT_BATCH ?? 40);
const SESSION_SECRET = process.env.SESSION_HMAC_SECRET ?? 'dev-secret-session';
const RUN_SECRET = process.env.RUN_HMAC_SECRET ?? 'dev-secret-run';
const ROOMS_CREATE_PER_PID = 5; // LIMITS['rooms(create)'].max

const log = (...a: unknown[]): void => console.log('[room-sim]', ...a);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Frame {
  v: 1;
  type: string;
  [k: string]: unknown;
}

class Bot {
  private ws: WebSocket | null = null;
  private seq = 0;
  private ksCounter = 0;
  private pendingSentTs: number | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private readied = false;
  private startSent = false;
  connected = false;
  racing = false;
  finished = false;
  readonly samples: number[] = [];

  constructor(
    private readonly roomCode: string,
    private readonly pid: string,
    private readonly ticket: string,
    private readonly sessionToken: string,
  ) {}

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, seq: ++this.seq }));
    }
  }

  connect(): Promise<void> {
    const url = `${WS_BASE}/ws/room/${this.roomCode}?ticket=${encodeURIComponent(this.ticket)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.addEventListener('open', () => {
        this.connected = true;
        this.send({ v: 1, type: 'hello', auth: { kind: 'session', token: this.sessionToken }, dataVersion: 'sim' });
        done();
      });
      ws.addEventListener('error', () => done());
      ws.addEventListener('close', () => {
        this.connected = false;
        this.stopProgress();
      });
      ws.addEventListener('message', (ev) => this.onMessage(String((ev as { data: unknown }).data)));
      setTimeout(done, 8_000); // 연결 지연 상한(램프용)
    });
  }

  private onMessage(raw: string): void {
    let m: Frame;
    try {
      m = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    switch (m.type) {
      case 'welcome':
        this.send({ v: 1, type: 'join', nickname: `BOT_${this.pid.slice(-4)}`, passportCover: 'basic-green' });
        break;
      case 'room-state': {
        if (!this.readied) {
          this.readied = true;
          this.send({ v: 1, type: 'ready', ready: true });
        }
        // /rooms(비-퀵매치) 방은 전원레디 자동시작이 아니라 호스트 start가 필요하다(MatchRoom.onReady:
        // quickMatch만 자동). 2인 이상 모이면 start를 보낸다(호스트가 아니면 서버가 NOT_HOST로 무시).
        const players = Array.isArray(m.players) ? (m.players as unknown[]) : [];
        if (!this.startSent && players.length >= 2) {
          this.startSent = true;
          this.send({ v: 1, type: 'start' });
        }
        break;
      }
      case 'start': {
        const startAt = Number(m.startAt ?? Date.now());
        const wait = Math.max(0, startAt - Date.now());
        setTimeout(() => this.startProgress(), wait);
        break;
      }
      case 'progress-tick':
        this.racing = true;
        if (this.pendingSentTs !== null) {
          this.samples.push(Date.now() - this.pendingSentTs);
          this.pendingSentTs = null;
        }
        break;
      case 'race-finished':
      case 'results':
        this.finished = true;
        this.stopProgress();
        break;
      default:
        break;
    }
  }

  private startProgress(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      // ks를 소범위에서 순환시켜 ksPct(서버 표시값)가 매번 변하게 한다 → tick 코얼레싱이 매 주기
      // 유의미한 변화로 브로드캐스트된다(진행 자체는 complete 없이 idx 0 유지 — 부하 생성용 합성).
      this.ksCounter = (this.ksCounter % 4) + 1;
      this.pendingSentTs = Date.now();
      this.send({ v: 1, type: 'progress', idx: 0, ks: this.ksCounter, err: 0 });
    }, PROGRESS_INTERVAL_MS);
  }

  private stopProgress(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  close(): void {
    this.stopProgress();
    try {
      this.ws?.close(1000);
    } catch {
      /* ignore */
    }
  }
}

async function createRoom(creatorToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({ lang: LANG, maxPlayers: 2, mode: 'race-mixed' }),
    });
    if (!res.ok) {
      log(`create room failed ${res.status}`);
      return null;
    }
    const grant = (await res.json()) as { roomCode: string };
    return grant.roomCode;
  } catch (e) {
    log('create room error', (e as Error).message);
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  log(`target=${BASE} rooms=${ROOMS} race=${RACE_SECONDS}s progressEvery=${PROGRESS_INTERVAL_MS}ms`);

  // 1) creator 세션 토큰 발급(방 5개당 1 pid → rooms(create) per-pid 상한 준수).
  const numCreators = Math.ceil(ROOMS / ROOMS_CREATE_PER_PID);
  const creatorTokens: string[] = [];
  for (let i = 0; i < numCreators; i++) {
    creatorTokens.push(await signSessionToken(SESSION_SECRET, `sim-creator-${i}-${Date.now()}`));
  }

  // 2) 방 생성.
  const codes: string[] = [];
  for (let i = 0; i < ROOMS; i++) {
    const code = await createRoom(creatorTokens[Math.floor(i / ROOMS_CREATE_PER_PID)]!);
    if (code) codes.push(code);
    if ((i + 1) % 50 === 0) log(`rooms created ${codes.length}/${i + 1}`);
  }
  log(`rooms created: ${codes.length}/${ROOMS}`);
  if (codes.length === 0) {
    log('no rooms — is wrangler dev running on 8787? aborting.');
    process.exit(1);
  }

  // 3) 방당 봇 2개 생성 + 티켓 직접 발급 후 램프 연결.
  const bots: Bot[] = [];
  for (const code of codes) {
    for (let b = 0; b < 2; b++) {
      const pid = `sim-${code}-b${b}`;
      const ticket = await signWsTicket(RUN_SECRET, pid, code);
      const sessionToken = await signSessionToken(SESSION_SECRET, pid);
      bots.push(new Bot(code, pid, ticket, sessionToken));
    }
  }
  log(`connecting ${bots.length} bots (batch ${CONNECT_BATCH})...`);
  for (let i = 0; i < bots.length; i += CONNECT_BATCH) {
    await Promise.all(bots.slice(i, i + CONNECT_BATCH).map((b) => b.connect()));
    await sleep(50);
  }
  const connected = bots.filter((b) => b.connected).length;
  log(`connected ${connected}/${bots.length}`);

  // 4) 레이스 진행 관찰(5s 카운트다운 + RACE_SECONDS).
  const observeMs = 5_000 + RACE_SECONDS * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < observeMs) {
    await sleep(1_000);
    const racing = bots.filter((b) => b.racing).length;
    const total = bots.reduce((n, b) => n + b.samples.length, 0);
    log(`t=${Math.round((Date.now() - t0) / 1000)}s racing=${racing} samples=${total}`);
  }

  // 5) 집계.
  for (const b of bots) b.close();
  const all = bots.flatMap((b) => b.samples).sort((a, z) => a - z);
  const p50 = percentile(all, 50);
  const p95 = percentile(all, 95);
  const p99 = percentile(all, 99);
  const racingRooms = new Set(bots.filter((b) => b.racing).map((b) => b)).size;

  log('──────── RESULT ────────');
  log(`rooms requested   : ${ROOMS}`);
  log(`rooms created     : ${codes.length}`);
  log(`bots connected    : ${connected}/${bots.length}`);
  log(`bots reached RACING: ${racingRooms}`);
  log(`tick samples      : ${all.length}`);
  log(`tick latency p50  : ${p50} ms`);
  log(`tick latency p95  : ${p95} ms  (SLO <400ms)`);
  log(`tick latency p99  : ${p99} ms`);
  log(`SLO p95<400ms     : ${p95 < 400 ? 'PASS' : 'FAIL'}`);

  // 리포트에 붙일 한 줄(CSV 유사) — 호출측이 캡처.
  console.log(
    `SIM_ROW rooms=${ROOMS} created=${codes.length} connected=${connected} samples=${all.length} p50=${p50} p95=${p95} p99=${p99}`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[room-sim] FATAL', err);
  process.exit(1);
});
