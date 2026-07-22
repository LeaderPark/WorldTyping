// spec: docs/05 §2.1(토폴로지)·§2.3(퀵매치 흐름 — openRoom 좌석 배정/회수·자동 시작·봇 오퍼)·
//       §2.2(방 코드)·§13-F6(openRoom 레이스), docs/04 §5.3(WS 티켓), docs/00 §11-D8(REST 퀵매치
//       + WS /ws/room/:code, LobbyDO 폐기)·§11-D17(방 코드)·§11-D23(v1 race-mixed만) + WT-M4-02
//
// 언어×모드별 1개(idFromName 'mm:{lang}:race-mixed', §2.1). 퀵매치 요청을 받아 "채워지는 중인 열린
// 방"(openRoom)에 좌석을 배정하거나 새 방을 발급한다. 자동 시작(4인 즉시 / 2~3인 15초)과 봇 오퍼
// (1인 60초)는 실제 WS 입장 인원을 아는 MatchRoom이 판정한다(§2.3-4·5, WT-M4-01 maybeAutoStart) —
// Matchmaker는 방 배정·좌석 회계·좌석 30초 회수만 담당한다.
//
// 좌석 회계 모델: openRoom의 점유(occupancy)를 별도 카운터가 아니라 max(실제 입장 인원, 30초 내
// 미소진 예약 수)로 매 요청 시 산출한다. 예약(reservation)은 "곧 WS로 입장할 좌석"의 30초 약속이며,
// 만료(§2.3 "30초 내 미입장 좌석 회수")·취소 시 사라진다. 실제 입장 인원은 MatchRoom
// internal/room-status로 조회 — 이것이 openRoom 신선도(F6: 이미 시작된 방)의 단일 진실이다.

import type { Env } from '../env';
import { signWsTicket } from '@wt/shared';
import { claimRoomCode } from '../lib/room-code';
import { logError } from '../lib/log';
import { captureException } from '../lib/reporter';

const QUICK_MODE = 'race-mixed' as const; // §11-D23: v1 퀵매치는 race-mixed만
const QUICK_MAX_PLAYERS = 8; // 방 config 상한(§2.4). 실제 봉인은 fillTarget에서.
const QUICK_FILL_TARGET = 4; // 4인 도달 시 MatchRoom 즉시 COUNTDOWN(§2.3-4) → openRoom 봉인 기준
const RESERVE_TTL_MS = 30_000; // §2.3: WS join 30초 미도래 좌석 회수

/** 채워지는 중인 열린 방. seatsLeft를 별도 카운터로 두지 않는다(occupancy 산출식 참조). */
interface OpenRoom {
  roomCode: string;
  maxPlayers: number;
  fillTarget: number;
}

/** 배정된(아직 WS join 미확인) 좌석 예약. 키 = 티켓 서명부. */
interface Reservation {
  roomCode: string;
  playerId: string;
  expiresAt: number;
}

interface RoomStatus {
  phase: string;
  players: number;
  maxPlayers: number;
  roomCode: string | null;
  lang?: string | null;
}

interface QuickResult {
  roomCode: string;
  ticket: string;
  wsUrl: string;
  mode: string;
  lang: string;
  /** F6 계약: 배정된 방이 이미 시작돼 WS join이 WRONG_PHASE면 클라는 quick을 1회 자동 재요청한다. */
  retryOnWrongPhase: true;
}

