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
  useEffect(() => {
    if (!roomCode || startedRef.current) return;
    startedRef.current = true;
    useMultiplayerStore.getState().reset(); // 이전 방에서 나가기 없이 이탈했던 잔여 상태 방어.

    const identity = {
      nickname: nickname || `GUEST_${guestId.slice(0, 4).toUpperCase()}`,
      passportCover: DEFAULT_PASSPORT_COVER,
    };
    const grant = (location.state as { grant?: WsGrant } | null)?.grant;
    const wsBase = import.meta.env.VITE_WS_BASE as string | undefined;
    if (grant && grant.roomCode === roomCode) {
      mp.connectWithGrant(grant, identity);
    } else if (wsBase) {
      // 테스트 전용(WT-M4-06): mock-do-server 직결. REST 그랜트/세션 부트스트랩 없이 합성 그랜트로
      // 바로 붙어 E2E가 서버 레이트리밋/매치메이커 비결정성에 얽매이지 않게 한다. 프로덕션 빌드엔
      // VITE_WS_BASE가 없어 이 분기가 정적 제거된다 → 딥링크는 아래 mp.join(REST) 경로 그대로.
      mp.connectWithGrant(
        { roomCode, wsUrl: `/ws/room/${roomCode}`, ticket: 'e2e-mock', lang: useSettingsStore.getState().lang },
        identity,
      );
    } else {
      void mp.join(roomCode, identity);
    }
    // roomCode 변경 시(같은 컴포넌트가 다른 방으로 재사용되는 경우는 라우터가 key를 안 바꿔주는
    // 한 없음)만 재실행 — nickname/guestId/mp/location은 최초 연결 시점의 값으로 충분하다.
  }, [roomCode]);

  useEffect(() => {
    if (!roomCode) navigate('/multi', { replace: true });
  }, [roomCode, navigate]);

  const handleLeave = (): void => {
    mp.leave();
    navigate('/multi');
  };

  // grace 만료 후 재접속(§7.2-4): 서버가 room-state에서 본인 connState='left'로 알린다 → 관전 모드.
  const myPlayer = room?.players.find((p) => p.playerId === myPlayerId);
  const spectating =
    !!myPlayer && (myPlayer.connState === 'left' || myPlayer.connState === 'spectator');

  if (!roomCode) return null;

  if (connection === 'failed') {
    return (
      <main className="wt-room" data-testid="room-page">
        <p>{t('multi.connection.failed')}</p>
        <button type="button" className="wt-btn" data-testid="room-retry" onClick={() => window.location.reload()}>
          {t('multi.connection.retry')}
        </button>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="wt-room" data-testid="room-page">
        <p>{t('multi.deeplink.joining')}</p>
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
      {connection === 'reconnecting' && <p data-testid="room-reconnecting">{t('multi.connection.reconnecting')}</p>}

      {room.phase === 'waiting' && (
        <WaitingRoom room={room} myPlayerId={myPlayerId} mp={mp} onLeave={handleLeave} />
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
          <p data-testid="room-race-loading">{t('boarding.connecting')}</p>
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
