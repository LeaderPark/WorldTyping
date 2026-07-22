// spec: docs/01 §8.2(레이스 중 UX)·§10.2(S11 레이스 와이어프레임), docs/03 §4.2(GameView 재사용 —
//       race variant)·§6.3(낙관 렌더/서버 ack 고스트/결승 게이트)·§6.5(OpponentTracks), docs/05
//       §6.2(공평한 출발), docs/00 §11-D23(v1 race-mixed만), WT-M4-04
//
// GameView(싱글과 동일 컴포넌트)를 재사용하는 레이스 화면. 타이핑 파이프라인은 GamePage와 같은
// 훅(useTypingEngine/useGameClock)을 그대로 쓴다 — 새로 구현하지 않는다. 차이는: (1) 엔진을
// REST가 아니라 서버 WS의 'start'/'race-sync'로 구성(useRaceSession), (2) attachRace로 타이핑
// 이벤트를 레이스 브리지에 배선, (3) OpponentTracks·하드캡 타이머를 GameView의 race 슬롯에 얹음.
//
// [의도적 축소 — 시간 예산] GamePage와 달리 WorldMap 배경/여행 연출은 생략한다(S11 와이어프레임에
// 지도 요구가 없다 — HUD/프롬프트/타이머/상대 트랙이 전부). 노선 지도 juice는 싱글 전용 계약이라
// 여기서 재구현하지 않는다.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineEvent } from '@wt/engine';
import { useTypingEngine } from '../../../features/typing/useTypingEngine';
import { useGameClock } from '../../../features/typing/useGameClock';
import { HiddenTypingInput } from '../../../features/typing/HiddenTypingInput';
import { OpponentTracks } from '../../../features/multiplayer/OpponentTracks';
import { GameView } from '../../GamePage/GameView';
import {
  extractRaceStart,
  useMultiplayerStore,
  type RaceReplayMessage,
  type RoomPlayer,
} from '../../../stores/multiplayer';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { useRaceSession } from './useRaceSession';
import { useHardCapClock } from './useHardCapClock';

export interface RaceViewProps {
  replay: RaceReplayMessage;
  players: readonly RoomPlayer[];
  myPlayerId: string | null;
  lang: 'ko' | 'en';
  mp: ReturnType<typeof useMultiplayer>;
  /** grace 만료 후 재접속(§7.2-4) — 관전 전용. 입력 파이프라인을 붙이지 않고 트랙만 렌더한다. */
  spectating?: boolean;
}

export function RaceView({ replay, players, myPlayerId, lang, mp, spectating }: RaceViewProps) {
  if (spectating) {
    return <SpectatorView replay={replay} players={players} myPlayerId={myPlayerId} mp={mp} />;
  }
  return <RaceViewLive replay={replay} players={players} myPlayerId={myPlayerId} lang={lang} mp={mp} />;
}

/** 관전 모드: 입력 채널 없이 상대 트랙만(§7.2-4). RaceClient만 붙여 tick으로 트랙을 갱신한다. */
function SpectatorView({
  replay,
  players,
  myPlayerId,
  mp,
}: {
  replay: RaceReplayMessage;
  players: readonly RoomPlayer[];
  myPlayerId: string | null;
  mp: ReturnType<typeof useMultiplayer>;
}) {
  const { t } = useTranslation();
  const total = extractRaceStart(replay).countries.length;
  const others = players.filter((p) => p.playerId !== myPlayerId);
  // 입력/엔진 없이 tick만 소비하도록 no-op 바인딩으로 브리지를 붙인다(complete/progress 미전송).
  useEffect(() => {
    const detach = mp.attachRace({
      engine: { rollbackTo: () => {}, subscribe: () => () => {} },
      inputEvents: { subscribe: () => () => {} },
      flushInput: () => {},
    });
    return detach;
  }, [mp]);
  return (
    <div className="wt-room__spectator" data-testid="race-spectator">
      <p className="wt-room__spectator-badge" data-testid="spectator-badge">
        {t('room.spectator')}
      </p>
      <OpponentTracks players={others} total={total} />
    </div>
  );
}

