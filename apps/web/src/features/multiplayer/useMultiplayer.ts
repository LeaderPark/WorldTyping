// spec: docs/05 §2.3(퀵매치 REST)·§2.4(방 생성/참가)·§4(hello/join/ready/chat)·§6(timesync)·
//       §7.2(재접속 resume)·§13-F7(DATA_VERSION 리로드), docs/03 §6.1(연결 관리자)·§6.4(latency)·
//       §6.6(서버 권위), docs/00 §11-D8(REST 퀵매치+/ws/room/:code)·D18(오리진=PUBLIC_ORIGIN,
//       하드코딩 금지)·D38(user_id=pid), WT-M4-03, WT-M4-04(로비/대기실/레이스 UI 배선 — identity
//       자동 join·chat/rematch-state/bot-offer/room-closed/race-finished 스토어 반영·latency 배선·
//       attachRace의 raceReplay 재생)
//
// 멀티 진입 오케스트레이션 훅: REST 그랜트 취득 → WsManager 접속 → hello/join → 메시지 라우팅
// (welcome/room-state/timesync는 여기서, 레이스 메시지는 RaceClient로 위임). 고빈도 값(진행/입력)은
// 스토어에 싣지 않는다(§4.5) — RaceClient가 명령형으로 소비한다. 레이스 엔진/입력 컨트롤러는
// GameView(WT-M4-04)가 소유하므로 attachRace()로 나중에 배선한다.
import { useCallback, useEffect, useRef } from 'react';
import { apiClient, ApiError, ensureSession, getAuthToken, getSessionToken } from '../../net/api-client';
import { getBootData } from '../../app/bootLoader';
import { useSettingsStore } from '../../stores/settings';
import { useMultiplayerStore, type RoomState } from '../../stores/multiplayer';
import {
  ReconnectAbortError,
  WsManager,
  type ClientMessageDraft,
  type ReconnectUrlProvider,
} from '../../net/ws-manager';
import { Timesync } from './timesync';
import { RaceClient, type RaceClientDeps, type RaceStore } from './race-client';
import type { ServerMessage, S2C_RoomState } from '@wt/shared';

/** join 메시지에 실을 신원(닉네임/여권 커버) — quickMatch/createRoom/join/connectWithGrant 공통.
 *  WT-M4-04: 방 진입 경로가 무엇이든 hello 직후 이 신원으로 join을 자동 전송해, RoomPage가
 *  별도로 joinRoom()을 호출하지 않아도 되게 한다(서버는 재입장 시 동일 처리 — MatchRoom.onJoin). */
export interface PlayerIdentity {
  nickname: string;
  passportCover: string;
}

