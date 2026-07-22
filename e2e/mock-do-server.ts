// spec: docs/05 §4.2(메시지 전문)·§4.4(tick 250ms 코얼레싱·progress 스로틀)·§5(complete 서버 권위
//       — idx 권위·idx-1 멱등·nextIndex 전진)·§6(timesync 왕복)·§7.2(재접속 resume→race-sync·grace
//       만료 left→관전)·§12(시퀀스 4종), docs/03 §10.2(E6/E7), docs/00 §11-D7(프로토콜 shared 단일
//       원천), WT-M4-06
//
// 실서버(MatchRoom DO) 없이 멀티 프로토콜을 결정적으로 재현하는 Node ws 모의 서버. E6/E7 회귀를
// CI에서 실서버 의존 없이 상시 보증한다. 클라(apps/web)가 VITE_WS_BASE로 이 서버에 붙는다.
//
// [드리프트 방지] 들어오는 C2S 프레임은 @wt/shared의 parseClientMessage(= 서버가 쓰는 그 zod
// 스키마)로 검증한다 — 스키마가 바뀌면 여기서 파싱이 깨져 드리프트가 드러난다. 나가는 S2C 프레임은
// @wt/shared의 ServerMessage 판별 유니온 타입으로 컴파일 타임에 강제하고(send()가 ServerMessage만
// 받는다), 런타임에도 v/type 최소 형태를 재확인한다. (@wt/shared는 C2S zod만 export하므로 S2C
// 런타임 검증의 단일 원천은 타입 + 이 최소 가드다 — apps/web의 S2C zod를 e2e로 끌어오지 않는다.)
//
// [실서버와 1:1 — 프로토콜 외 편의 메시지 없음] 클라에 보내는 것은 전부 docs/05 §4.2 S2C 메시지뿐이다.
// 시나리오 주입(상대 봇 진행 스케줄·강제 절단·grace 만료)은 클라-facing WS 프로토콜이 아니라
// 테스트 프로세스가 이 모듈의 핸들 메서드를 직접 호출하는 인-프로세스 제어다(별도 채널·별도 메시지
// 타입 없음). 결정적 타이밍(짧은 카운트다운·세트 크기)은 작업 지시가 허용한 mock 재량이다.

import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import selfsigned from 'selfsigned';
import { parseClientMessage, TICK_MS } from '@wt/shared';
import type { ClientMessage, ServerMessage, PlayerPublic, ResultRow } from '@wt/shared';

/** 로컬 카운트다운 정합용 서버 출발 지연(ms). 클라 엔진 COUNTDOWN_MS(3s)보다 살짝 크게 둬
 *  (startAt−offset)−3000−now ≈ 200ms가 되도록 한다(useRaceSession 스케줄 주석). */
const START_DELAY_MS = 3200;
const HARDCAP_MS = 180_000;
const PER_COUNTRY_LIMIT_MS = 10_000;
const DEFAULT_GRACE_MS = 30_000; // resume-within-grace 시나리오에 넉넉히(테스트가 즉시 재접속)

type Phase = 'WAITING' | 'COUNTDOWN' | 'RACING' | 'FINISHED';

interface Conn {
  ws: WsSocket;
  playerId: string | null;
}

interface Player {
  playerId: string;
  resumeKey: string;
  nickname: string;
  passportCover: string;
  isHost: boolean;
  isBot: boolean;
  ready: boolean;
  connState: PlayerPublic['connState'];
  conn: Conn | null; // 현재 살아있는 소켓(끊기면 null)
  // 레이스 권위 상태
  nextIndex: number;
  ksPct: number;
  combo: number;
  rank: number | null;
  finishedAt: number | null; // serverElapsedMs
  acceptedCompletes: number;
  ignoredDupCompletes: number; // idx-1 멱등으로 무시한 횟수(테스트 introspection)
  graceDeadline: number | null;
}

export interface BotSchedule {
  nickname?: string;
  /** 각 원소 = 이 시각(레이스 시작 후 ms)에 그 인덱스로 진행. 결정적 상대 트랙 보간용. */
  steps: { atMs: number; idx: number; ksPct?: number; combo?: number }[];
}

export interface CutOptions {
  /** true면 grace를 즉시 만료 처리(connState='left') — 재접속 시 관전 모드(§7.2-4). */
  expire?: boolean;
}