export class MatchmakerDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  private hydrated = false;
  private openRoom: OpenRoom | null = null;
  private reservations: Record<string, Reservation> = {};

  // --- 테스트 seam(생산 미사용) ---
  private testClock: number | null = null;
  /** 방 코드 생성기 주입(충돌 재생성 경로 재현용). null이면 room-code.ts 기본(crypto). */
  private codeGen: (() => string) | null = null;
  private now(): number {
    return this.testClock ?? Date.now();
  }

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state;
    this.env = env;
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    const [openRoom, reservations] = await Promise.all([
      this.ctx.storage.get<OpenRoom>('openRoom'),
      this.ctx.storage.get<Record<string, Reservation>>('reservations'),
    ]);
    this.openRoom = openRoom ?? null;
    this.reservations = reservations ?? {};
    this.hydrated = true;
  }

  private async persistAndSchedule(): Promise<void> {
    await this.ctx.storage.put('openRoom', this.openRoom);
    await this.ctx.storage.put('reservations', this.reservations);
    // 다음 alarm = 가장 이른 예약 만료(§2.3 좌석 30초 회수). 없으면 alarm 해제.
    let next: number | null = null;
    for (const r of Object.values(this.reservations)) {
      if (next === null || r.expiresAt < next) next = r.expiresAt;
    }
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  // ───────────────────────── fetch: 내부 API(Worker가 호출) ─────────────────────────

  async fetch(request: Request): Promise<Response> {
    // 최상위 catch(docs/06 §8 Sentry DO 연결) — handleQuick 자체 catch 밖의 예외(hydrate 실패 등)까지
    // 가로챈다.
    try {
      await this.ensureHydrated();
      const path = new URL(request.url).pathname;
      if (path.endsWith('/internal/quick')) return await this.handleQuick(request);
      if (path.endsWith('/internal/cancel')) return await this.handleCancel(request);
      if (path.endsWith('/internal/debug')) return await this.handleDebug();
      return new Response('Not found', { status: 404 });
    } catch (err) {
      logError('do_matchmaker_fetch_unhandled', { message: err instanceof Error ? err.message : String(err) });
      captureException(this.env, err, { request, tag: 'do:Matchmaker.fetch' });
      return new Response('internal error', { status: 500 });
    }
  }

  private async handleQuick(request: Request): Promise<Response> {
    let body: { lang?: string; playerId?: string };
    try {
      body = (await request.json()) as { lang?: string; playerId?: string };
    } catch {
      return new Response('bad body', { status: 400 });
    }
    const lang = body.lang === 'en' ? 'en' : body.lang === 'ko' ? 'ko' : null;
    const playerId = typeof body.playerId === 'string' ? body.playerId : null;
    if (!lang || !playerId) return new Response('bad params', { status: 400 });
    try {
      const result = await this.assignQuick(lang, playerId);
      return Response.json(result);
    } catch (err) {
      logError('matchmaker_quick_assign_failed', { message: err instanceof Error ? err.message : String(err) });
      return new Response('assign failed', { status: 500 });
    }
  }

  /** §2.3 절차. openRoom 신선도 검사 → 좌석 배정 or 새 방 발급 → 예약 등록 → fillTarget 봉인. */
  private async assignQuick(lang: 'ko' | 'en', playerId: string): Promise<QuickResult> {
    const now = this.now();
    this.pruneReservations(now); // 만료 좌석 회수(§2.3)

    // openRoom 신선도(F6): 이미 시작됐거나 만석이면 폐기하고 새 방으로.
    let statusPlayers = 0;
    if (this.openRoom) {
      const status = await this.roomStatus(this.openRoom.roomCode);
      if (!status || !isJoinablePhase(status.phase) || status.players >= this.openRoom.maxPlayers) {
        this.openRoom = null;
      } else {
        statusPlayers = status.players;
        const occupancy = Math.max(statusPlayers, this.reservationsForRoom(this.openRoom.roomCode));
        if (occupancy >= this.openRoom.fillTarget) this.openRoom = null; // 충분히 참 — 새 방
      }
    }

    let roomCode: string;
    if (this.openRoom) {
      roomCode = this.openRoom.roomCode;
    } else {
      roomCode = await claimRoomCode(this.env.MATCH_ROOM, {
        gen: this.codeGen ?? undefined,
      });
      await this.createRoom(roomCode, lang);
      this.openRoom = { roomCode, maxPlayers: QUICK_MAX_PLAYERS, fillTarget: QUICK_FILL_TARGET };
      statusPlayers = 0;
    }

    // 좌석 예약 + 1회용 WS 티켓 서명(RUN_HMAC_SECRET, 60초 — @wt/shared 재사용, 재구현 금지).
    const ticket = await signWsTicket(this.env.RUN_HMAC_SECRET, playerId, roomCode);
    const key = ticketKey(ticket);
    this.reservations[key] = { roomCode, playerId, expiresAt: now + RESERVE_TTL_MS };

    // 이 배정으로 fillTarget 도달 시 openRoom 봉인(다음 요청자는 새 방 — 4인 즉시 성사 경계).
    const occupancy = Math.max(statusPlayers, this.reservationsForRoom(roomCode));
    if (this.openRoom && occupancy >= this.openRoom.fillTarget) this.openRoom = null;

    await this.persistAndSchedule();
    return {
      roomCode,
      ticket,
      wsUrl: `/ws/room/${roomCode}`,
      mode: QUICK_MODE,
      lang,
      retryOnWrongPhase: true,
    };
  }

  private async handleCancel(request: Request): Promise<Response> {
    let body: { ticket?: string; playerId?: string };
    try {
      body = (await request.json()) as { ticket?: string; playerId?: string };
    } catch {
      return new Response('bad body', { status: 400 });
    }
    if (typeof body.ticket !== 'string') return new Response('bad params', { status: 400 });
    const key = ticketKey(body.ticket);
    const r = this.reservations[key];
    // 본인 좌석만 취소(playerId 대조). 예약이 사라지면 occupancy 산출식이 좌석을 자동 반환한다.
    if (r && (body.playerId === undefined || r.playerId === body.playerId)) {
      delete this.reservations[key];
      await this.persistAndSchedule();
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false });
  }

  private handleDebug(): Response {
    return Response.json({
      openRoom: this.openRoom,
      reservationCount: Object.keys(this.reservations).length,
      reservations: Object.entries(this.reservations).map(([k, r]) => ({
        key: k.slice(0, 8),
        roomCode: r.roomCode,
        playerId: r.playerId,
        expiresAt: r.expiresAt,
      })),
    });
  }

  // ───────────────────────── alarm: 좌석 30초 회수(§2.3) ─────────────────────────

  async alarm(): Promise<void> {
    await this.ensureHydrated();
    const now = this.now();
    this.pruneReservations(now);
    // openRoom이 죽은 방을 가리키면 정리(다음 요청이 새 방을 만들도록).
    if (this.openRoom) {
      const status = await this.roomStatus(this.openRoom.roomCode);
      if (!status || !isJoinablePhase(status.phase) || status.players >= this.openRoom.maxPlayers) {
        this.openRoom = null;
      }
    }
    await this.persistAndSchedule();
  }

  // ───────────────────────── 헬퍼 ─────────────────────────

  private pruneReservations(now: number): void {
    for (const [k, r] of Object.entries(this.reservations)) {
      if (r.expiresAt <= now) delete this.reservations[k];
    }
  }

  private reservationsForRoom(roomCode: string): number {
    let n = 0;
    for (const r of Object.values(this.reservations)) if (r.roomCode === roomCode) n += 1;
    return n;
  }

  private async roomStatus(roomCode: string): Promise<RoomStatus | null> {
    const id = this.env.MATCH_ROOM.idFromName('room:' + roomCode);
    const res = await this.env.MATCH_ROOM.get(id).fetch('http://do/internal/room-status');
    if (!res.ok) return null;
    return (await res.json()) as RoomStatus;
  }

  private async createRoom(roomCode: string, lang: 'ko' | 'en'): Promise<void> {
    const id = this.env.MATCH_ROOM.idFromName('room:' + roomCode);
    const res = await this.env.MATCH_ROOM.get(id).fetch('http://do/internal/create', {
      method: 'POST',
      body: JSON.stringify({
        config: {
          roomCode,
          lang,
          mode: QUICK_MODE,
          poolParam: null,
          maxPlayers: QUICK_MAX_PLAYERS,
          isPublic: false,
          quickMatch: true,
        },
      }),
    });
    if (!res.ok) throw new Error(`Matchmaker: internal/create failed (${res.status})`);
  }
}

/** 티켓 서명부(고유)를 맵 키로 쓴다 — MatchRoom.consumeTicket과 동일 규약(값 전체보다 짧다). */
function ticketKey(ticket: string): string {
  return ticket.split('.')[2] ?? ticket;
}

function isJoinablePhase(phase: string): boolean {
  return phase === 'WAITING' || phase === 'CREATED';
}