/** WS 티켓을 붙인 절대 URL(ws/wss). 오리진은 PUBLIC_ORIGIN(미설정 시 현재 오리진, §11-D18). */
export function toWsUrl(wsPath: string, ticket: string, origin: string): string {
  const u = new URL(wsPath, origin);
  // http→ws / https→wss. 오리진이 이미 ws/wss면 그 보안 여부를 보존한다(프로덕션은 http(s)
  // 오리진만 넘기므로 동작 불변 — VITE_WS_BASE(wss)로 붙는 E2E mock 경로에서만 wss가 유지된다).
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
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

export interface WsGrant {
  roomCode: string;
  wsUrl: string;
  ticket: string;
  lang: 'ko' | 'en';
  /** [WT-AUTH-05] 로비 방 제목(§11-D68-⑧). create는 요청 제목, join은 방의 저장 제목을 싣는다.
   *  대기실 헤더 표시 전용(WS 무확장) — 없으면 null(퀵매치·제목 미지정 방). */
  title: string | null;
}

export interface AttachRaceBindings {
  engine: RaceClientDeps['engine'];
  inputEvents: RaceClientDeps['inputEvents'];
  flushInput: () => void;
}

const DATA_VERSION_CLOSE = 4426;

/** [§11-D89] 재발급 REST(POST /rooms/:code/join) 응답이 "재시도 무의미"(방 소멸/진행 중/만원/인증
 *  소실)임을 알리는 터미널 코드 집합. 이 코드면 잔여 재연결 시도 없이 즉시 failed(사유별 기존
 *  i18n 키 표기 — 신규 키 0). WS 업그레이드 4xx는 브라우저에 1006으로만 보이므로 판별기는 REST의
 *  ApiError.code다. */
const TERMINAL_REJOIN: ReadonlySet<string> = new Set([
  'ROOM_NOT_FOUND',
  'ROOM_IN_PROGRESS',
  'ROOM_FULL',
  'LOGIN_REQUIRED',
  'INVALID_TOKEN',
]);

/** [§11-D89] 재발급 에러를 터미널(재시도 무의미) vs 일시(백오프 지속)로 분류하는 순수 판별기. */
export function isTerminalRejoinError(err: unknown): err is ApiError {
  return err instanceof ApiError && TERMINAL_REJOIN.has(err.code);
}

/** [§11-D89] AUTH_FAILED 무-resume hello 재시도 조건(순수). WAITING 절단=즉시 퇴장(서버 F10)이라
 *  재연결 hello{resume}는 'resume rejected'로 거부된다 → 이미 신원(playerId)을 받았고 아직 이번
 *  연결에서 재시도하지 않았을 때만 1회 무-resume 재수립을 허용한다. */
export function shouldRetryHelloNoResume(
  code: string,
  alreadyRetried: boolean,
  hasPlayerId: boolean,
): boolean {
  return code === 'AUTH_FAILED' && !alreadyRetried && hasPlayerId;
}

export function useMultiplayer() {
  const wsRef = useRef<WsManager | null>(null);
  const timesyncRef = useRef<Timesync | null>(null);
  const raceRef = useRef<RaceClient | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const resumeKeyRef = useRef<string | null>(null);
  const grantRef = useRef<WsGrant | null>(null);
  // [§11-D89] join 신원 보존 — onDesync의 identity 없는 connectWithGrant 재호출에서도 유지한다.
  const identityRef = useRef<PlayerIdentity | null>(null);
  // [§11-D89] 이번 연결 세대에서 무-resume hello 재시도를 이미 했는지(매 'open'마다 false로 리셋).
  const helloRetriedRef = useRef(false);

  const store = useMultiplayerStore;

  const publicOrigin =
    (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');

  // 테스트 전용(WT-M4-06): VITE_WS_BASE가 있으면 WS만 그 오리진(e2e mock-do-server)으로 붙는다.
  // 프로덕션 빌드엔 이 변수가 없어 ?? 좌변이 정적 undefined로 제거된다 → 오리진=publicOrigin(§11-D18)
  // 그대로. REST/자산 오리진(publicOrigin)은 건드리지 않는다 — E2E는 mock WS만 갈아끼운다.
  const wsOrigin = (import.meta.env.VITE_WS_BASE as string | undefined) ?? publicOrigin;

  const routeMessage = useCallback((m: ServerMessage): void => {
    switch (m.type) {
      case 'welcome':
        playerIdRef.current = m.playerId;
        resumeKeyRef.current = m.resumeKey;
        store.getState().setMyPlayerId(m.playerId);
        break;
      case 'room-state':
        store.getState().setRoom({
          code: m.roomCode,
          hostId: m.hostId,
          lang: m.config.lang,
          players: m.players,
          phase: mapPhase(m.phase),
          maxPlayers: m.config.maxPlayers,
          isPublic: m.config.isPublic,
          autoStartAt: m.autoStartAt,
        });
        break;
      case 'timesync':
        timesyncRef.current?.onReply(m);
        store.getState().setLatency(timesyncRef.current?.getRttMs() ?? 0);
        break;
      case 'start':
        // RaceView 엔진 구성 원천 캐시(store 주석 참조) — attachRace가 아직 안 붙었을 수 있어
        // RaceClient 위임과 별개로 여기서 캐시해둔다.
        store.getState().setRaceReplay(m);
        // [WT-FIX-FINISH-TRANSITION] 새 레이스(최초 시작 또는 리매치) 시작 시 이전 레이스의
        // raceResult/raceFinishedReason을 클리어한다 — RoomPage의 결과 화면 폴백 게이트
        // (room.phase === 'result' || raceFinishedReason !== null)가 리매치 카운트다운 취소(F8)로
        // WAITING 복귀 후에도 stale raceResult를 오표출하지 않도록 하는 회귀 방지.
        store.getState().setRaceResult(null);
        store.getState().setRaceFinishedReason(null);
        break;
      case 'race-sync':
        store.getState().setRaceReplay(m);
        break;
      case 'chat':
        store.getState().pushChat({ playerId: m.playerId, text: m.text, at: m.at });
        break;
      case 'rematch-state':
        store.getState().setRematchState(m);
        break;
      case 'bot-offer':
        store.getState().setBotOffer(m);
        break;
      case 'room-closed':
        store.getState().setRoomClosedReason(m.reason);
        break;
      case 'race-finished':
        store.getState().setRaceFinishedReason(m.reason);
        break;
      case 'results':
        // 서버 결과는 raceRef(RaceClient) 위임과 별개로 여기서 직접 스토어에 반영한다. 본인이 레이스를
        // 완주하면 RaceView가 finish-wait로 전환되며 HiddenTypingInput→controller→attachRace가
        // 해제돼 raceRef가 null이 된다(useTypingEngine 라이프사이클). 그 시점 이후 도착하는 results를
        // raceRef에만 위임하면 유실돼 결과 화면이 비어버린다(E2E E6/E7에서 실측된 결함) — §6.6대로
        // results는 항상 스토어의 유일 진실로 반영되어야 하므로 라우터에서 직접 처리한다.
        store.getState().setRaceResult(m);
        break;
      case 'error':
        // [§11-D89] WAITING 절단=즉시 퇴장(서버 F10)이라 재연결 hello{resume}는 'resume rejected'로
        // AUTH_FAILED된다. 신원 재수립: resume 자격을 버리고 무-resume hello + join을 같은 소켓에서
        // 1회 조용히(lastError 미설정) 재시도한다. 재시도 후에도 AUTH_FAILED면(세션 토큰 무효) 아래
        // 기존 표출 경로로 폴스루. mock 서버는 resume이 항상 성립(F12)이라 이 분기는 미발화(E7 불변).
        if (shouldRetryHelloNoResume(m.code, helloRetriedRef.current, playerIdRef.current !== null)) {
          helloRetriedRef.current = true;
          playerIdRef.current = null;
          resumeKeyRef.current = null;
          wsRef.current?.send(
            buildHello({
              dataVersion: safeDataVersion(),
              sessionToken: getAuthToken() ?? getSessionToken(),
              guestId: useSettingsStore.getState().guestId,
            }),
          );
          if (identityRef.current) {
            wsRef.current?.send({ v: 1, type: 'join', ...identityRef.current });
          }
          break;
        }
        // DATA_VERSION은 close(4426)가 뒤따르므로 onClose에서 리로드한다. 그 외는 상위 UI(M4-04)가
        // room-state/토스트로 표시한다.
        store.getState().setLastError({ code: m.code, message: m.message });
        break;
      default:
        break;
    }
    // 레이스 관련 메시지는 RaceClient로 위임(start/tick/accepted/rejected/race-sync/results).
    raceRef.current?.handleMessage(m);
  }, [store]);

  const connectWithGrant = useCallback(
    (grant: WsGrant, identity?: PlayerIdentity): void => {
      grantRef.current = grant;
      // [§11-D89] join 신원 보존 — onDesync는 identity 없이 재호출하므로 직전 신원을 유지한다.
      identityRef.current = identity ?? identityRef.current;
      store.getState().setRoom({
        code: grant.roomCode,
        hostId: '',
        lang: grant.lang,
        players: [],
        phase: 'waiting',
        maxPlayers: null,
        isPublic: false,
        autoStartAt: null,
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
          // [§11-D89] 새 연결 세대 시작 — 무-resume hello 재시도 가드를 리셋한다.
          helloRetriedRef.current = false;
          const boot = safeDataVersion();
          ws.send(
            buildHello({
              dataVersion: boot,
              // [WT-AUTH-05] 멀티는 로그인 필수(§11-D68) — hello 인증도 "계정 > 게스트" 우선순위로
              // 계정 토큰이 있으면 그것으로 붙어 랭킹 등재 신원과 일치시킨다(api-client bearerToken 동일 규약).
              sessionToken: getAuthToken() ?? getSessionToken(),
              guestId: useSettingsStore.getState().guestId,
              resume:
                playerIdRef.current && resumeKeyRef.current
                  ? { playerId: playerIdRef.current, resumeKey: resumeKeyRef.current }
                  : undefined,
            }),
          );
          // hello 직후 즉시 join(같은 소켓 위 순차 전송이라 서버가 순서대로 처리 — 파일 상단
          // PlayerIdentity 주석). 재접속 시에도 안전(MatchRoom.onJoin이 기존 레코드를 갱신·
          // connState를 connected로 되돌려 grace 이탈자를 복귀시킨다). identityRef로 통일해
          // onDesync의 identity 없는 재연결에서도 join 신원을 유지한다(§11-D89).
          if (identityRef.current) {
            ws.send({
              v: 1,
              type: 'join',
              nickname: identityRef.current.nickname,
              passportCover: identityRef.current.passportCover,
            });
          }
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

      // [§11-D89] WS 티켓은 1회용(60s TTL)이라 재연결마다 신규 티켓이 필요하다. 최초 연결은 직전
      // REST가 발급한 grant 티켓을 그대로 쓰고, 재연결은 reissueUrl 프로바이더로 신선 URL을 받는다.
      const staticUrl = toWsUrl(grant.wsUrl, grant.ticket, wsOrigin);
      const wsBaseSet = Boolean(import.meta.env.VITE_WS_BASE);
      const reissueUrl: ReconnectUrlProvider = wsBaseSet
        ? // E2E mock(VITE_WS_BASE)은 티켓 무검증·재연결 무제한 수용 → 정적 URL 재사용(E7 계약 보존).
          () => Promise.resolve(staticUrl)
        : async () => {
            try {
              // POST /rooms/:code/join은 멤버 미등록·grant만 발급이라 재발급 엔드포인트로 안전하다
              // (서버 무변경, §11-D89-②). WAITING/CREATED면 200+신규 티켓, 그 외 페이즈/방 소멸은 4xx.
              const g = await apiClient.post<WsGrant>(`/rooms/${grant.roomCode}/join`, {});
              grantRef.current = { ...grantRef.current!, ...g }; // 최신 grant 갱신(onDesync 경로 공유).
              return toWsUrl(g.wsUrl, g.ticket, wsOrigin);
            } catch (err) {
              if (isTerminalRejoinError(err)) {
                // RoomPage 실패 화면 사유 표기용(기존 i18n 키) + 잔여 시도 없이 즉시 중단.
                store.getState().setLastError({ code: err.code, message: err.message });
                throw new ReconnectAbortError(err.code);
              }
              throw err; // 일시 실패 — ws-manager가 시도 1회 소모 후 백오프 지속.
            }
          };

      ws.connect(staticUrl, reissueUrl);
    },
    [wsOrigin, routeMessage, store],
  );

  const quickMatch = useCallback(
    async (lang: 'ko' | 'en', identity: PlayerIdentity): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant & { mode: string }>('/match/quick', { lang });
      connectWithGrant(grant, identity);
    },
    [connectWithGrant],
  );

  const createRoom = useCallback(
    async (
      opts: { lang: 'ko' | 'en'; maxPlayers?: number; isPublic?: boolean },
      identity: PlayerIdentity,
    ): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant>('/rooms', { ...opts, mode: 'race-mixed' });
      connectWithGrant(grant, identity);
    },
    [connectWithGrant],
  );

  const join = useCallback(
    async (code: string, identity: PlayerIdentity, lang?: 'ko' | 'en'): Promise<void> => {
      await ensureSession(useSettingsStore.getState().guestId);
      const grant = await apiClient.post<WsGrant>(`/rooms/${code}/join`, lang ? { lang } : {});
      connectWithGrant(grant, identity);
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
  const botAccept = useCallback(
    (accept: boolean) => {
      store.getState().setBotOffer(null); // 즉시 닫기(서버 응답은 room-state로 뒤따름)
      return sendDraft({ v: 1, type: 'bot-accept', accept });
    },
    [sendDraft, store],
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
    identityRef.current = null; // [§11-D89] 다음 연결이 낡은 신원을 재사용하지 않게.
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
    // 닭-달걀 해소(store.ts RaceReplayMessage 주석): 엔진(및 이 RaceClient)은 'start'/'race-sync'가
    // 도착한 *뒤*에야 만들어질 수 있어, 최초 수신 시점엔 아직 RaceClient가 없어 그 메시지를 놓친다.
    // 캐시된 마지막 start/race-sync를 방금 붙은 RaceClient에 재생해 내부 상태(localStartPerf·
    // countries·raceIdx 등)를 소급 초기화한다.
    const cachedReplay = store.getState().raceReplay;
    if (cachedReplay) race.handleMessage(cachedReplay);
    return () => {
      race.destroy();
      if (raceRef.current === race) raceRef.current = null;
    };
  }, [connectWithGrant, store]);

  /** timesync.getOffset() 스냅샷(서버 epoch = 로컬 perf + offset) — RaceView가 countdown.startAt을
   *  로컬 시각으로 환산해 engine.start()를 정확히 그 순간에 스케줄링하는 데 쓴다(§6.2). */
  const getOffsetMs = useCallback(() => timesyncRef.current?.getOffset() ?? 0, []);

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
    connectWithGrant,
    ready,
    startRace,
    chat,
    rematch,
    botAccept,
    leave,
    attachRace,
    getOffsetMs,
  };
}

function safeDataVersion(): string {
  try {
    return getBootData().dataVersion;
  } catch {
    return 'unknown'; // 부트 전(직접 진입) 방어 — 서버가 DATA_VERSION으로 거를 수 있게 원문 전달
  }
}