class Room {
  phase: Phase = 'WAITING';
  raceId = '';
  countries: string[] = [];
  seed = '00000000000000000000000000000000';
  startAt = 0;
  hardCapAt = 0;
  graceMs = DEFAULT_GRACE_MS;
  readonly players: Player[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = true;
  private finishOrder = 0;
  private botTimers: ReturnType<typeof setTimeout>[] = [];
  private seqCounter = 0;

  constructor(
    readonly code: string,
    readonly lang: 'ko' | 'en',
    readonly set: string[],
  ) {
    this.countries = set;
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.playerId === id);
  }

  broadcast(m: ServerMessage): void {
    const raw = JSON.stringify(assertServer(m));
    for (const p of this.players) {
      if (p.conn && p.conn.ws.readyState === WsSocket.OPEN) p.conn.ws.send(raw);
    }
  }

  sendTo(playerId: string, m: ServerMessage): void {
    const p = this.player(playerId);
    if (p?.conn && p.conn.ws.readyState === WsSocket.OPEN) {
      p.conn.ws.send(JSON.stringify(assertServer(m)));
    }
  }

  roomStatePublic(): PlayerPublic[] {
    return this.players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      passportCover: p.passportCover,
      bestPi: null,
      isHost: p.isHost,
      isBot: p.isBot,
      ready: p.ready,
      connState: p.connState,
    }));
  }

  broadcastRoomState(): void {
    const host = this.players.find((p) => p.isHost);
    this.broadcast({
      v: 1,
      type: 'room-state',
      phase: this.phase === 'FINISHED' ? 'FINISHED' : this.phase,
      roomCode: this.code,
      config: { lang: this.lang, mode: 'race-mixed', poolParam: null, maxPlayers: 8, isPublic: false },
      players: this.roomStatePublic(),
      hostId: host?.playerId ?? '',
      autoStartAt: null,
    });
  }

  maybeAutoStart(): void {
    if (this.phase !== 'WAITING') return;
    const present = this.players.filter((p) => p.connState === 'connected');
    if (present.length >= 2 && present.every((p) => p.ready)) this.beginRace();
  }

  beginRace(): void {
    this.phase = 'RACING';
    this.raceId = `race-${this.code}-${Date.now()}`;
    this.startAt = Date.now() + START_DELAY_MS;
    this.hardCapAt = this.startAt + HARDCAP_MS;
    for (const p of this.players) {
      p.nextIndex = 0;
      p.ksPct = 0;
      p.combo = 0;
      p.rank = null;
      p.finishedAt = null;
      p.acceptedCompletes = 0;
    }
    this.broadcastRoomState();
    const startMsg = (): ServerMessage => ({
      v: 1,
      type: 'start',
      raceId: this.raceId,
      seed: this.seed,
      countries: this.countries,
      dataVersion: 'mockdata',
      startAt: this.startAt,
      hardCapAt: this.hardCapAt,
      perCountryLimitMs: PER_COUNTRY_LIMIT_MS,
    });
    for (const p of this.players) {
      this.sendTo(p.playerId, { v: 1, type: 'countdown', startAt: this.startAt, raceId: this.raceId });
      this.sendTo(p.playerId, startMsg());
    }
    this.dirty = true;
    this.startTickLoop();
  }

  private startTickLoop(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.emitTick(), TICK_MS);
  }

  stopTickLoop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
  }

  tickSnapshot(): ServerMessage {
    return {
      v: 1,
      type: 'progress-tick',
      at: Date.now(),
      players: this.players.map((p) => ({
        id: p.playerId,
        idx: p.nextIndex,
        ksPct: p.ksPct,
        combo: p.combo,
        state:
          p.finishedAt !== null
            ? ('finished' as const)
            : p.connState === 'grace'
              ? ('grace' as const)
              : p.connState === 'left'
                ? ('left' as const)
                : ('racing' as const),
        rank: p.rank,
      })),
    };
  }

  private emitTick(): void {
    if (this.phase !== 'RACING') return;
    if (!this.dirty) return; // 변화 없으면 스킵(§4.4)
    this.dirty = false;
    this.broadcast(this.tickSnapshot());
  }

  markDirty(): void {
    this.dirty = true;
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }

  onComplete(p: Player, idx: number, ackSeq: number): void {
    if (this.phase !== 'RACING') return;
    if (p.finishedAt !== null) return;
    if (idx !== p.nextIndex) {
      // idx-1 재전송(재접속 직후 중복) → 조용히 무시(멱등, §5). 그 외 → 권위 롤백 지시.
      if (idx === p.nextIndex - 1) {
        p.ignoredDupCompletes += 1;
        return;
      }
      this.sendTo(p.playerId, {
        v: 1,
        type: 'country-rejected',
        ack: ackSeq,
        idx,
        reason: 'WRONG_INDEX',
        authoritative: {
          nextIdx: p.nextIndex,
          serverElapsedMs: Math.max(0, Date.now() - this.startAt),
          combo: p.combo,
        },
      });
      return;
    }
    // 승인(클라는 로컬 EXACT 판정 후에만 complete를 보낸다 — mock은 idx 권위만 재검증한다).
    p.nextIndex = idx + 1;
    p.combo += 1;
    p.ksPct = 0;
    p.acceptedCompletes += 1;
    const serverElapsedMs = Math.max(0, Date.now() - this.startAt);
    const finished = p.nextIndex >= this.countries.length;
    if (finished) {
      p.finishedAt = serverElapsedMs;
      p.rank = ++this.finishOrder;
    }
    this.markDirty();
    this.sendTo(p.playerId, {
      v: 1,
      type: 'country-accepted',
      ack: ackSeq,
      idx,
      nextIdx: p.nextIndex,
      serverElapsedMs,
      combo: p.combo,
      finished,
      rank: p.rank,
    });
    if (finished) {
      this.broadcast({
        v: 1,
        type: 'player-finished',
        playerId: p.playerId,
        rank: p.rank!,
        elapsedMs: serverElapsedMs,
        photoFinish: false,
      });
      this.maybeFinishRace();
    }
  }

  private activeRacers(): Player[] {
    return this.players.filter((p) => !p.isBot && p.connState !== 'left' && p.connState !== 'spectator');
  }

  maybeFinishRace(): void {
    const active = this.activeRacers();
    if (active.length === 0) return;
    if (active.every((p) => p.finishedAt !== null)) this.finalize('all-finished');
  }

  finalize(reason: 'all-finished' | 'hardcap' | 'all-left'): void {
    if (this.phase === 'FINISHED') return;
    this.phase = 'FINISHED';
    this.stopTickLoop();
    // 미완주자에게도 rank 부여(완주자 뒤).
    let nextRank = this.finishOrder;
    const rows: ResultRow[] = this.players
      .map((p) => {
        const rank = p.rank ?? ++nextRank;
        const elapsed = p.finishedAt;
        const cleared = p.nextIndex;
        const cpm =
          elapsed && elapsed > 0 ? Math.round((cleared * 5 * 60000) / elapsed) : 0; // 결정적 근사(국가당 ~5자)
        return {
          playerId: p.playerId,
          nickname: p.nickname,
          isBot: p.isBot,
          rank,
          finished: p.finishedAt !== null,
          countriesCleared: cleared,
          elapsedMs: elapsed,
          cpm,
          acc: 100,
          pi: 300 + (this.countries.length - rank) * 10,
          disconnected: p.connState === 'left',
        } satisfies ResultRow;
      })
      .sort((a, b) => a.rank - b.rank);
    // 순서 주의: results를 room-state(FINISHED)보다 먼저 보낸다. 클라 RoomPage는 phase가 'result'로
    // 바뀌는 순간 RaceView를 언마운트(→ RaceClient/raceRef 해제)하는데, results는 raceRef 경유로
    // 처리되므로 phase 전환이 먼저 오면 results가 유실된다(빈 결과 화면). 실서버도 results 확정 후
    // 상태를 알린다.
    this.broadcast({ v: 1, type: 'race-finished', reason });
    this.broadcast({
      v: 1,
      type: 'results',
      raceId: this.raceId,
      rows,
      rematchDeadline: Date.now() + 30_000,
    });
    this.broadcastRoomState();
  }

  scheduleBot(schedule: BotSchedule): string {
    const id = `${this.code}-bot`;
    const bot: Player = {
      playerId: id,
      resumeKey: `${id}-key`,
      nickname: schedule.nickname ?? 'GHOST',
      passportCover: 'basic-green',
      isHost: false,
      isBot: true,
      ready: true,
      connState: 'connected',
      conn: null,
      nextIndex: 0,
      ksPct: 0,
      combo: 0,
      rank: null,
      finishedAt: null,
      acceptedCompletes: 0,
      ignoredDupCompletes: 0,
      graceDeadline: null,
    };
    this.players.push(bot);
    this.broadcastRoomState();
    // 레이스가 시작되면 스케줄대로 봇 진행을 브로드캐스트(결정적 상대 트랙 보간).
    const arm = (): void => {
      for (const step of schedule.steps) {
        this.botTimers.push(
          setTimeout(
            () => {
              bot.nextIndex = step.idx;
              bot.ksPct = step.ksPct ?? 0;
              bot.combo = step.combo ?? step.idx;
              if (step.idx >= this.countries.length && bot.finishedAt === null) {
                bot.finishedAt = Math.max(0, Date.now() - this.startAt);
                bot.rank = ++this.finishOrder;
              }
              this.markDirty();
            },
            Math.max(0, step.atMs),
          ),
        );
      }
    };
    if (this.phase === 'RACING') arm();
    else {
      // 레이스 시작 시 arm되도록 startAt 대기 — beginRace가 RACING으로 바꾼 직후를 폴링 없이
      // 잡기 위해 다음 tick 경계에서 확인한다.
      const wait = setInterval(() => {
        if (this.phase === 'RACING') {
          clearInterval(wait);
          arm();
        }
      }, 20);
      this.botTimers.push(wait as unknown as ReturnType<typeof setTimeout>);
    }
    return id;
  }
}

