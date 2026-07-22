// spec: docs/05 §2.3(퀵매치 REST)·§2.4(방 생성/참가)·§4(hello/join/ready/chat)·§6(timesync)·
//       §7.2(재접속 resume)·§13-F7(DATA_VERSION 리로드), docs/03 §6.1(연결 관리자)·§6.4(latency)·
//       §6.6(서버 권위), docs/00 §11-D8(REST 퀵매치+/ws/room/:code)·D18(오리진=PUBLIC_ORIGIN,
//       하드코딩 금지)·D38(user_id=pid), WT-M4-03
//
// 멀티 진입 오케스트레이션 훅: REST 그랜트 취득 → WsManager 접속 → hello/join → 메시지 라우팅
// (welcome/room-state/timesync는 여기서, 레이스 메시지는 RaceClient로 위임). 고빈도 값(진행/입력)은
// 스토어에 싣지 않는다(§4.5) — RaceClient가 명령형으로 소비한다. 레이스 엔진/입력 컨트롤러는
// GameView(WT-M4-04)가 소유하므로 attachRace()로 나중에 배선한다.
import { useCallback, useEffect, useRef } from 'react';
import { apiClient, ensureSession, getSessionToken } from '../../net/api-client';
import { getBootData } from '../../app/bootLoader';
import { useSettingsStore } from '../../stores/settings';
import { useMultiplayerStore, type RoomState } from '../../stores/multiplayer';
import { WsManager, type ClientMessageDraft } from '../../net/ws-manager';
import { Timesync } from './timesync';
import { RaceClient, type RaceClientDeps, type RaceStore } from './race-client';
import type { ServerMessage, S2C_RoomState } from '@wt/shared';