function RaceViewLive({ replay, players, myPlayerId, lang, mp }: Omit<RaceViewProps, 'spectating'>) {
  const { t } = useTranslation();
  const { engine, countries, hardCapAt } = useRaceSession(replay, lang, mp.getOffsetMs);

  if (!engine) {
    // 'start' 캐시는 있는데 countries.json에 아직 국가가 없는(부팅 경합) 순간적 상태 방어.
    return <p className="wt-room__loading" data-testid="race-view-loading">{t('boarding.connecting')}</p>;
  }

  return (
    <RaceViewActive
      engine={engine}
      countries={countries}
      hardCapAt={hardCapAt}
      players={players}
      myPlayerId={myPlayerId}
      lang={lang}
      mp={mp}
    />
  );
}

interface RaceViewActiveProps {
  engine: NonNullable<ReturnType<typeof useRaceSession>['engine']>;
  countries: ReturnType<typeof useRaceSession>['countries'];
  hardCapAt: number | null;
  players: readonly RoomPlayer[];
  myPlayerId: string | null;
  lang: 'ko' | 'en';
  mp: ReturnType<typeof useMultiplayer>;
}

function RaceViewActive({ engine, countries, hardCapAt, players, myPlayerId, lang, mp }: RaceViewActiveProps) {
  const { t } = useTranslation();
  const { inputRef, controller, getInputValue } = useTypingEngine(engine);
  const { bindTimerEl, bindGaugeEl } = useGameClock(engine);
  const { bindHardCapEl } = useHardCapClock(hardCapAt, mp.getOffsetMs);
  const myServerAck = useMultiplayerStore((s) => s.myServerAck);

  const [phase, setPhase] = useState(() => engine.getSnapshot().phase);
  const [currentIndex, setCurrentIndex] = useState(() => engine.getSnapshot().currentIndex);

  // 엔진 이벤트 → 국가 전환 단위 표시 상태(§4.5 허용 빈도) + 컨트롤러 타깃 전환(GamePage와 동일 배선).
  useEffect(() => {
    const snap = engine.getSnapshot();
    setPhase(snap.phase);
    setCurrentIndex(snap.currentIndex);
    const unsub = engine.subscribe((e: EngineEvent) => {
      if (e.type === 'phase') setPhase(e.phase);
      else if (e.type === 'countryShown') {
        setCurrentIndex(e.index);
        const c = countries[e.index];
        if (c) controller?.setCountry(c);
      }
    });
    return unsub;
  }, [engine, controller, countries]);

  // 레이스 브리지 배선(complete/progress 송신 + accepted/rejected 롤백) — 컨트롤러가 마운트된 뒤.
  useEffect(() => {
    if (!controller) return;
    const detach = mp.attachRace({
      engine,
      inputEvents: controller,
      flushInput: () => controller.clear(),
    });
    return detach;
  }, [engine, controller, mp]);

  const opponents = players.filter((p) => p.playerId !== myPlayerId);
  const countryIds = countries.map((c) => c.id);

  if (phase === 'finished') {
    // 개인 결승(GDD §8.2 FIN) — 순위 확정은 서버 results가 유일한 진실(§6.6). 방 전체가
    // FINISHED로 전이할 때까지(room.phase==='result') RoomPage가 RaceResult로 바꿔준다.
    return (
      <div className="wt-room__finish-wait" data-testid="race-finish-wait">
        <p>{t('race.finish.waiting')}</p>
        <OpponentTracks players={opponents} total={countryIds.length} />
      </div>
    );
  }

  return (
    <>
      <HiddenTypingInput inputRef={inputRef} retainFocus={phase === 'countdown' || phase === 'playing'} />
      {phase === 'idle' && (
        <div className="wt-room__reveal" data-testid="race-reveal">
          <p>{t('race.reveal.countries', { count: countryIds.length })}</p>
        </div>
      )}
      {(phase === 'countdown' || phase === 'playing') && (
        <GameView
          engine={engine}
          controller={controller}
          getInputValue={getInputValue}
          lang={lang}
          mode="race"
          countries={countries}
          countryIds={countryIds}
          currentIndex={currentIndex}
          lives={null}
          bindTimerEl={bindTimerEl}
          bindGaugeEl={bindGaugeEl}
          race={{
            tracksSlot: <OpponentTracks players={opponents} total={countryIds.length} />,
            bindHardCapEl,
            ackIndex: myServerAck?.index ?? null,
          }}
        />
      )}
    </>
  );
}