function assertServer(m: ServerMessage): ServerMessage {
  // 나가는 프레임 런타임 최소 가드(타입은 컴파일 타임 ServerMessage로 이미 강제). 드리프트 조기 발견용.
  if (m.v !== 1 || typeof (m as { type?: unknown }).type !== 'string') {
    throw new Error(`mock: malformed outbound frame ${JSON.stringify(m)}`);
  }
  return m;
}

export interface MockServer {
  readonly port: number;
  readonly wsBase: string;
  close(): Promise<void>;
  reset(): void;
  room(code: string): Room | undefined;
  /** 강제 절단(§7.2/E7). expire:true면 재접속 시 관전. */
  cutPlayer(code: string, playerId: string, opts?: CutOptions): boolean;
  /** 결정적 상대 봇 진행 스케줄 주입(E6 상대 트랙 보간). */
  scheduleBot(code: string, schedule: BotSchedule): string | null;
  /** 서버 권위 멱등성 검증용(E7 "중복 seq 폐기") — 그 플레이어가 보낸 것처럼 complete를 재주입한다.
   *  idx===nextIndex-1이면 mock이 조용히 무시(nextIndex 불변, ignoredDupCompletes 증가). */
  injectComplete(code: string, playerId: string, idx: number): boolean;
}

export interface StartMockOptions {
  port?: number;
  /** 방 코드 → 세트(국가 id 배열). 미지정 코드는 defaultSet 사용. */
  sets?: Record<string, string[]>;
  defaultSet?: string[];
  lang?: 'ko' | 'en';
}

