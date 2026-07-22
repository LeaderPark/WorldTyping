// spec: docs/05 §1(상태머신·storage)·§4(메시지·스로틀)·§5(onComplete 전문·타이브레이크)·§6(타임싱크)·
//       §7(grace·재접속·alarm min)·§9(안티치트)·§10(종료·D1 batch·재시도)·§11.2(Hibernation 필수)·
//       §13(실패 모드), docs/00 §11-D7(프로토콜 원천)·§11-D12(REACTION_FLOOR/MAX_KPS)·§11-D23(race-mixed)
//       + WT-M4-01
//
// 방 1개 = 완전 권위 서버. 클라이언트가 보내는 숫자(점수·시각·순위·진행 인덱스)는 전부 '주장'이며,
// 검증 후에만 상태에 반영된다. 판정은 @wt/shared의 matchInput을 서버에서 그대로 재실행한다(단일 원천).
//
// Hibernation 계약(§11.2): ctx.acceptWebSocket + serializeAttachment. 인메모리 캐시는 wake마다
// storage에서 재수화(ensureHydrated). ping/pong은 setWebSocketAutoResponse로 DO를 깨우지 않는다.
// RACING tick은 setInterval 금지 — 250ms setTimeout 체인이며 RACING 종료 시 반드시 해제한다
// (미해제 = hibernation 불가 = 과금).

import {
  parseClientMessage,
  buildRaceSet,
  compileTargets,
  matchInput,
  requiredKeystrokes,
  normalizeKo,
  normalizeEn,
  toJamoSeq,
  verifyToken,
  SessionPayloadSchema,
  TICK_MS,
  GRACE_MS,
  HARDCAP_MS,
  PER_COUNTRY_LIMIT_MS,
  REACTION_FLOOR_MS,
  MAX_KPS,
  REMATCH_VOTE_MS,
  AUTOSTART_WAIT_MS,
  BOT_OFFER_MS,
  type ClientMessage,
  type ServerMessage,
  type CompiledTarget,
  type Country,
  type CountryId,
  type RaceMode,
  type PlayerPublic,
  type S2C_Start,
  type S2C_ProgressTick,
  type ResultRow,
} from '@wt/shared';
import { COUNTRIES } from '@wt/data';
import { createFilter } from '@wt/moderation/src/engine';
import {
  MODERATION_KO_BADWORDS,
  MODERATION_EN_BADWORDS,
  MODERATION_EN_ALLOWLIST,
} from '../lib/moderation-wordlists.generated';
import type { Env } from '../env';
import { uuidv7 } from '../lib/uuid';
import {
  createPlayerRecord,
  resetRaceFields,
  type RoomConfig,
  type RoomPhase,
  type PlayerRecord,
  type PlayerMeta,
  type RaceState,
} from './room-state';
import {
  emptyAlarmSet,
  nextAlarmTime,
  dueScalarKinds,
  dueGracePlayers,
  type AlarmSet,
} from './alarms';
import { assignFinalRanks, computePlayerMetrics } from './ranking';

// ───────────────────────── 서버측 국가 데이터(§5 compileTargets 캐시 원천) ─────────────────────────

/** 랭킹 대상 밖(extended). 레이스 풀에서 제외(§11-D1, set-builder.ts와 동일 집합). */
const EXTENDED_IDS = new Set<CountryId>(['TW', 'XK', 'EH']);
const UN195: readonly Country[] = COUNTRIES.filter((c) => !EXTENDED_IDS.has(c.id));
const COUNTRY_BY_ID: ReadonlyMap<CountryId, Country> = new Map(COUNTRIES.map((c) => [c.id, c]));

/** 닉네임/채팅 콘텐츠 필터(node:fs 없는 빌드타임 스냅샷 주입 — nickname.ts와 동일 패턴). */
const CONTENT_FILTER = createFilter({
  ko: MODERATION_KO_BADWORDS,
  en: MODERATION_EN_BADWORDS,
  allow: MODERATION_EN_ALLOWLIST,
});

// ───────────────────────── 타이밍(생산 기본 = @wt/shared 상수, 테스트 주입 가능) ─────────────────────────

interface RoomTimings {
  countdownMs: number; // COUNTDOWN 지속(§1.1)
  hardcapMs: number; // startAt + HARDCAP_MS(§1)
  graceMs: number; // 연결 끊김 유예(§7.1)
  autostartMs: number; // 퀵매치 2~3인 자동 시작(§2.3)
  botOfferMs: number; // 1인 bot-offer(§2.3)
  rematchVoteMs: number; // 리매치 투표 마감(§10.2)
  createdCleanupMs: number; // CREATED 무입장 정리(§1.1)
  idleCleanupMs: number; // WAITING idle 정리(§1.1)
  emptyCleanupMs: number; // 전원 이탈 후 정리(§7.4)
  perCountryLimitMs: number; // 국가당 10초(§5 말미)
  reactionFloorMs: number; // 최소 소요시간 하한(§5-3, A3)
  startGraceMs: number; // start 직후 첫 complete 거부 창(§8-4)
  maxKps: { ko: number; en: number };
  tickMs: number;
  persistRetryDelayMs: number;
}

const DEFAULT_TIMINGS: RoomTimings = {
  countdownMs: 5000,
  hardcapMs: HARDCAP_MS,
  graceMs: GRACE_MS,
  autostartMs: AUTOSTART_WAIT_MS,
  botOfferMs: BOT_OFFER_MS,
  rematchVoteMs: REMATCH_VOTE_MS,
  createdCleanupMs: 60_000,
  idleCleanupMs: 600_000,
  emptyCleanupMs: 60_000,
  perCountryLimitMs: PER_COUNTRY_LIMIT_MS,
  reactionFloorMs: REACTION_FLOOR_MS,
  startGraceMs: 500,
  maxKps: { ko: MAX_KPS.ko, en: MAX_KPS.en },
  tickMs: TICK_MS,
  persistRetryDelayMs: 2000,
};

const MAX_BAD_MESSAGES = 10; // 누적 시 close(4400)
const CLOSE_SUPERSEDED = 4001;
const CLOSE_INACTIVE = 4408;
const CLOSE_BAD_MESSAGE = 4400;
const CLOSE_DATA_VERSION = 4426;
const RACING_INACTIVITY_MS = 40_000; // RACING 무메시지 이탈(§7.3)
const MAX_PERSIST_ATTEMPTS = 5; // §10.1-7

interface Attachment {
  playerId?: string;
  resumeKey?: string;
  isGuest?: boolean;
  badCount: number;
  superseded?: boolean;
  lastSeenAt?: number;
}

interface PendingPersist {
  match: unknown[]; // batch 파라미터(직렬화된 stmt 인자) — 재조립용
  attempts: number;
}

/** progress 코얼레싱 버퍼(표시용, 비영속 — hibernation 시 소실되어도 다음 progress로 회복). */
interface LiveProgress {
  idx: number;
  ks: number; // 신고 원문(클램프 전)
  at: number;
}

