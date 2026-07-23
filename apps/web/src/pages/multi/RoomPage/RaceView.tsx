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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineEvent } from '@wt/engine';
import { useTypingEngine } from '../../../features/typing/useTypingEngine';
import { useGameClock } from '../../../features/typing/useGameClock';
import { HiddenTypingInput } from '../../../features/typing/HiddenTypingInput';
import { OpponentTracks } from '../../../features/multiplayer/OpponentTracks';
import { GameView } from '../../GamePage/GameView';
import { useSettingsStore } from '../../../stores/settings';
import {
  extractRaceStart,
  useMultiplayerStore,
  type RaceReplayMessage,
  type RoomPlayer,
} from '../../../stores/multiplayer';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { useRaceSession } from './useRaceSession';
import { useHardCapClock } from './useHardCapClock';

/** WT-DC-05(③): 레이스 카운트다운 숫자 로컬 타이머 — WT-DC-04 싱글 카운트다운과 동일 방식(엔진
 *  countdownEndsAt에서 길이 도출 → 3·2·1, tick 애니는 juice일 때만 WAAPI). 서버 startAt 동기는
 *  useRaceSession이 engine.start() 스케줄링으로 이미 보장한다(엔진 시간 무수정). */
const RACE_COUNTDOWN_FALLBACK_MS = 3000;
const RACE_COUNTDOWN_BEEP_TIMES = [0, 1000, 2000] as const;

function raceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

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

  // reduced-motion(§7.3) — GamePage와 동일 판정. 'auto'는 prefers-reduced-motion을 따른다.
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  const juice = !reducedActive;

  const [phase, setPhase] = useState(() => engine.getSnapshot().phase);
  const [currentIndex, setCurrentIndex] = useState(() => engine.getSnapshot().currentIndex);

  // WT-DC-05(③): 카운트다운 숫자 노드(오버레이가 countdown phase에만 마운트). 값 갱신은 아래 로컬
  // 타이머가 textContent로 직접 쓴다(§4.5 — React state 미경유).
  const countNumRef = useRef<HTMLSpanElement | null>(null);

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

  // WT-DC-05(③): 카운트다운 숫자 로컬 타이머(WT-DC-04 싱글과 동일 방식). 엔진 countdownEndsAt에서
  // 길이를 도출해(엔진 시간 무수정) 비프 케이던스(0/1000/2000ms)만큼 숫자를 센다 — 풀(3000ms)=
  // 3·2·1. tick 애니는 juice일 때만 WAAPI scale(1.6)→1 + fade 300ms(reduced-motion=숫자 tick만
  // 정지, 값 갱신은 유지). phase가 countdown일 때만 활성.
  useEffect(() => {
    if (phase !== 'countdown') return undefined;
    const el = countNumRef.current;
    if (!el) return undefined;
    const endsAt = engine.getSnapshot().countdownEndsAt;
    let duration = endsAt != null ? endsAt - raceNow() : RACE_COUNTDOWN_FALLBACK_MS;
    if (!Number.isFinite(duration) || duration <= 0) duration = RACE_COUNTDOWN_FALLBACK_MS;
    const beepTimes = RACE_COUNTDOWN_BEEP_TIMES.filter((tMs) => tMs < duration);
    const startNum = beepTimes.length;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const showAt = (i: number): void => {
      el.textContent = String(startNum - i);
      if (juice && typeof el.animate === 'function') {
        el.animate(
          [
            { transform: 'scale(1.6)', opacity: 0 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 300, easing: 'ease-out' },
        );
      }
    };
    beepTimes.forEach((tMs, i) => {
      if (tMs === 0) showAt(0);
      else timers.push(setTimeout(() => showAt(i), tMs));
    });
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [phase, engine, juice]);

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
      {/* WT-DC-05(③): 레이스 카운트다운 오버레이(디자인 S11 L471~478). WT-DC-04 싱글 카운트다운과
          동일 방식 — 전체화면 딤 스크림(rgba 0,0,0,0.45) + 92px 숫자, 숫자색만 파랑(--grade-b =
          디자인 #3b82f6). pointer-events:none라 카운트다운 중에도 hidden-input 포커스를 가로채지
          않는다. phase가 playing으로 바뀌면 즉시 제거. reduced-motion: 딤 즉시(스크림 페이드 정지)·
          숫자 tick 정지(위 effect가 juice로 게이팅). */}
      {phase === 'countdown' && (
        <div className="wt-race-countdown" data-testid="race-countdown" role="status" aria-live="polite">
          <div className="wt-race-countdown__scrim" aria-hidden="true" />
          <div className="wt-race-countdown__box">
            <p className="wt-race-countdown__title">{t('race.countdown.title')}</p>
            <p className="wt-race-countdown__sub">{t('race.countdown.sub', { count: countryIds.length })}</p>
          </div>
          <span ref={countNumRef} className="wt-race-countdown__num" aria-hidden="true" />
        </div>
      )}
    </>
  );
}
