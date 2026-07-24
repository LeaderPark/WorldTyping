// spec: docs/01 §8.2(S10 대기실→S11 레이스→결과→리매치 흐름), docs/03 §4.1(lazy route: S10→S11
//       "동일 라우트 상태 전환")·§6.1(연결 관리자)·§6.6(서버 권위), docs/00 §11-D8(REST 퀵매치+
//       /ws/room/:code)·D17(방코드), WT-M4-04
//
// S10(대기실)→S11(레이스+결과)을 room.phase 분기로 렌더하는 이 화면의 세션 소유자. useMultiplayer
// 훅 1개를 여기서 단 한 번 만들어(WaitingRoom/RaceView/RaceResult는 그 결과만 props로 받는
// 프레젠테이션 계층) 세 하위 화면이 같은 WS 연결·타임싱크·레이스 브리지를 공유한다(GamePage가
// 엔진을 소유하고 BoardingPass/GameView/ResultView가 순수 프레젠테이션인 것과 동일한 패턴).
//
// [진입 경로 2종] (1) LobbyPage가 REST로 이미 grant를 받아 `navigate(path, {state:{grant}})`로
// 온 경우 — 그 grant로 바로 연결(중복 REST 호출 없음). (2) 초대 링크로 직접 들어온 딥링크 —
// grant가 없으므로 이 화면이 직접 join REST를 호출한다(구현 세부 지시 3 "미인증이면 bootstrap 후
// 자동 join").
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../../stores/settings';
import { selectIsLoggedIn, useAuthStore, verifyAccountSession } from '../../../stores/auth';
import { useMultiplayerStore } from '../../../stores/multiplayer';
import { useMultiplayer, type WsGrant } from '../../../features/multiplayer/useMultiplayer';
import { multiErrorKey } from '../../../features/multiplayer/error-keys';
import { WaitingRoom } from './WaitingRoom';
import { RaceView } from './RaceView';
import { RaceResult } from './RaceResult';

/** 세션 부트스트랩(workers/api/src/routes/session.ts)의 기본 여권 커버와 동일값 — v1은 코스메틱
 *  선택 UI가 없어 신규 참가자는 전부 이 값으로 join한다. */
const DEFAULT_PASSPORT_COVER = 'basic-green';