export class MatchRoomDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  private hydrated = false;
  private config: RoomConfig | null = null;
  private phase: RoomPhase = 'CREATED';
  private players = new Map<string, PlayerRecord>();
  private meta = new Map<string, PlayerMeta>();
  private order: string[] = []; // join 순서(호스트 승계)
  private hostId: string | null = null;
  private finishCounter = 0;
  private race: RaceState | null = null;
  private rematchVotes = new Map<string, boolean>();
  private alarms: AlarmSet = emptyAlarmSet();
  private dataVersion: string | null = null;
  private timings: RoomTimings = DEFAULT_TIMINGS;
  private pendingPersist: PendingPersist | null = null;
  private autoStartAt: number | null = null;

  // --- 비영속(인메모리) 상태 ---
  private compiled: CompiledTarget[][] | null = null; // 인덱스별 컴파일 타깃(방 lang 기준)
  private liveProgress = new Map<string, LiveProgress>();
  private tickHandle: ReturnType<typeof setTimeout> | null = null;
  private lastTickSig = '';
  private progressWindow = new Map<string, number[]>(); // 레이트리밋 슬라이딩 윈도
  private chatWindow = new Map<string, number[]>();

  // --- 테스트 계측(인메모리) ---
  private messageCount = 0; // webSocketMessage 진입 횟수(auto-response는 여기 안 잡힘)
  private hydrateCount = 0; // 전체 하이드레이션 횟수(≈ wake 횟수)
  private tickCount = 0;
  /** 테스트 전용: D1 batch를 이 횟수만큼 강제 실패시킨다(pendingPersist 재시도 검증). 생산 미사용. */
  private forcedPersistFailures = 0;
  /**
   * 테스트 전용 주입 클록(ms). null이면 this.now(). 시간 게이트 전이(alarm 만기·grace·하드캡·
   * 자동 스킵)를 벽시계 대기 없이 결정적으로 구동하기 위한 seam이다(생산은 항상 null → this.now()).
   */
  private testClock: number | null = null;
  private now(): number {
    return this.testClock ?? Date.now();
  }

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state;
    this.env = env;
    // ping/pong은 auto-response로 처리해 keepalive가 DO를 깨우지 않게 한다(§4.4·§11.2).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ v: 1, type: 'ping' }),
        JSON.stringify({ v: 1, type: 'pong' }),
      ),
    );
  }

  // ───────────────────────── 하이드레이션(모든 핸들러 앞단, §11.2) ─────────────────────────

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrateCount++;
    const s = this.ctx.storage;
    const [
      config,
      phase,
      players,
      meta,
      order,
      hostId,
      finishCounter,
      race,
      rematchVotes,
      alarms,
      dataVersion,
      timings,
      pendingPersist,
      autoStartAt,
    ] = await Promise.all([
      s.get<RoomConfig>('config'),
      s.get<RoomPhase>('phase'),
      s.get<Record<string, PlayerRecord>>('players'),
      s.get<Record<string, PlayerMeta>>('playerMeta'),
      s.get<string[]>('order'),
      s.get<string>('hostId'),
      s.get<number>('finishCounter'),
      s.get<RaceState>('race'),
      s.get<Record<string, boolean>>('rematchVotes'),
      s.get<AlarmSet>('alarms'),
      s.get<string>('dataVersion'),
      s.get<RoomTimings>('timings'),
      s.get<PendingPersist>('pendingPersist'),
      s.get<number>('autoStartAt'),
    ]);
    this.config = config ?? null;
    this.phase = phase ?? 'CREATED';
    this.players = new Map(Object.entries(players ?? {}));
    this.meta = new Map(Object.entries(meta ?? {}));
    this.order = order ?? [];
    this.hostId = hostId ?? null;
    this.finishCounter = finishCounter ?? 0;
    this.race = race ?? null;
    this.rematchVotes = new Map(Object.entries(rematchVotes ?? {}));
    this.alarms = alarms ?? emptyAlarmSet();
    this.dataVersion = dataVersion ?? null;
    this.timings = timings ?? DEFAULT_TIMINGS;
    this.pendingPersist = pendingPersist ?? null;
    this.autoStartAt = autoStartAt ?? null;
    // race 재개 시 컴파일 타깃 재구성(캐시는 비영속).
    if (this.race && this.config) this.rebuildCompiled();
    this.hydrated = true;
    // 크래시/재배포로 RACING 중 wake된 경우 tick 체인 재기동(§13-F3).
    if (this.phase === 'RACING' && this.tickHandle === null) this.scheduleTick();
  }

  private rebuildCompiled(): void {
    if (!this.race || !this.config) return;
    const lang = this.config.lang;
    this.compiled = this.race.countryIds.map((id) => {
      const c = COUNTRY_BY_ID.get(id);
      if (!c) throw new Error(`MatchRoom: race 세트에 알 수 없는 국가 id ${id}`);
      return compileTargets(c, lang);
    });
  }

  // ───────────────────────── storage 쓰기 헬퍼 ─────────────────────────

  private persistPlayers(): Promise<void> {
    return Promise.all([
      this.ctx.storage.put('players', Object.fromEntries(this.players)),
      this.ctx.storage.put('playerMeta', Object.fromEntries(this.meta)),
    ]).then(() => undefined);
  }

  private async persistCore(): Promise<void> {
    const s = this.ctx.storage;
    await s.put({
      phase: this.phase,
      order: this.order,
      finishCounter: this.finishCounter,
      rematchVotes: Object.fromEntries(this.rematchVotes),
    });
    if (this.hostId !== null) await s.put('hostId', this.hostId);
    await s.put('autoStartAt', this.autoStartAt);
  }

  // ───────────────────────── alarm 관리(min 패턴, §7.4) ─────────────────────────

  private async syncAlarm(): Promise<void> {
    await this.ctx.storage.put('alarms', this.alarms);
    const next = nextAlarmTime(this.alarms);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  // ───────────────────────── WebSocket 유틸 ─────────────────────────

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { badCount: 0 };
  }
  private setAtt(ws: WebSocket, a: Attachment): void {
    ws.serializeAttachment(a);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 닫힌 소켓 — 무시(다음 tick/브로드캐스트에서 정리).
    }
  }

  private socketsForPlayer(playerId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.att(ws).playerId === playerId);
  }

  private sendToPlayer(playerId: string, msg: ServerMessage): void {
    for (const ws of this.socketsForPlayer(playerId)) this.send(ws, msg);
  }

  private broadcast(msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a.playerId && this.players.has(a.playerId)) this.send(ws, msg);
    }
  }

  // ───────────────────────── fetch: 내부 API + WS 업그레이드 ─────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.ensureHydrated();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith('/internal/create')) return this.handleCreate(request);
    if (path.endsWith('/internal/room-status')) return this.handleRoomStatus();
    if (path.endsWith('/internal/debug')) return this.handleDebug();

    if (request.headers.get('Upgrade') === 'websocket') return this.handleUpgrade();

    return new Response('Not found', { status: 404 });
  }

  private async handleCreate(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('bad body', { status: 400 });
    }
    const parsed = body as {
      config?: Partial<RoomConfig> & { roomCode: string };
      timings?: Partial<RoomTimings>;
      dataVersion?: string;
    };
    if (!parsed.config || typeof parsed.config.roomCode !== 'string') {
      return new Response('missing config', { status: 400 });
    }
    if (this.config) {
      // 이미 생성됨(멱등) — 현재 상태를 200으로 반환.
      return Response.json({ ok: true, phase: this.phase });
    }
    const c = parsed.config;
    const now = this.now();
    this.config = {
      roomCode: c.roomCode,
      lang: c.lang ?? 'ko',
      mode: c.mode ?? 'race-mixed',
      poolParam: c.poolParam ?? null,
      maxPlayers: c.maxPlayers ?? 8,
      isPublic: c.isPublic ?? false,
      createdAt: now,
      quickMatch: c.quickMatch ?? false,
    };
    if (parsed.timings) this.timings = { ...DEFAULT_TIMINGS, ...parsed.timings };
    if (parsed.dataVersion) this.dataVersion = parsed.dataVersion;
    this.phase = 'CREATED';
    await this.ctx.storage.put('config', this.config);
    await this.ctx.storage.put('timings', this.timings);
    if (this.dataVersion) await this.ctx.storage.put('dataVersion', this.dataVersion);
    await this.persistCore();
    // CREATED 무입장 정리 alarm(§1.1).
    this.alarms.idleCleanup = now + this.timings.createdCleanupMs;
    await this.syncAlarm();
    return Response.json({ ok: true, phase: this.phase });
  }

  private handleRoomStatus(): Response {
    const active = [...this.players.values()].filter((p) => p.connState !== 'left');
    return Response.json({
      phase: this.phase,
      players: active.length,
      maxPlayers: this.config?.maxPlayers ?? 0,
      roomCode: this.config?.roomCode ?? null,
    });
  }

  private handleDebug(): Response {
    return Response.json({
      phase: this.phase,
      messageCount: this.messageCount,
      hydrateCount: this.hydrateCount,
      tickCount: this.tickCount,
      tickScheduled: this.tickHandle !== null,
      players: [...this.players.values()].map((p) => ({
        id: p.playerId,
        connState: p.connState,
        nextIndex: p.nextIndex,
        combo: p.combo,
        rank: p.rank,
        finishedAt: p.finishedAt,
        correctKeystrokes: p.correctKeystrokes,
        errorKeystrokes: p.errorKeystrokes,
        suspicionFlags: p.suspicionFlags,
      })),
      hostId: this.hostId,
      race: this.race ? { raceId: this.race.raceId, seed: this.race.seed, len: this.race.countryIds.length } : null,
      alarms: this.alarms,
      pendingPersist: this.pendingPersist ? this.pendingPersist.attempts : null,
    });
  }

  private handleUpgrade(): Response {
    if (!this.config) return new Response('room not found', { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.setAtt(server, { badCount: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ───────────────────────── WS 라이프사이클 핸들러 ─────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureHydrated();
    this.messageCount++;
    const a = this.att(ws);
    a.lastSeenAt = this.now();

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      a.badCount = (a.badCount ?? 0) + 1;
      this.setAtt(ws, a);
      this.send(ws, this.errorMsg('BAD_MESSAGE', 'unparseable frame'));
      if (a.badCount >= MAX_BAD_MESSAGES) ws.close(CLOSE_BAD_MESSAGE, 'too many bad messages');
      return;
    }
    this.setAtt(ws, a);
    await this.route(ws, parsed.data);
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.ensureHydrated();
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.ensureHydrated();
    await this.onDisconnect(ws);
  }

  private async route(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        return this.onHello(ws, msg);
      case 'join':
        return this.onJoin(ws, msg);
      case 'ready':
        return this.onReady(ws, msg);
      case 'start':
        return this.onStart(ws, msg);
      case 'chat':
        return this.onChat(ws, msg);
      case 'bot-accept':
        return this.onBotAccept(ws, msg);
      case 'progress':
        return this.onProgress(ws, msg);
      case 'complete':
        return this.onComplete(ws, msg);
      case 'timesync':
        return this.onTimeSync(ws, msg);
      case 'rematch':
        return this.onRematch(ws, msg);
      case 'leave':
        return this.onLeave(ws, msg);
    }
  }

  // ───────────────────────── hello / 재접속(§7.2) ─────────────────────────

  private async onHello(ws: WebSocket, msg: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    // 데이터 버전(§F7): 방 canonical과 불일치 시 강제 리로드.
    if (this.dataVersion !== null && msg.dataVersion !== this.dataVersion) {
      this.send(ws, this.errorMsg('DATA_VERSION', 'data version mismatch'));
      ws.close(CLOSE_DATA_VERSION, 'data version');
      return;
    }
    if (this.dataVersion === null) {
      this.dataVersion = msg.dataVersion;
      await this.ctx.storage.put('dataVersion', this.dataVersion);
    }

    // 신원 확정.
    let playerId: string;
    let isGuest: boolean;
    if (msg.auth.kind === 'session') {
      const res = await verifyToken(
        msg.auth.token,
        [this.env.SESSION_HMAC_SECRET, this.env.SESSION_HMAC_SECRET_PREV],
        SessionPayloadSchema,
      );
      if (!res.ok) {
        this.send(ws, this.errorMsg('AUTH_FAILED', 'invalid session token'));
        return;
      }
      playerId = res.payload.pid;
      isGuest = false;
    } else {
      playerId = await this.guestPlayerId(msg.auth.guestId);
      isGuest = true;
    }

    // 재접속(resume): resumeKey 일치 + connState !== 'left'.
    if (msg.resume) {
      const rec = this.players.get(msg.resume.playerId);
      if (!rec || rec.resumeKey !== msg.resume.resumeKey || rec.connState === 'left') {
        this.send(ws, this.errorMsg('AUTH_FAILED', 'resume rejected'));
        return;
      }
      playerId = rec.playerId;
    }

    const existing = this.players.get(playerId);
    const a = this.att(ws);

    // 같은 playerId의 구 WS는 새 WS로 대체(§7.2-5) — close(4001).
    this.supersedeOldSockets(ws, playerId);
    a.playerId = playerId;

    if (existing) {
      // 기존 멤버 재접속/중복탭. grace였다면 복귀.
      existing.connState = 'connected';
      if (existing.graceDeadline !== null) {
        existing.graceDeadline = null;
        delete this.alarms.graceDeadlines[playerId];
        await this.syncAlarm();
      }
      a.resumeKey = existing.resumeKey;
      this.setAtt(ws, a);
      await this.persistPlayers();
      const resumed = this.phase === 'COUNTDOWN' || this.phase === 'RACING' || this.phase === 'FINISHED';
      this.send(ws, this.welcomeMsg(msg.seq, playerId, existing.resumeKey, resumed));
      if (resumed && this.race) this.send(ws, this.raceSyncMsg(existing));
      else this.send(ws, this.roomStateMsg());
      this.broadcast(this.roomStateMsg());
    } else {
      // 최초 접속: playerId + resumeKey 발급. 멤버십은 join에서 생성.
      // isGuest는 join 시 meta에 반영하기 위해 attachment로 운반한다.
      const resumeKey = this.randomHex(16);
      a.resumeKey = resumeKey;
      a.isGuest = isGuest;
      this.setAtt(ws, a);
      this.send(ws, this.welcomeMsg(msg.seq, playerId, resumeKey, false));
    }
  }

  private supersedeOldSockets(current: WebSocket, playerId: string): void {
    for (const old of this.ctx.getWebSockets()) {
      if (old === current) continue;
      const oa = this.att(old);
      if (oa.playerId === playerId) {
        oa.superseded = true;
        this.setAtt(old, oa);
        try {
          old.close(CLOSE_SUPERSEDED, 'superseded');
        } catch {
          /* already closed */
        }
      }
    }
  }

  private async guestPlayerId(guestId: string): Promise<string> {
    const bytes = new TextEncoder().encode('mp:guest:' + guestId);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'p_' + hex.slice(0, 20);
  }

  // ───────────────────────── join(§1.1 CREATED→WAITING) ─────────────────────────

  private async onJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): Promise<void> {
    const a = this.att(ws);
    if (!a.playerId) {
      this.send(ws, this.errorMsg('AUTH_FAILED', 'hello required before join'));
      return;
    }
    const playerId = a.playerId;

    if (this.phase !== 'WAITING' && this.phase !== 'CREATED') {
      // 진행 중 방 재입장은 기존 멤버만(재접속은 hello resume 경로). 신규 입장 차단.
      if (!this.players.has(playerId)) {
        this.send(ws, this.errorMsg('WRONG_PHASE', 'room already started'));
        return;
      }
      return;
    }

    // 닉네임: 트림 + 콘텐츠 필터(§4.2).
    const nickname = msg.nickname.trim();
    if (nickname.length === 0 || nickname.length > 16 || CONTENT_FILTER.evaluateText(nickname).blocked) {
      this.send(ws, this.errorMsg('NICKNAME_INVALID', 'nickname rejected'));
      return;
    }

    const already = this.players.get(playerId);
    if (!already) {
      const active = [...this.players.values()].filter((p) => p.connState !== 'left').length;
      if (active >= (this.config?.maxPlayers ?? 8)) {
        this.send(ws, this.errorMsg('ROOM_FULL', 'room is full'));
        return;
      }
      const isHost = this.order.length === 0;
      const rec = createPlayerRecord({
        playerId,
        nickname,
        passportCover: msg.passportCover,
        bestPi: null,
        isHost,
        isBot: false,
        resumeKey: a.resumeKey ?? this.randomHex(16),
      });
      this.players.set(playerId, rec);
      this.order.push(playerId);
      this.meta.set(playerId, { isGuest: a.isGuest ?? true, rttMs: null, skipped: 0, leftAt: null });
      if (isHost) this.hostId = playerId;
    } else {
      already.nickname = nickname;
      already.passportCover = msg.passportCover;
      already.connState = 'connected';
    }

    // CREATED → WAITING(첫 join). idle alarm 10분으로 재설정.
    if (this.phase === 'CREATED') this.phase = 'WAITING';
    this.alarms.idleCleanup = this.now() + this.timings.idleCleanupMs;
    this.alarms.emptyCleanup = null;

    await this.persistPlayers();
    await this.persistCore();
    await this.syncAlarm();
    await this.updatePublicRoom();
    this.broadcast(this.roomStateMsg());
    await this.maybeAutoStart();
  }

  // ───────────────────────── ready / start ─────────────────────────

  private async onReady(ws: WebSocket, msg: Extract<ClientMessage, { type: 'ready' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p || this.phase !== 'WAITING') return;
    p.ready = msg.ready;
    await this.persistPlayers();
    this.broadcast(this.roomStateMsg());
    await this.maybeAutoStart();
  }

  private async onStart(ws: WebSocket, _msg: Extract<ClientMessage, { type: 'start' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p) return;
    if (!p.isHost) {
      this.send(ws, this.errorMsg('NOT_HOST', 'only host can start'));
      return;
    }
    if (this.phase !== 'WAITING') {
      this.send(ws, this.errorMsg('WRONG_PHASE', 'not in waiting'));
      return;
    }
    const active = this.activePlayers();
    if (active.length < 2) {
      this.send(ws, this.errorMsg('WRONG_PHASE', 'need at least 2 players'));
      return;
    }
    await this.startCountdown(null);
  }

  private async maybeAutoStart(): Promise<void> {
    // 퀵매치 방 자동 시작(§2.3-4). 봇 오퍼(§2.3-5, 1인 60초)는 KV ghost 리플레이 의존 →
    // WT-M4-02/M5로 위임(escalations). 여기서는 4인/전원레디/2~3인 15초만 처리한다.
    if (this.phase !== 'WAITING' || !this.config?.quickMatch) return;
    const active = this.activePlayers();
    if (active.length >= 4) {
      await this.startCountdown(null);
      return;
    }
    if (active.length >= 2 && active.every((p) => p.ready || p.isBot)) {
      await this.startCountdown(null);
      return;
    }
    if (active.length >= 2) {
      if (this.alarms.autoStart === null) {
        this.autoStartAt = this.now() + this.timings.autostartMs;
        this.alarms.autoStart = this.autoStartAt;
        await this.ctx.storage.put('autoStartAt', this.autoStartAt);
        await this.syncAlarm();
        this.broadcast(this.roomStateMsg());
      }
    } else if (this.alarms.autoStart !== null) {
      this.alarms.autoStart = null;
      this.autoStartAt = null;
      await this.ctx.storage.put('autoStartAt', null);
      await this.syncAlarm();
    }
  }

  // ───────────────────────── chat ─────────────────────────

  private async onChat(ws: WebSocket, msg: Extract<ClientMessage, { type: 'chat' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p) return;
    if (this.phase !== 'WAITING' && this.phase !== 'FINISHED') return; // §4.2 WAITING/FINISHED만
    // 레이트리밋 2초당 3건(§4.4).
    const now = this.now();
    const w = (this.chatWindow.get(p.playerId) ?? []).filter((t) => now - t < 2000);
    if (w.length >= 3) {
      this.send(ws, this.errorMsg('RATE_LIMIT', 'chat rate limit'));
      return;
    }
    w.push(now);
    this.chatWindow.set(p.playerId, w);
    const text = CONTENT_FILTER.filterChat(msg.text).masked.slice(0, 120);
    this.broadcast({ v: 1, type: 'chat', playerId: p.playerId, text, at: now });
  }

  private onBotAccept(ws: WebSocket, _msg: Extract<ClientMessage, { type: 'bot-accept' }>): void {
    // 고스트 봇 삽입은 KV ghost:* 리플레이(WT-M4-02/M5, Q4)에 의존한다. M4-01은 메시지 계약만
    // 수용하고 실제 삽입은 후속 태스크로 위임(escalations 기재). 여기서는 no-op(방 안정성 보장).
    void ws;
  }

  // ───────────────────────── progress(표시용, §4.4 레이트리밋) ─────────────────────────

  private onProgress(ws: WebSocket, msg: Extract<ClientMessage, { type: 'progress' }>): void {
    const p = this.playerOf(ws);
    if (!p || this.phase !== 'RACING') return;
    // 11Hz 초과 폐기(§4.4).
    const now = this.now();
    const w = (this.progressWindow.get(p.playerId) ?? []).filter((t) => now - t < 1000);
    if (w.length >= 11) {
      this.send(ws, this.errorMsg('RATE_LIMIT', 'progress rate limit'));
      return;
    }
    w.push(now);
    this.progressWindow.set(p.playerId, w);
    // nextIndex보다 앞선 idx는 무시(§5 규칙). 표시용 ks만 반영.
    if (msg.idx === p.nextIndex) {
      this.liveProgress.set(p.playerId, { idx: msg.idx, ks: msg.ks, at: now });
    }
  }

  // ───────────────────────── complete(§5 코드 전문) ─────────────────────────

  private async onComplete(ws: WebSocket, m: Extract<ClientMessage, { type: 'complete' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p || !this.race || !this.config || !this.compiled) return;
    const race = this.race;
    const now = this.now();

    // 0) phase / 완주 가드
    if (this.phase !== 'RACING') return this.reject(ws, m, 'NOT_RACING', p);
    if (p.finishedAt !== null) return this.reject(ws, m, 'ALREADY_FINISHED', p);

    // 1) 인덱스 권위: 서버가 아는 다음 인덱스여야 한다.
    if (m.idx !== p.nextIndex) {
      // 멱등: 직전 승인 인덱스 재전송(재접속 직후 중복)은 조용히 무시.
      if (m.idx === p.nextIndex - 1) return;
      return this.reject(ws, m, 'WRONG_INDEX', p);
    }

    // start 직후 startGraceMs 내 첫 complete 전부 거부(§8-4, REACTION_FLOOR와 중복 방어).
    if (now - race.startAt < this.timings.startGraceMs) {
      p.suspicionFlags.push(`TOO_FAST:${m.idx}:start-grace`);
      this.markFlaggedIfNeeded(p);
      await this.persistPlayers();
      return this.reject(ws, m, 'TOO_FAST', p);
    }

    // 2) 정답 재검증 — matchInput 서버 재실행(방 생성 시 컴파일 캐시).
    const targets = this.compiled[m.idx];
    if (!targets || matchInput(m.input, targets, this.config.lang) !== 'EXACT') {
      return this.reject(ws, m, 'NOT_EXACT', p);
    }

    // 3) 최소 소요시간 하한(§5-3, A3): REACTION_FLOOR + ks/MAX_KPS.
    const lang = this.config.lang;
    const ksNeeded =
      lang === 'ko' ? toJamoSeq(normalizeKo(m.input)).length : normalizeEn(m.input).length;
    const minMs = this.timings.reactionFloorMs + (ksNeeded / this.timings.maxKps[lang]) * 1000;
    const sinceLast = now - (p.lastAcceptAt > 0 ? p.lastAcceptAt : race.startAt);
    if (sinceLast < minMs) {
      p.suspicionFlags.push(`TOO_FAST:${m.idx}:${sinceLast}<${Math.round(minMs)}`);
      this.markFlaggedIfNeeded(p);
      await this.persistPlayers();
      return this.reject(ws, m, 'TOO_FAST', p); // 진행 자체 거부 — 봇은 레이스가 안 됨
    }

    // 4) 승인: 권위 상태 갱신(클라 ct는 저장/경계검증만 — §6.3).
    p.nextIndex = m.idx + 1;
    p.lastAcceptAt = now;
    p.correctKeystrokes += ksNeeded;
    if (m.errThis > 0) p.errorKeystrokes += m.errThis;
    p.combo = m.errThis === 0 ? p.combo + 1 : 0;
    const serverElapsedMs = now - race.startAt;

    // §6.3-1 경계 검증: |ct − serverElapsedMs| > 3000 → CLOCK_DRIFT.
    if (Math.abs(m.ct - serverElapsedMs) > 3000 && !p.suspicionFlags.includes('CLOCK_DRIFT')) {
      p.suspicionFlags.push('CLOCK_DRIFT');
    }

    const finished = p.nextIndex === race.countryIds.length;
    if (finished) {
      p.finishedAt = now;
      p.rank = ++this.finishCounter; // DO 단일스레드 → 원자적 순위 확정(§5.1)
      this.broadcastPlayerFinished(p, serverElapsedMs);
    }
    this.send(ws, this.acceptedMsg(m.seq, p, serverElapsedMs, finished));
    await this.persistPlayers();
    await this.persistCore();
    if (finished) await this.maybeFinishRace();
  }

  private markFlaggedIfNeeded(p: PlayerRecord): void {
    const tooFast = p.suspicionFlags.filter((f) => f.startsWith('TOO_FAST:')).length;
    if (tooFast >= 3 && !p.suspicionFlags.includes('flagged')) {
      p.suspicionFlags.push('flagged'); // 레이스 계속하되 결과가 리더보드에 미반영(§9-A3)
    }
  }

  private reject(
    ws: WebSocket,
    m: Extract<ClientMessage, { type: 'complete' }>,
    reason: 'WRONG_INDEX' | 'NOT_EXACT' | 'TOO_FAST' | 'NOT_RACING' | 'ALREADY_FINISHED',
    p: PlayerRecord,
  ): void {
    const serverElapsedMs = this.race ? this.now() - this.race.startAt : 0;
    this.send(ws, {
      v: 1,
      type: 'country-rejected',
      ack: m.seq,
      idx: m.idx,
      reason,
      authoritative: { nextIdx: p.nextIndex, serverElapsedMs, combo: p.combo },
    });
  }

  // ───────────────────────── timesync(§6) ─────────────────────────

  private onTimeSync(ws: WebSocket, msg: Extract<ClientMessage, { type: 'timesync' }>): void {
    this.send(ws, { v: 1, type: 'timesync', ack: msg.seq, t0: msg.t0, t1: this.now() });
  }

  // ───────────────────────── rematch(§10.2) ─────────────────────────

  private async onRematch(ws: WebSocket, msg: Extract<ClientMessage, { type: 'rematch' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p || this.phase !== 'FINISHED') return;
    this.rematchVotes.set(p.playerId, msg.vote);
    await this.persistCore();
    this.broadcast(this.rematchStateMsg());
    // 과반(재실 인원, 봇 제외) 찬성 → REMATCH.
    const voters = this.activePlayers().filter((x) => !x.isBot);
    const yes = voters.filter((x) => this.rematchVotes.get(x.playerId) === true).length;
    if (voters.length > 0 && yes * 2 > voters.length) {
      await this.doRematch();
    }
  }

  // ───────────────────────── leave ─────────────────────────

  private async onLeave(ws: WebSocket, _msg: Extract<ClientMessage, { type: 'leave' }>): Promise<void> {
    const p = this.playerOf(ws);
    if (!p) return;
    await this.finalizeLeave(p);
  }

  // ───────────────────────── 연결 끊김(§7.1 grace 모델) ─────────────────────────

  private async onDisconnect(ws: WebSocket): Promise<void> {
    const a = this.att(ws);
    if (a.superseded || !a.playerId) return; // 대체된 구 소켓/미인증 소켓은 무시.
    const playerId = a.playerId;
    // 같은 playerId의 다른 OPEN 소켓이 남아 있으면(중복 연결) 이탈로 보지 않는다.
    const others = this.socketsForPlayer(playerId).filter((s) => s !== ws);
    if (others.length > 0) return;
    const p = this.players.get(playerId);
    if (!p) return;

    if (this.phase === 'WAITING') {
      // 즉시 퇴장(슬롯 반환).
      await this.finalizeLeave(p);
      return;
    }
    if (this.phase === 'COUNTDOWN' || this.phase === 'RACING') {
      if (p.connState !== 'grace' && p.connState !== 'left') {
        p.connState = 'grace';
        const deadline = this.now() + this.timings.graceMs;
        p.graceDeadline = deadline;
        this.alarms.graceDeadlines[playerId] = deadline;
        await this.persistPlayers();
        await this.syncAlarm();
        this.broadcast(this.roomStateMsg());
        // COUNTDOWN 중 재실 인원 < 2면 취소(F8)는 grace 만료 또는 명시 leave에서 처리.
      }
      return;
    }
    // FINISHED/CREATED/CLOSED: 특별 처리 없음(결과는 이미 영속).
  }

  /** 이탈 확정. WAITING/CREATED: 슬롯 반환(제거). COUNTDOWN/RACING/FINISHED: connState='left'. */
  private async finalizeLeave(p: PlayerRecord): Promise<void> {
    const wasHost = p.isHost;
    const playerId = p.playerId;

    if (this.phase === 'WAITING' || this.phase === 'CREATED') {
      this.players.delete(playerId);
      this.order = this.order.filter((id) => id !== playerId);
      this.rematchVotes.delete(playerId);
    } else {
      p.connState = 'left';
      p.ready = false;
      const meta = this.metaOf(playerId);
      if (meta.leftAt === null) meta.leftAt = this.now();
      p.graceDeadline = null;
      delete this.alarms.graceDeadlines[playerId];
    }

    // 호스트 승계(§2.4).
    if (wasHost) {
      this.hostId = null;
      for (const id of this.order) {
        const cand = this.players.get(id);
        if (cand && cand.connState !== 'left') {
          cand.isHost = true;
          this.hostId = id;
          break;
        }
      }
    }

    await this.persistPlayers();
    await this.persistCore();

    // COUNTDOWN 중 재실 인원 < 2 → WAITING 복귀 + seed 폐기(F8).
    if (this.phase === 'COUNTDOWN' && this.activePlayers().length < 2) {
      await this.cancelCountdown();
      return;
    }
    // RACING 중 이탈로 전원 완주/이탈 → 종료.
    if (this.phase === 'RACING') {
      await this.syncAlarm();
      await this.maybeFinishRace();
      this.broadcast(this.roomStateMsg());
      return;
    }

    await this.syncAlarm();
    await this.updatePublicRoom();
    this.broadcast(this.roomStateMsg());

    // 전원 이탈 → 정리 alarm(§7.4).
    const active = this.activePlayers();
    if (active.length === 0) {
      this.alarms.emptyCleanup = this.now() + this.timings.emptyCleanupMs;
      await this.syncAlarm();
    }
  }

  // ───────────────────────── 상태 전이 ─────────────────────────

  private async startCountdown(rematchOf: string | null): Promise<void> {
    if (!this.config) return;
    const now = this.now();
    const seed = this.randomHex(16);
    const mode = this.config.mode as RaceMode;
    const countryIds = buildRaceSet(seed, mode, this.config.poolParam, UN195);
    const raceId = 'r_' + uuidv7(now).replace(/-/g, '');
    const startAt = now + this.timings.countdownMs;
    const hardCapAt = startAt + this.timings.hardcapMs;
    this.race = {
      raceId,
      seed,
      countryIds,
      startAt,
      hardCapAt,
      dataVersion: this.dataVersion ?? '',
      perCountryLimitMs: this.timings.perCountryLimitMs,
      rematchOf,
    };
    this.rebuildCompiled();
    this.finishCounter = 0;
    this.liveProgress.clear();
    for (const p of this.players.values()) {
      if (p.connState === 'left') continue;
      resetRaceFields(p);
      const meta = this.metaOf(p.playerId);
      meta.skipped = 0;
      meta.leftAt = null;
    }
    this.phase = 'COUNTDOWN';
    this.autoStartAt = null;
    this.alarms.autoStart = null;
    this.alarms.idleCleanup = null;
    this.alarms.raceStart = startAt;
    this.alarms.hardcap = hardCapAt;

    await this.ctx.storage.put('race', this.race);
    await this.persistPlayers();
    await this.persistCore();
    await this.syncAlarm();

    // countdown + start 브로드캐스트(§12-b).
    this.broadcast({ v: 1, type: 'countdown', startAt, raceId });
    this.broadcast(this.startMsg());
    this.broadcast(this.roomStateMsg());
  }

  private async cancelCountdown(): Promise<void> {
    // seed 폐기 + WAITING 복귀(F8).
    this.race = null;
    this.compiled = null;
    this.phase = 'WAITING';
    this.alarms.raceStart = null;
    this.alarms.hardcap = null;
    this.alarms.idleCleanup = this.now() + this.timings.idleCleanupMs;
    await this.ctx.storage.delete('race');
    await this.persistCore();
    await this.syncAlarm();
    this.broadcast(this.roomStateMsg());
    // 인원 0이면 정리 예약.
    if (this.activePlayers().length === 0) {
      this.alarms.emptyCleanup = this.now() + this.timings.emptyCleanupMs;
      await this.syncAlarm();
    }
  }

  private async startRacing(): Promise<void> {
    if (this.phase !== 'COUNTDOWN' || !this.race) return;
    // 카운트다운 종료 시점 재실 인원 < 2면 취소(F8).
    if (this.activePlayers().length < 2) {
      await this.cancelCountdown();
      return;
    }
    this.phase = 'RACING';
    this.alarms.raceStart = null;
    await this.persistCore();
    await this.syncAlarm();
    this.broadcast(this.roomStateMsg());
    this.scheduleTick();
  }

  // ───────────────────────── 250ms tick(§4.4·§11.2) ─────────────────────────

  private scheduleTick(): void {
    if (this.phase !== 'RACING' || this.tickHandle !== null) return;
    this.tickHandle = setTimeout(() => {
      this.tickHandle = null;
      void this.runTick();
    }, this.timings.tickMs);
  }

  private clearTick(): void {
    if (this.tickHandle !== null) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private async runTick(): Promise<void> {
    await this.ensureHydrated();
    if (this.phase !== 'RACING' || !this.race) {
      this.clearTick();
      return;
    }
    this.tickCount++;
    const now = this.now();
    await this.reapInactive(now); // §7.3 RACING 40s 무메시지 → left + close(4408)
    if (this.phase !== 'RACING' || !this.race) {
      this.clearTick();
      return;
    }
    let changed = await this.applyAutoSkips(now);

    // 코얼레싱 tick 브로드캐스트 — 변화 없으면 스킵(§4.4).
    const tick = this.progressTickMsg(now);
    const sig = JSON.stringify(tick.players);
    if (sig !== this.lastTickSig) {
      this.lastTickSig = sig;
      this.broadcast(tick);
      changed = true;
    }
    void changed;

    // 종료 조건 재평가(자동 스킵으로 전원 완주 가능).
    await this.maybeFinishRace();
    if (this.phase === 'RACING') this.scheduleTick();
    else this.clearTick();
  }

  /**
   * §7.3 유령 연결: RACING 중 40초간 어떤 메시지도 없는 연결은 grace 없이 left 확정 + close(4408).
   * ping/pong auto-response는 lastSeenAt을 갱신하지 않으므로(핸들러 미기상) 방치 연결만 걸린다.
   */
  private async reapInactive(now: number): Promise<void> {
    if (!this.race) return;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (!a.playerId || a.superseded) continue;
      const p = this.players.get(a.playerId);
      if (!p || p.connState !== 'connected' || p.finishedAt !== null) continue;
      const last = a.lastSeenAt ?? this.race.startAt;
      if (now - last > RACING_INACTIVITY_MS) {
        try {
          ws.close(CLOSE_INACTIVE, 'inactive');
        } catch {
          /* already closed */
        }
        await this.finalizeLeave(p);
      }
    }
  }

  /** 10초 국가 제한 자동 스킵(§5 말미). 스킵 발생 시 true. */
  private async applyAutoSkips(now: number): Promise<boolean> {
    if (!this.race || !this.config) return false;
    const limit = this.race.perCountryLimitMs;
    const lang = this.config.lang;
    let any = false;
    for (const p of this.players.values()) {
      if (p.connState === 'left' || p.finishedAt !== null) continue;
      const base = p.lastAcceptAt > 0 ? p.lastAcceptAt : this.race.startAt;
      if (now - base <= limit) continue;
      const skippedIdx = p.nextIndex;
      const id = this.race.countryIds[skippedIdx];
      const country = id ? COUNTRY_BY_ID.get(id) : undefined;
      const ksNeeded = country ? requiredKeystrokes(country, lang) : 0;
      p.errorKeystrokes += ksNeeded; // 필요 타수 전량 오타 계상
      p.combo = 0;
      p.nextIndex += 1;
      p.lastAcceptAt = now;
      const meta = this.metaOf(p.playerId);
      meta.skipped += 1;
      const serverElapsedMs = now - this.race.startAt;
      const finished = p.nextIndex === this.race.countryIds.length;
      if (finished) {
        p.finishedAt = now;
        p.rank = ++this.finishCounter;
        this.broadcastPlayerFinished(p, serverElapsedMs);
      }
      // 본인에게 스킵 통지(§5 말미: country-accepted{combo:0}). ack=0 = 비요청 통지.
      this.sendToPlayer(p.playerId, {
        v: 1,
        type: 'country-accepted',
        ack: 0,
        idx: skippedIdx,
        nextIdx: p.nextIndex,
        serverElapsedMs,
        combo: 0,
        finished,
        rank: finished ? p.rank : null,
      });
      any = true;
    }
    if (any) {
      await this.persistPlayers();
      await this.persistCore();
    }
    return any;
  }

  private async maybeFinishRace(): Promise<void> {
    if (this.phase !== 'RACING') return;
    const alive = this.activePlayers();
    if (alive.length === 0) {
      await this.finishRace('all-left');
      return;
    }
    if (alive.every((p) => p.finishedAt !== null)) {
      await this.finishRace('all-finished');
    }
  }

  // ───────────────────────── FINISHED(§10.1) ─────────────────────────

  private async finishRace(reason: 'all-finished' | 'hardcap' | 'all-left'): Promise<void> {
    if (!this.race || !this.config) return;
    this.clearTick();
    this.phase = 'FINISHED';
    this.alarms.hardcap = null;
    this.alarms.raceStart = null;
    for (const id of Object.keys(this.alarms.graceDeadlines)) delete this.alarms.graceDeadlines[id];

    // 순위 확정(§5.1). ks는 필요 타수로 클램프(A6).
    const clampedKs = this.clampedKsByPlayer();
    const raceEndAt = this.now();
    assignFinalRanks([...this.players.values()], clampedKs);

    // results 브로드캐스트(§10.1-4).
    const rows = this.resultRows(raceEndAt);
    this.rematchVotes.clear();
    const rematchDeadline = raceEndAt + this.timings.rematchVoteMs;
    this.alarms.voteDeadline = rematchDeadline;

    await this.persistPlayers();
    await this.persistCore();
    await this.syncAlarm();
    await this.updatePublicRoom();

    this.broadcast({ v: 1, type: 'race-finished', reason });
    this.broadcast({ v: 1, type: 'results', raceId: this.race.raceId, rows, rematchDeadline });
    this.broadcast(this.rematchStateMsg());

    // D1 영속화(§10.1-5) — 실패 시 pendingPersist + 재시도(§10.1-7).
    await this.persistResults(reason, rows, raceEndAt);
  }

  private clampedKsByPlayer(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.race || !this.config) return out;
    const lang = this.config.lang;
    for (const p of this.players.values()) {
      const lp = this.liveProgress.get(p.playerId);
      const id = this.race.countryIds[p.nextIndex];
      const country = id ? COUNTRY_BY_ID.get(id) : undefined;
      const need = country ? requiredKeystrokes(country, lang) : 0;
      out[p.playerId] = lp ? Math.min(lp.ks, need) : 0;
    }
    return out;
  }

  private resultRows(raceEndAt: number): ResultRow[] {
    if (!this.race) return [];
    const rows: ResultRow[] = [...this.players.values()].map((p) => {
      const meta = this.metaOf(p.playerId);
      const metrics = computePlayerMetrics({
        correctKeystrokes: p.correctKeystrokes,
        errorKeystrokes: p.errorKeystrokes,
        finishedAt: p.finishedAt,
        leftAt: meta.leftAt,
        startAt: this.race!.startAt,
        raceEndAt,
        nextIndex: p.nextIndex,
        skipped: meta.skipped,
      });
      return {
        playerId: p.playerId,
        nickname: p.nickname,
        isBot: p.isBot,
        rank: p.rank ?? 0,
        finished: p.finishedAt !== null,
        countriesCleared: metrics.countriesCleared,
        elapsedMs: metrics.elapsedMs,
        cpm: metrics.cpm,
        acc: Math.round(metrics.acc * 1000) / 1000,
        pi: metrics.pi,
        disconnected: p.connState === 'left',
      };
    });
    rows.sort((a, b) => a.rank - b.rank);
    return rows;
  }

  // ───────────────────────── D1 영속화(§10.1-5/7) ─────────────────────────

  private async persistResults(
    reason: 'all-finished' | 'hardcap' | 'all-left',
    rows: ResultRow[],
    raceEndAt: number,
  ): Promise<void> {
    if (!this.env.DB || !this.race || !this.config) return;
    const race = this.race;
    const config = this.config;
    const isBotMatch = [...this.players.values()].some((p) => p.isBot) ? 1 : 0;

    try {
      if (this.forcedPersistFailures > 0) {
        this.forcedPersistFailures--;
        throw new Error('forced persist failure (test)');
      }
      const stmts = this.buildPersistStatements(reason, rows, raceEndAt, isBotMatch);
      await this.env.DB.batch(stmts);
      this.pendingPersist = null;
      await this.ctx.storage.delete('pendingPersist');
    } catch {
      // 실패 → pendingPersist 저장 + persistRetry alarm(방 CLOSED 전까지 최대 5회).
      const attempts = (this.pendingPersist?.attempts ?? 0) + 1;
      if (attempts <= MAX_PERSIST_ATTEMPTS) {
        this.pendingPersist = {
          match: [reason, JSON.stringify(rows), raceEndAt, isBotMatch, race.raceId, config.roomCode],
          attempts,
        };
        await this.ctx.storage.put('pendingPersist', this.pendingPersist);
        this.alarms.persistRetry = this.now() + this.timings.persistRetryDelayMs;
        await this.syncAlarm();
      } else {
        // 최종 실패 — 매치 유실(리더보드는 Cron 재집계 대상 아님을 로그로 추적, §13-F5).
        // eslint-disable-next-line no-console
        console.error('[MatchRoom] D1 persist gave up after retries', race.raceId);
        this.pendingPersist = null;
        this.alarms.persistRetry = null;
        await this.ctx.storage.delete('pendingPersist');
        await this.syncAlarm();
      }
    }
  }

  private buildPersistStatements(
    reason: 'all-finished' | 'hardcap' | 'all-left',
    rows: ResultRow[],
    raceEndAt: number,
    isBotMatch: number,
  ): D1PreparedStatement[] {
    const db = this.env.DB;
    const race = this.race!;
    const config = this.config!;
    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO matches
           (id, room_code, lang, mode, pool_param, seed, country_ids, data_version,
            started_at, finished_at, finish_reason, player_count, is_bot_match, rematch_of)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
        )
        .bind(
          race.raceId,
          config.roomCode,
          config.lang,
          config.mode,
          config.poolParam,
          race.seed,
          JSON.stringify(race.countryIds),
          race.dataVersion,
          race.startAt,
          raceEndAt,
          reason,
          rows.length,
          isBotMatch,
          race.rematchOf,
        ),
    );
    for (const row of rows) {
      const p = this.players.get(row.playerId);
      const meta = this.metaOf(row.playerId);
      const suspicion = p && p.suspicionFlags.length > 0 ? JSON.stringify(p.suspicionFlags) : null;
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO match_participants
             (match_id, player_id, nickname, is_guest, is_bot, rank, finished, countries_cleared,
              elapsed_ms, correct_keystrokes, error_keystrokes, cpm, acc, pi, disconnected,
              suspicion, avg_rtt_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
          )
          .bind(
            race.raceId,
            row.playerId,
            row.nickname,
            meta.isGuest ? 1 : 0,
            row.isBot ? 1 : 0,
            row.rank,
            row.finished ? 1 : 0,
            row.countriesCleared,
            row.elapsedMs,
            p?.correctKeystrokes ?? 0,
            p?.errorKeystrokes ?? 0,
            row.cpm,
            row.acc,
            row.pi,
            row.disconnected ? 1 : 0,
            suspicion,
            meta.rttMs,
          ),
      );
    }
    return stmts;
  }

  // ───────────────────────── 리매치(§10.2) ─────────────────────────

  private async doRematch(): Promise<void> {
    // 투표 거부/무응답자 퇴장(관전 전환 없음).
    for (const p of [...this.players.values()]) {
      if (p.isBot) continue;
      if (this.rematchVotes.get(p.playerId) !== true) {
        this.players.delete(p.playerId);
        this.order = this.order.filter((id) => id !== p.playerId);
      }
    }
    this.rematchVotes.clear();
    this.alarms.voteDeadline = null;
    const prevRaceId = this.race?.raceId ?? null;
    // 호스트가 나갔으면 승계.
    if (this.hostId && !this.players.has(this.hostId)) {
      this.hostId = null;
      for (const id of this.order) {
        const cand = this.players.get(id);
        if (cand) {
          cand.isHost = true;
          this.hostId = id;
          break;
        }
      }
    }
    if (this.activePlayers().length < 2) {
      // 인원 부족 → 대기실로.
      this.phase = 'WAITING';
      this.race = null;
      this.compiled = null;
      await this.ctx.storage.delete('race');
      await this.persistPlayers();
      await this.persistCore();
      await this.syncAlarm();
      this.broadcast(this.roomStateMsg());
      return;
    }
    // roomCode·DO·WS 유지 + 새 seed·raceId(§10.2).
    this.phase = 'WAITING'; // startCountdown이 WAITING을 요구하지 않지만 전이 일관성 위해.
    await this.startCountdown(prevRaceId);
  }

  // ───────────────────────── alarm() 핸들러(min 처리) ─────────────────────────

  async alarm(): Promise<void> {
    await this.ensureHydrated();
    const now = this.now();

    // grace 만료 처리(§7.1).
    for (const playerId of dueGracePlayers(this.alarms, now)) {
      delete this.alarms.graceDeadlines[playerId];
      const p = this.players.get(playerId);
      if (p && p.connState === 'grace') {
        await this.finalizeLeave(p);
      }
    }

    for (const kind of dueScalarKinds(this.alarms, now)) {
      switch (kind) {
        case 'autoStart':
          this.alarms.autoStart = null;
          if (this.phase === 'WAITING' && this.activePlayers().length >= 2) {
            await this.startCountdown(null);
          }
          break;
        case 'raceStart':
          this.alarms.raceStart = null;
          await this.startRacing();
          break;
        case 'hardcap':
          this.alarms.hardcap = null;
          if (this.phase === 'RACING') await this.finishRace('hardcap');
          break;
        case 'voteDeadline':
          this.alarms.voteDeadline = null;
          if (this.phase === 'FINISHED') await this.closeRoom('rematch-declined');
          break;
        case 'idleCleanup':
          this.alarms.idleCleanup = null;
          if (this.phase === 'CREATED' || this.phase === 'WAITING') await this.closeRoom('idle');
          break;
        case 'emptyCleanup':
          this.alarms.emptyCleanup = null;
          if (this.activePlayers().length === 0 && this.phase !== 'CLOSED') {
            if (this.phase === 'RACING' && this.race) await this.finishRace('all-left');
            await this.closeRoom('empty');
          }
          break;
        case 'persistRetry':
          this.alarms.persistRetry = null;
          if (this.pendingPersist) await this.retryPersist();
          break;
      }
      if (this.phase === 'CLOSED') return; // 방이 사라졌으면 alarm 재설정 불필요.
    }
    await this.syncAlarm();
  }

  private async retryPersist(): Promise<void> {
    const pending = this.pendingPersist;
    if (!pending || !this.env.DB || !this.race || !this.config) return;
    const raceId = this.race.raceId;
    const [reason, rowsJson, raceEndAt, isBotMatch] = pending.match as [
      'all-finished' | 'hardcap' | 'all-left',
      string,
      number,
      number,
    ];
    const rows = JSON.parse(rowsJson) as ResultRow[];
    try {
      if (this.forcedPersistFailures > 0) {
        this.forcedPersistFailures--;
        throw new Error('forced persist failure (test)');
      }
      const stmts = this.buildPersistStatements(reason, rows, raceEndAt, isBotMatch);
      await this.env.DB.batch(stmts);
      this.pendingPersist = null;
      await this.ctx.storage.delete('pendingPersist');
    } catch {
      const attempts = pending.attempts + 1;
      if (attempts <= MAX_PERSIST_ATTEMPTS) {
        pending.attempts = attempts;
        await this.ctx.storage.put('pendingPersist', pending);
        this.alarms.persistRetry = this.now() + this.timings.persistRetryDelayMs;
      } else {
        // eslint-disable-next-line no-console
        console.error('[MatchRoom] D1 persist gave up after retries', raceId);
        this.pendingPersist = null;
        await this.ctx.storage.delete('pendingPersist');
      }
    }
  }

  // ───────────────────────── CLOSED(§7.4) ─────────────────────────

  private async closeRoom(reason: 'idle' | 'empty' | 'rematch-declined' | 'error'): Promise<void> {
    this.clearTick();
    this.broadcast({ v: 1, type: 'room-closed', reason });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'room closed');
      } catch {
        /* already closed */
      }
    }
    await this.deletePublicRoom();
    this.phase = 'CLOSED';
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    // 인메모리 리셋(다음 create를 위한 청소).
    this.players.clear();
    this.meta.clear();
    this.order = [];
    this.race = null;
    this.compiled = null;
    this.alarms = emptyAlarmSet();
    this.config = null;
    this.hostId = null;
    this.dataVersion = null;
    this.pendingPersist = null;
  }

  // ───────────────────────── KV 공개 방(§2.4, WT-M4-02 훅) ─────────────────────────

  private async updatePublicRoom(): Promise<void> {
    if (!this.env.KV || !this.config || !this.config.isPublic) return;
    if (this.phase !== 'WAITING') return;
    const active = this.activePlayers().length;
    try {
      await this.env.KV.put(
        `publicroom:${this.config.roomCode}`,
        JSON.stringify({
          code: this.config.roomCode,
          lang: this.config.lang,
          players: active,
          maxPlayers: this.config.maxPlayers,
        }),
        { expirationTtl: 60 },
      );
    } catch {
      /* 표시용 캐시라 실패해도 무시 */
    }
  }

  private async deletePublicRoom(): Promise<void> {
    if (!this.env.KV || !this.config) return;
    try {
      await this.env.KV.delete(`publicroom:${this.config.roomCode}`);
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────── 메시지 빌더 ─────────────────────────

  private welcomeMsg(seq: number, playerId: string, resumeKey: string, resumed: boolean): ServerMessage {
    return { v: 1, type: 'welcome', ack: seq, playerId, resumeKey, serverTime: this.now(), resumed };
  }

  private roomStateMsg(): ServerMessage {
    const cfg = this.config!;
    const players: PlayerPublic[] = this.order
      .map((id) => this.players.get(id))
      .filter((p): p is PlayerRecord => p !== undefined)
      .map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        passportCover: p.passportCover,
        bestPi: p.bestPi,
        isHost: p.isHost,
        isBot: p.isBot,
        ready: p.ready,
        connState: p.connState,
      }));
    // 와이어 phase는 CREATED/CLOSED를 노출하지 않는다(§4.2 S2C_RoomState.phase 4-상태).
    const wirePhase: 'WAITING' | 'COUNTDOWN' | 'RACING' | 'FINISHED' =
      this.phase === 'CREATED' ? 'WAITING' : this.phase === 'CLOSED' ? 'FINISHED' : this.phase;
    return {
      v: 1,
      type: 'room-state',
      phase: wirePhase,
      roomCode: cfg.roomCode,
      config: {
        lang: cfg.lang,
        mode: cfg.mode,
        poolParam: cfg.poolParam,
        maxPlayers: cfg.maxPlayers,
        isPublic: cfg.isPublic,
      },
      players,
      hostId: this.hostId ?? '',
      autoStartAt: this.autoStartAt,
    };
  }

  private startMsg(): ServerMessage {
    const r = this.race!;
    const start: S2C_Start = {
      v: 1,
      type: 'start',
      raceId: r.raceId,
      seed: r.seed,
      countries: r.countryIds,
      dataVersion: r.dataVersion,
      startAt: r.startAt,
      hardCapAt: r.hardCapAt,
      perCountryLimitMs: r.perCountryLimitMs,
    };
    return start;
  }

  private progressTickMsg(now: number): S2C_ProgressTick {
    const race = this.race!;
    const lang = this.config!.lang;
    const players = [...this.players.values()] // 이탈자도 state:'left'로 표시
      .map((p) => {
        const lp = this.liveProgress.get(p.playerId);
        const id = race.countryIds[p.nextIndex];
        const country = id ? COUNTRY_BY_ID.get(id) : undefined;
        const need = country ? requiredKeystrokes(country, lang) : 0;
        const ksPct =
          p.finishedAt !== null ? 100 : need > 0 && lp ? Math.min(100, Math.round((Math.min(lp.ks, need) / need) * 100)) : 0;
        const state: 'racing' | 'finished' | 'grace' | 'left' =
          p.finishedAt !== null ? 'finished' : p.connState === 'grace' ? 'grace' : p.connState === 'left' ? 'left' : 'racing';
        return { id: p.playerId, idx: p.nextIndex, ksPct, combo: p.combo, state, rank: p.rank };
      });
    return { v: 1, type: 'progress-tick', at: now, players };
  }

  private acceptedMsg(
    seq: number,
    p: PlayerRecord,
    serverElapsedMs: number,
    finished: boolean,
  ): ServerMessage {
    return {
      v: 1,
      type: 'country-accepted',
      ack: seq,
      idx: p.nextIndex - 1,
      nextIdx: p.nextIndex,
      serverElapsedMs,
      combo: p.combo,
      finished,
      rank: finished ? p.rank : null,
    };
  }

  private broadcastPlayerFinished(p: PlayerRecord, elapsedMs: number): void {
    // 직전 완주자와 격차 ≤ 1000ms → photoFinish(§5.1-4).
    const others = [...this.players.values()].filter(
      (x) => x.playerId !== p.playerId && x.finishedAt !== null,
    );
    const prevFinishAt = others.reduce<number | null>((acc, x) => {
      if (x.finishedAt === null) return acc;
      if (acc === null || x.finishedAt > acc) return x.finishedAt;
      return acc;
    }, null);
    const photoFinish = prevFinishAt !== null && p.finishedAt !== null && p.finishedAt - prevFinishAt <= 1000;
    this.broadcast({
      v: 1,
      type: 'player-finished',
      playerId: p.playerId,
      rank: p.rank ?? 0,
      elapsedMs,
      photoFinish,
    });
  }

  private rematchStateMsg(): ServerMessage {
    const votes = this.activePlayers()
      .filter((p) => !p.isBot)
      .map((p) => ({ playerId: p.playerId, vote: this.rematchVotes.has(p.playerId) ? this.rematchVotes.get(p.playerId)! : null }));
    return { v: 1, type: 'rematch-state', votes, deadline: this.alarms.voteDeadline ?? 0 };
  }

  private raceSyncMsg(p: PlayerRecord): ServerMessage {
    const start = this.startMsg() as S2C_Start;
    const now = this.now();
    const wirePhase = (this.phase === 'COUNTDOWN' || this.phase === 'RACING' || this.phase === 'FINISHED'
      ? this.phase
      : 'RACING') as 'COUNTDOWN' | 'RACING' | 'FINISHED';
    return {
      v: 1,
      type: 'race-sync',
      phase: wirePhase,
      start,
      me: {
        nextIdx: p.nextIndex,
        serverElapsedMs: this.race ? now - this.race.startAt : 0,
        combo: p.combo,
        errorKeystrokes: p.errorKeystrokes,
      },
      tick: this.progressTickMsg(now),
    };
  }

  private errorMsg(
    code:
      | 'BAD_MESSAGE'
      | 'ROOM_FULL'
      | 'ROOM_NOT_FOUND'
      | 'WRONG_PHASE'
      | 'NOT_HOST'
      | 'DATA_VERSION'
      | 'RATE_LIMIT'
      | 'AUTH_FAILED'
      | 'NICKNAME_INVALID',
    message: string,
  ): ServerMessage {
    return { v: 1, type: 'error', code, message };
  }

  // ───────────────────────── 소소한 유틸 ─────────────────────────

  private playerOf(ws: WebSocket): PlayerRecord | null {
    const id = this.att(ws).playerId;
    if (!id) return null;
    return this.players.get(id) ?? null;
  }

  private activePlayers(): PlayerRecord[] {
    return [...this.players.values()].filter((p) => p.connState !== 'left');
  }

  private metaOf(playerId: string): PlayerMeta {
    let m = this.meta.get(playerId);
    if (!m) {
      m = { isGuest: true, rttMs: null, skipped: 0, leftAt: null };
      this.meta.set(playerId, m);
    }
    // 구버전 저장본(skipped/leftAt 부재) 방어적 백필.
    if (typeof m.skipped !== 'number') m.skipped = 0;
    if (m.leftAt === undefined) m.leftAt = null;
    return m;
  }

  private randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