/** WS 티켓을 붙인 절대 URL(ws/wss). 오리진은 PUBLIC_ORIGIN(미설정 시 현재 오리진, §11-D18). */
export function toWsUrl(wsPath: string, ticket: string, origin: string): string {
  const u = new URL(wsPath, origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('ticket', ticket);
  return u.toString();
}

/** hello 초안 조립. 세션 토큰이 있으면 session, 없으면 guest 인증. resume는 재접속 시에만. */
export function buildHello(args: {
  dataVersion: string;
  sessionToken: string | null;
  guestId: string;
  resume?: { playerId: string; resumeKey: string };
}): ClientMessageDraft {
  const auth = args.sessionToken
    ? ({ kind: 'session', token: args.sessionToken } as const)
    : ({ kind: 'guest', guestId: args.guestId } as const);
  return {
    v: 1,
    type: 'hello',
    auth,
    dataVersion: args.dataVersion,
    ...(args.resume ? { resume: args.resume } : {}),
  };
}

/** S2C_RoomState.phase(대문자) → 스토어 RoomState.phase(소문자) 매핑. */
function mapPhase(phase: S2C_RoomState['phase']): RoomState['phase'] {
  switch (phase) {
    case 'WAITING':
      return 'waiting';
    case 'COUNTDOWN':
      return 'countdown';
    case 'RACING':
      return 'racing';
    case 'FINISHED':
      return 'result';
  }
}

interface WsGrant {
  roomCode: string;
  wsUrl: string;
  ticket: string;
  lang: 'ko' | 'en';
}

export interface AttachRaceBindings {
  engine: RaceClientDeps['engine'];
  inputEvents: RaceClientDeps['inputEvents'];
  flushInput: () => void;
}

const DATA_VERSION_CLOSE = 4426;

export function useMultiplayer() {
  const wsRef = useRef<WsManager | null>(null);
  const timesyncRef = useRef<Timesync | null>(null);
  const raceRef = useRef<RaceClient | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const resumeKeyRef = useRef<string | null>(null);
  const grantRef = useRef<WsGrant | null>(null);

  const store = useMultiplayerStore;

  const publicOrigin =
    (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');

  const routeMessage = useCallback((m: ServerMessage): void => {
    switch (m.type) {
      case 'welcome':
        playerIdRef.current = m.playerId;
        resumeKeyRef.current = m.resumeKey;
        break;
      case 'room-state':
        store.getState().setRoom({
          code: m.roomCode,
          hostId: m.hostId,
          lang: m.config.lang,
          players: m.players,
          phase: mapPhase(m.phase),
        });
        break;
      case 'timesync':
        timesyncRef.current?.onReply(m);
        break;
      case 'error':
        // DATA_VERSION은 close(4426)가 뒤따르므로 onClose에서 리로드한다. 그 외는 상위 UI(M4-04)가
        // room-state/토스트로 표시한다.
        break;
      default:
        break;
    }
    // 레이스 관련 메시지는 RaceClient로 위임(start/tick/accepted/rejected/race-sync/results).
    raceRef.current?.handleMessage(m);
  }, [store]);

  const connectWithGrant = useCallback(
    (grant: WsGrant): void => {
      grantRef.current = grant;
      store.getState().setRoom({
        code: grant.roomCode,
        hostId: '',
        lang: grant.lang,
        players: [],
        phase: 'waiting',
      });

      const ws = new WsManager();
      wsRef.current = ws;
      const timesync = new Timesync({
        now: () => performance.now(),
        send: (t0) => ws.send({ v: 1, type: 'timesync', t0 }),
        schedule: (cb, ms) => {
          const id = setTimeout(cb, ms);
          return () => clearTimeout(id);
        },
      });
      timesyncRef.current = timesync;

      ws.onStateChange((s) => {
        store.getState().setConnection(s);
        if (s === 'open') {
          const boot = safeDataVersion();
          ws.send(
            buildHello({
              dataVersion: boot,
              sessionToken: getSessionToken(),
              guestId: useSettingsStore.getState().guestId,
              resume:
                playerIdRef.current && resumeKeyRef.current
                  ? { playerId: playerIdRef.current, resumeKey: resumeKeyRef.current }
                  : undefined,
            }),
          );
          timesync.start();
        }
      });
      ws.onMessage(routeMessage);
      ws.onClose((code) => {
        timesync.stop();
        if (code === DATA_VERSION_CLOSE && typeof window !== 'undefined') {
          window.location.reload(); // F7: 새 버전 강제 리로드
        }
      });

      ws.connect(toWsUrl(grant.wsUrl, grant.ticket, publicOrigin));
    },
    [publicOrigin, routeMessage, store],
  );

  const quickMatch = useCallback(
    async (lang: 'ko' | 'en'): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant & { mode: string }>('/match/quick', { lang });
      connectWithGrant(grant);
    },
    [connectWithGrant],
  );

  const createRoom = useCallback(
    async (opts: { lang: 'ko' | 'en'; maxPlayers?: number; isPublic?: boolean }): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant>('/rooms', { ...opts, mode: 'race-mixed' });
      connectWithGrant(grant);
    },
    [connectWithGrant],
  );

  const join = useCallback(
    async (code: string, lang?: 'ko' | 'en'): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant>(`/rooms/${code}/join`, lang ? { lang } : {});
      connectWithGrant(grant);
    },
    [connectWithGrant],
  );

  const sendDraft = useCallback((draft: ClientMessageDraft): number | null => {
    return wsRef.current ? wsRef.current.send(draft) : null;
  }, []);

  const ready = useCallback(
    (isReady: boolean) => sendDraft({ v: 1, type: 'ready', ready: isReady }),
    [sendDraft],
  );
  const startRace = useCallback(() => sendDraft({ v: 1, type: 'start' }), [sendDraft]);
  const chat = useCallback((text: string) => sendDraft({ v: 1, type: 'chat', text }), [sendDraft]);
  const rematch = useCallback(
    (vote: boolean) => sendDraft({ v: 1, type: 'rematch', vote }),
    [sendDraft],
  );
  const joinRoom = useCallback(
    (nickname: string, passportCover: string, joinTicket?: string) =>
      sendDraft({
        v: 1,
        type: 'join',
        nickname,
        passportCover,
        ...(joinTicket ? { joinTicket } : {}),
      }),
    [sendDraft],
  );

  const leave = useCallback(() => {
    raceRef.current?.destroy();
    raceRef.current = null;
    timesyncRef.current?.stop();
    timesyncRef.current = null;
    if (wsRef.current) {
      wsRef.current.send({ v: 1, type: 'leave' });
      wsRef.current.close(1000);
      wsRef.current = null;
    }
    playerIdRef.current = null;
    resumeKeyRef.current = null;
    store.getState().reset();
  }, [store]);

  /** GameView(WT-M4-04)가 엔진/입력 컨트롤러를 마운트한 뒤 레이스 브리지를 배선한다. */
  const attachRace = useCallback((bindings: AttachRaceBindings): (() => void) => {
    const ws = wsRef.current;
    const timesync = timesyncRef.current;
    if (!ws || !timesync) return () => {};
    const storeAdapter: RaceStore = {
      upsertOpponent: (id, patch) => store.getState().upsertOpponent(id, patch),
      clearOpponents: () => store.getState().clearOpponents(),
      setServerAck: (ack) => store.getState().setServerAck(ack),
      setRaceResult: (result) => store.getState().setRaceResult(result),
    };
    const race = new RaceClient({
      engine: bindings.engine,
      inputEvents: bindings.inputEvents,
      flushInput: bindings.flushInput,
      send: (draft) => ws.send(draft),
      offsetMs: () => timesync.getOffset(),
      now: () => performance.now(),
      onDesync: () => {
        // F12: 재동기 = 재연결 절차 재사용. 소켓을 끊으면 hello(resume)→race-sync가 따라온다.
        ws.close(1000);
        if (grantRef.current) connectWithGrant(grantRef.current);
      },
      store: storeAdapter,
    });
    raceRef.current = race;
    race.attach();
    return () => {
      race.destroy();
      if (raceRef.current === race) raceRef.current = null;
    };
  }, [connectWithGrant, store]);

  // 언마운트 시 정리(페이지 이탈은 WsManager의 pagehide close가 별도로 처리).
  useEffect(() => {
    return () => {
      raceRef.current?.destroy();
      timesyncRef.current?.stop();
      wsRef.current?.close(1000);
    };
  }, []);

  return {
    quickMatch,
    createRoom,
    join,
    joinRoom,
    ready,
    startRace,
    chat,
    rematch,
    leave,
    attachRace,
  };
}

function safeDataVersion(): string {
  try {
    return getBootData().dataVersion;
  } catch {
    return 'unknown'; // 부트 전(직접 진입) 방어 — 서버가 DATA_VERSION으로 거를 수 있게 원문 전달
  }
}