export function RoomPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ roomCode: string }>();
  const roomCode = (params.roomCode ?? '').trim().toUpperCase();

  const nickname = useSettingsStore((s) => s.nickname);
  const guestId = useSettingsStore((s) => s.guestId);

  // [WT-AUTH-05] 멀티 로그인 게이트(§11-D68) — 딥링크 진입은 로비 게이트를 거치지 않아 여기서 검사.
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openLogin = useAuthStore((s) => s.openLogin);
  const loginReason = useAuthStore((s) => s.loginReason);

  const mp = useMultiplayer();
  const connection = useMultiplayerStore((s) => s.connection);
  const room = useMultiplayerStore((s) => s.room);
  const myPlayerId = useMultiplayerStore((s) => s.myPlayerId);
  const raceReplay = useMultiplayerStore((s) => s.raceReplay);
  const raceResult = useMultiplayerStore((s) => s.raceResult);
  const rematchState = useMultiplayerStore((s) => s.rematchState);
  const latencyMs = useMultiplayerStore((s) => s.latencyMs);
  const lastError = useMultiplayerStore((s) => s.lastError);

  // 마운트 1회만 연결(StrictMode 이중 호출 방어 — ref는 같은 컴포넌트 인스턴스에서 불변).
  const startedRef = useRef(false);
  // [WT-AUTH-05] 비로그인 딥링크에서 로그인 모달을 실제로 띄운 뒤에만 취소 복귀가 동작하도록 하는 가드.
  const gateRequestedRef = useRef(false);
  const wsBase = import.meta.env.VITE_WS_BASE as string | undefined;

  // [§11-D86 F2] 멀티 진입(딥링크 포함) 시 계정 토큰 1회 서버 검증 — 무효면 로그아웃으로 강등되고
  // 위 게이트가 같은 렌더에서 로그인 모달을 띄운다. 게스트는 no-op, 로비 검증과 60s 메모로 중복 제거.
  useEffect(() => {
    void verifyAccountSession();
  }, []);

  useEffect(() => {
    if (!roomCode || startedRef.current) return;

    const grant = (location.state as { grant?: WsGrant } | null)?.grant;
    const hasGrant = !!grant && grant.roomCode === roomCode;

    // [WT-AUTH-05] 멀티 로그인 게이트(§11-D68). grant가 있으면 로비에서 이미 게이트를 통과한 것이고,
    // VITE_WS_BASE(E2E mock 직결)는 게이트 제외(구현 지시). 그 외 비로그인 딥링크는 로그인 모달을
    // 오버레이로 띄우고 연결을 보류한다 — 로그인 성공 시 isLoggedIn 변화로 이 effect가 재실행되며 연결.
    if (!hasGrant && !wsBase && !isLoggedIn) {
      gateRequestedRef.current = true;
      openLogin('multi');
      return;
    }

    startedRef.current = true;
    useMultiplayerStore.getState().reset(); // 이전 방에서 나가기 없이 이탈했던 잔여 상태 방어.

    const identity = {
      nickname: nickname || `GUEST_${guestId.slice(0, 4).toUpperCase()}`,
      passportCover: DEFAULT_PASSPORT_COVER,
    };
    if (grant && grant.roomCode === roomCode) {
      mp.connectWithGrant(grant, identity);
    } else if (wsBase) {
      // 테스트 전용(WT-M4-06): mock-do-server 직결. REST 그랜트/세션 부트스트랩 없이 합성 그랜트로
      // 바로 붙어 E2E가 서버 레이트리밋/매치메이커 비결정성에 얽매이지 않게 한다. 프로덕션 빌드엔
      // VITE_WS_BASE가 없어 이 분기가 정적 제거된다 → 딥링크는 아래 mp.join(REST) 경로 그대로.
      mp.connectWithGrant(
        { roomCode, wsUrl: `/ws/room/${roomCode}`, ticket: 'e2e-mock', lang: useSettingsStore.getState().lang, title: null },
        identity,
      );
    } else {
      void mp.join(roomCode, identity);
    }
    // roomCode/isLoggedIn 변경 시에만 재실행 — nickname/guestId/mp/location은 최초 연결 시점의 값으로
    // 충분하다. isLoggedIn은 비로그인 딥링크가 로그인에 성공하면 보류된 연결을 이어가기 위한 의존이다.
  }, [roomCode, isLoggedIn]);

  // [WT-AUTH-05] 딥링크 로그인 게이트에서 사용자가 로그인을 취소하면(loginReason이 다시 null인데
  // 여전히 비로그인) 로비로 돌려보낸다. gateRequestedRef로 게이트를 실제로 띄운 뒤에만 동작한다.
  useEffect(() => {
    if (gateRequestedRef.current && !startedRef.current && loginReason === null && !isLoggedIn) {
      navigate('/multi', { replace: true });
    }
  }, [loginReason, isLoggedIn, navigate]);

  useEffect(() => {
    if (!roomCode) navigate('/multi', { replace: true });
  }, [roomCode, navigate]);

  const handleLeave = (): void => {
    mp.leave();
    navigate('/multi');
  };

  // [WT-AUTH-05] 대기실 헤더에 표시할 방 제목 — 진입 grant(로비 create/join)에 실려 온다(§11-D68-⑧).
  const entryGrant = (location.state as { grant?: WsGrant } | null)?.grant;
  const grantTitle = entryGrant && entryGrant.roomCode === roomCode ? entryGrant.title : null;

  // grace 만료 후 재접속(§7.2-4): 서버가 room-state에서 본인 connState='left'로 알린다 → 관전 모드.
  const myPlayer = room?.players.find((p) => p.playerId === myPlayerId);
  const spectating =
    !!myPlayer && (myPlayer.connState === 'left' || myPlayer.connState === 'spectator');

  if (!roomCode) return null;

  if (connection === 'failed') {
    return (
      <main className="wt-room" data-testid="room-page">
        <div className="wt-card wt-room__state">
          <p>{t('multi.connection.failed')}</p>
          <button type="button" className="wt-btn wt-btn--primary" data-testid="room-retry" onClick={() => window.location.reload()}>
            {t('multi.connection.retry')}
          </button>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="wt-room" data-testid="room-page">
        <div className="wt-card wt-room__state">
          <p>{t('multi.deeplink.joining')}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="wt-room" data-testid="room-page">
      {lastError && (
        <p className="wt-lobby__error" data-testid="room-error">
          {t(multiErrorKey(lastError.code))}
        </p>
      )}
      {connection === 'reconnecting' && (
        <p className="wt-room__banner" data-testid="room-reconnecting">
          {t('multi.connection.reconnecting')}
        </p>
      )}

      {room.phase === 'waiting' && (
        <WaitingRoom room={room} myPlayerId={myPlayerId} mp={mp} onLeave={handleLeave} title={grantTitle} />
      )}

      {(room.phase === 'countdown' || room.phase === 'racing') &&
        (raceReplay ? (
          <RaceView
            replay={raceReplay}
            players={room.players}
            myPlayerId={myPlayerId}
            lang={room.lang}
            mp={mp}
            spectating={spectating}
          />
        ) : (
          <p className="wt-room__loading" data-testid="room-race-loading">{t('boarding.connecting')}</p>
        ))}

      {room.phase === 'result' && raceResult && (
        <RaceResult
          raceResult={raceResult}
          rematchState={rematchState}
          myPlayerId={myPlayerId}
          latencyMs={latencyMs}
          mp={mp}
          onLeave={handleLeave}
        />
      )}
    </main>
  );
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { RoomPage as Component };