/** 기본 세트: 짧은 한글 국명 2종(빠르고 결정적). 국가 id는 countries.json 실 id여야 클라가 렌더한다. */
const DEFAULT_SET = ['MN', 'TH']; // 몽골, 태국

export function startMockServer(opts: StartMockOptions = {}): Promise<MockServer> {
  const port = opts.port ?? 8899;
  const lang = opts.lang ?? 'ko';
  const rooms = new Map<string, Room>();
  let playerCounter = 0;

  function roomFor(code: string): Room {
    let r = rooms.get(code);
    if (!r) {
      const set = opts.sets?.[code] ?? opts.defaultSet ?? DEFAULT_SET;
      r = new Room(code, lang, set);
      rooms.set(code, r);
    }
    return r;
  }

  // CSP(connect-src 'self' wss:)가 ws:는 막고 wss:는 허용하므로 mock을 자체서명 TLS(WSS)로 띄운다.
  // Playwright 컨텍스트는 ignoreHTTPSErrors로 이 자체서명 인증서를 수용한다(playwright.config·E6 spec).
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048 });
  const httpsServer: HttpsServer = createHttpsServer({ key: pems.private, cert: pems.cert });
  const wss = new WebSocketServer({ server: httpsServer });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `ws://127.0.0.1:${port}`);
    const m = url.pathname.match(/\/ws\/room\/([^/]+)/);
    const code = (m?.[1] ?? 'DEFAULT').toUpperCase();
    const room = roomFor(code);
    const conn: Conn = { ws, playerId: null };

    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8');
      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        ws.send(JSON.stringify({ v: 1, type: 'error', code: 'BAD_MESSAGE', message: parsed.error } satisfies ServerMessage));
        return;
      }
      handle(room, conn, parsed.data);
    });
    ws.on('close', () => {
      if (!conn.playerId) return;
      const p = room.player(conn.playerId);
      if (p && p.conn === conn) {
        p.conn = null;
        if (p.connState === 'connected' && (room.phase === 'RACING' || room.phase === 'COUNTDOWN')) {
          p.connState = 'grace';
          p.graceDeadline = Date.now() + room.graceMs;
          room.markDirty();
          room.broadcastRoomState();
        }
      }
    });
  });

  function handle(room: Room, conn: Conn, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello': {
        let player: Player | undefined;
        if (msg.resume) {
          player = room.player(msg.resume.playerId);
        }
        const resumed = !!player;
        if (!player) {
          const pid = `${room.code}-p${++playerCounter}`;
          player = {
            playerId: pid,
            resumeKey: `${pid}-key`,
            nickname: pid,
            passportCover: 'basic-green',
            isHost: room.players.filter((p) => !p.isBot).length === 0,
            isBot: false,
            ready: false,
            connState: 'connected',
            conn,
            nextIndex: 0,
            ksPct: 0,
            combo: 0,
            rank: null,
            finishedAt: null,
            acceptedCompletes: 0,
            ignoredDupCompletes: 0,
            graceDeadline: null,
          };
          room.players.push(player);
        } else {
          // 재접속: grace 만료 여부로 관전/복귀를 가른다(§7.2-4).
          const expired = player.connState === 'left' || (player.graceDeadline !== null && Date.now() > player.graceDeadline);
          player.conn = conn;
          player.connState = expired ? 'left' : 'connected';
          player.graceDeadline = null;
        }
        conn.playerId = player.playerId;
        room.sendTo(player.playerId, {
          v: 1,
          type: 'welcome',
          ack: msg.seq,
          playerId: player.playerId,
          resumeKey: player.resumeKey,
          serverTime: Date.now(),
          resumed,
        });
        if (resumed && (room.phase === 'RACING' || room.phase === 'COUNTDOWN')) {
          room.broadcastRoomState();
          // race-sync는 활성 복귀(§7.2)와 관전 복귀(§7.2-4) 모두에 보낸다 — 관전 화면(SpectatorView)도
          // 세트/트랙 렌더를 위해 raceReplay(=start 전문)가 필요하기 때문. connState='left'면 클라
          // RoomPage가 room-state로 관전 모드를 판정하므로 me.* 필드는 관전 시 무시된다.
          room.sendTo(player.playerId, {
            v: 1,
            type: 'race-sync',
            phase: 'RACING',
            start: {
              v: 1,
              type: 'start',
              raceId: room.raceId,
              seed: room.seed,
              countries: room.countries,
              dataVersion: 'mockdata',
              startAt: room.startAt,
              hardCapAt: room.hardCapAt,
              perCountryLimitMs: PER_COUNTRY_LIMIT_MS,
            },
            me: {
              nextIdx: player.nextIndex,
              serverElapsedMs: Math.max(0, Date.now() - room.startAt),
              combo: player.combo,
              errorKeystrokes: 0,
            },
            tick: room.tickSnapshot() as Extract<ServerMessage, { type: 'progress-tick' }>,
          });
        }
        break;
      }
      case 'join': {
        if (!conn.playerId) return;
        const p = room.player(conn.playerId);
        if (!p) return;
        p.nickname = msg.nickname;
        p.passportCover = msg.passportCover;
        if (p.connState !== 'left') p.connState = 'connected';
        room.broadcastRoomState();
        break;
      }
      case 'timesync':
        if (conn.playerId) {
          room.sendTo(conn.playerId, { v: 1, type: 'timesync', ack: msg.seq, t0: msg.t0, t1: Date.now() });
        }
        break;
      case 'ready': {
        if (!conn.playerId) return;
        const p = room.player(conn.playerId);
        if (!p) return;
        p.ready = msg.ready;
        room.broadcastRoomState();
        room.maybeAutoStart();
        break;
      }
      case 'start': // 호스트 명시 시작(자동 시작과 멱등).
        room.maybeAutoStart();
        if (room.phase === 'WAITING' && room.players.filter((p) => p.connState === 'connected').length >= 2) {
          room.beginRace();
        }
        break;
      case 'progress': {
        if (!conn.playerId) return;
        const p = room.player(conn.playerId);
        if (!p) return;
        // 서버 권위 idx는 complete로만 전진 — progress는 표시용 ksPct만 반영(§4.4).
        p.ksPct = msg.idx === p.nextIndex ? Math.min(100, msg.ks * 12) : p.ksPct;
        room.markDirty();
        break;
      }
      case 'complete': {
        if (!conn.playerId) return;
        const p = room.player(conn.playerId);
        if (!p) return;
        room.onComplete(p, msg.idx, msg.seq);
        break;
      }
      case 'chat':
        if (conn.playerId) {
          room.broadcast({ v: 1, type: 'chat', playerId: conn.playerId, text: msg.text, at: Date.now() });
        }
        break;
      case 'rematch':
        // 결과 화면 회귀 검증 범위 밖 — 투표 상태만 에코(최소).
        if (conn.playerId) {
          room.broadcast({
            v: 1,
            type: 'rematch-state',
            votes: room.players.filter((p) => !p.isBot).map((p) => ({ playerId: p.playerId, vote: p.playerId === conn.playerId ? msg.vote : null })),
            deadline: Date.now() + 30_000,
          });
        }
        break;
      case 'leave':
        if (conn.playerId) {
          const p = room.player(conn.playerId);
          if (p) {
            p.connState = 'left';
            room.markDirty();
            room.broadcastRoomState();
          }
        }
        break;
      default:
        break;
    }
  }

  return new Promise<MockServer>((resolve, reject) => {
    httpsServer.on('error', reject);
    httpsServer.listen(port, () => {
      resolve({
        port,
        wsBase: `wss://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            for (const r of rooms.values()) r.stopTickLoop();
            for (const client of wss.clients) {
              try {
                client.terminate();
              } catch {
                /* ignore */
              }
            }
            wss.close(() => httpsServer.close(() => res()));
          }),
        reset: () => {
          for (const r of rooms.values()) {
            r.stopTickLoop();
            for (const p of r.players) {
              try {
                p.conn?.ws.terminate();
              } catch {
                /* ignore */
              }
            }
          }
          rooms.clear();
          playerCounter = 0;
        },
        room: (code) => rooms.get(code.toUpperCase()),
        cutPlayer: (code, playerId, cutOpts) => {
          const r = rooms.get(code.toUpperCase());
          const p = r?.player(playerId);
          if (!r || !p || !p.conn) return false;
          if (cutOpts?.expire) {
            p.connState = 'left';
            p.graceDeadline = 0; // 즉시 만료 → 재접속 시 관전
          } else {
            p.connState = 'grace';
            p.graceDeadline = Date.now() + r.graceMs;
          }
          r.markDirty();
          const sock = p.conn.ws;
          p.conn = null;
          try {
            sock.terminate(); // 하드 절단 → 클라 1006 → 백오프 재연결
          } catch {
            /* ignore */
          }
          r.broadcastRoomState();
          return true;
        },
        scheduleBot: (code, schedule) => {
          const r = rooms.get(code.toUpperCase()) ?? roomFor(code.toUpperCase());
          return r.scheduleBot(schedule);
        },
        injectComplete: (code, playerId, idx) => {
          const r = rooms.get(code.toUpperCase());
          const p = r?.player(playerId);
          if (!r || !p) return false;
          r.onComplete(p, idx, r.nextSeq());
          return true;
        },
      });
    });
  });
}
