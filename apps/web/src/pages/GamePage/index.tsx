// spec: docs/01 §2.1(코어 루프)·§10.2(S5→S6→S7 와이어프레임), docs/03 §4.2(GamePage — 세션
//       소유자)·§4.4(useGameSession/useTypingEngine/useGameClock)·§4.5(고빈도 값 규약), WT-M2-06.
//
// S5(보딩패스)→S6(인게임)→S7(결과)는 라우트 전환이 아니라 이 컴포넌트 내부의 phase 분기다
// (router.tsx 주석 그대로). 세션(엔진)·타이핑 컨트롤러·지도 핸들·session 스토어 배선을 전부
// 여기서 소유한다 — 자식(BoardingPass/GameView/ResultView)은 조립된 값만 props로 받는 순수
// 프레젠테이션 계층이다.
//
// [지도 마운트 위치 — 설계 메모] docs/03 §4.2 트리는 WorldMap을 GameView 하위로 그린다. 이
// 구현은 WorldMap과 HiddenTypingInput을 GamePage 레벨(전 phase에 걸쳐 항상 마운트)로 한 단계
// 끌어올렸다. 이유 둘: (1) ResultView(S7)가 "완성된 노선 썸네일"(§10.2 S7 wireframe)을 보여주려면
// GameView가 그려 넣은 solved/route 레이어가 phase 전환 후에도 유지돼야 하는데, GameView가
// phase별로 마운트/언마운트되면 지도 인스턴스가 함께 사라진다. (2) BoardingPass(S5)의 탭
// 핸들러 안에서 hidden input을 "동기" focus해야 하는 iOS 계약(§7.2)을 지키려면, 그 input이
// 탭 시점에 이미 DOM에 존재해야 한다(GameView 마운트를 기다리면 늦다). WorldMap 자체의
// "마운트 후 리렌더 0" 계약(§3.6)은 그대로 지킨다 — GamePage가 이 컴포넌트를 리렌더해도
// index/onReady props가 동일 참조로 유지되는 한 WorldMap 내부는 재조정되지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameMode } from '@wt/shared';
import type { RunResult as EngineRunResult, SessionPhase } from '@wt/engine';
import { useGameSession } from '../../features/typing/useGameSession';
import { useTypingEngine } from '../../features/typing/useTypingEngine';
import { useGameClock } from '../../features/typing/useGameClock';
import { HiddenTypingInput } from '../../features/typing/HiddenTypingInput';
import { isGhostUnlocked, loadGhost, useGhostProgress } from '../../features/typing/ghost';
import { useSoundManager } from '../../audio/useSoundManager';
import { WorldMap } from '../../features/map/WorldMap';
import { useWorldGeoIndex } from '../../features/map/useWorldGeoIndex';
import type { WorldMapHandle } from '../../features/map/map-handle';
import { useSessionStore } from '../../stores/session';
import { useSettingsStore } from '../../stores/settings';
import { useMetaStore } from '../../stores/meta';
import { SERVER_SET_MODES } from '../../net/run-session';
import { useModalA11y } from '../../lib/useModalA11y';
import { BoardingBlocked, BoardingPass } from './BoardingPass';
import { GameView } from './GameView';
import { ResultView } from './ResultView';

const VALID_MODES: readonly GameMode[] = ['continent', 'tier', 'worldtour', 'daily'];

function isValidMode(m: string | undefined): m is GameMode {
  return VALID_MODES.includes(m as GameMode);
}

export function GamePage() {
  const { t } = useTranslation();
  const params = useParams<{ mode: string; trackId: string }>();
  const lang = useSettingsStore((s) => s.lang);
  const nickname = useSettingsStore((s) => s.nickname);
  const guestId = useSettingsStore((s) => s.guestId);
  const platform = useSettingsStore((s) => s.platform);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const ghostModeSetting = useSettingsStore((s) => s.ghostMode);
  const setGhostMode = useSettingsStore((s) => s.setGhostMode);
  const trackBests = useMetaStore((s) => s.trackBests);

  // 라우트 mode가 이 화면이 다루는 4모드(대륙/티어/세계일주/데일리) 밖이면(예: race — 멀티
  // 전용, useMultiplayer 소관) 안전한 기본값으로 폴백해 렌더를 계속한다(RootErrorBoundary로
  // 몰아가지 않는다 — race URL 직접 진입은 사용자 실수일 뿐 앱 오류가 아니다).
  const mode: GameMode = isValidMode(params.mode) ? params.mode : 'continent';
  const trackId = params.trackId ?? '';

  const { engine, countries, runStart, start, retry, abort } = useGameSession({ mode, trackId });

  // 고스트 모드(§9.3, WT-M5-04): 데일리는 매일 세트가 달라 "노선" 자기 최고 대결의 의미가 없어
  // 대상에서 뺀다(레이스는 이 화면 대상 밖 — 상단 VALID_MODES 주석). 언락은 trackBests 스냅샷
  // 하나로 판정(단일 원천, isGhostUnlocked가 순수 함수). loadGhost는 localStorage 동기 읽기라
  // mode/trackId가 바뀔 때(트랙 전환)만 다시 읽으면 충분하다.
  const ghostUnlocked = mode !== 'daily' && isGhostUnlocked(trackBests);
  const ghost = useMemo(
    () => (ghostUnlocked ? loadGhost(mode, trackId) : null),
    [ghostUnlocked, mode, trackId],
  );
  const ghostIndex = useGhostProgress({ engine, ghost, enabled: ghostModeSetting && ghostUnlocked });
  const { inputRef, focusInput, controller, getInputValue, requestSkip } = useTypingEngine(engine);
  const { bindTimerEl, bindGaugeEl } = useGameClock(engine);
  // 사운드: 엔진(확정/체크포인트/카운트다운)+컨트롤러(정타/오타) 이벤트 구독(§13.1, 구현
  // 세부 지시 3). 고빈도 값이 아니라 이벤트 배선뿐이므로 §4.5 불변식과 무관하다.
  useSoundManager(engine, controller);
  const geoIndex = useWorldGeoIndex();

  const mapHandleRef = useRef<WorldMapHandle | null>(null);
  const onMapReady = useCallback((h: WorldMapHandle) => {
    mapHandleRef.current = h;
  }, []);

  const [phase, setPhase] = useState<SessionPhase>(() => engine.getSnapshot().phase);
  const [currentIndex, setCurrentIndex] = useState(() => engine.getSnapshot().currentIndex);
  const [lives, setLives] = useState<number | null>(() => engine.getSnapshot().lives);
  const [result, setResult] = useState<EngineRunResult | null>(() => engine.getSnapshot().result);
  // finished 시점의 잔여 라이프 스냅샷(제출 페이로드의 livesLost 산출용, net/run-session.ts).
  const [finalLives, setFinalLives] = useState<number | null>(() => engine.getSnapshot().lives);

  const startRun = useSessionStore((s) => s.startRun);
  const setStorePhase = useSessionStore((s) => s.setPhase);
  const setStoreIndex = useSessionStore((s) => s.setCurrentIndex);
  const setStoreLives = useSessionStore((s) => s.setLives);
  const setStorePractice = useSessionStore((s) => s.setPractice);
  const storeFinish = useSessionStore((s) => s.finish);
  const storeAbort = useSessionStore((s) => s.abort);

  const countryIds = useMemo(() => countries.map((c) => c.id), [countries]);

  // 엔진 이벤트 → (1) 로컬 표시 state(§4.5가 허용하는 국가 전환 단위 값만), (2) session 스토어
  // (stores/session.ts 주석: "엔진이 이 스토어의 유일한 정상 쓰기 주체 … WT-M2-06을 통해서만"),
  // (3) 지도 핸들(setTarget/markSolved/drawRouteSegment/flyTo). 엔진이 바뀌면(모드/노선 변경)
  // 전부 새 스냅샷으로 재동기화한다.
  useEffect(() => {
    const snap = engine.getSnapshot();
    setPhase(snap.phase);
    setCurrentIndex(snap.currentIndex);
    setLives(snap.lives);
    setResult(snap.result);
    mapHandleRef.current?.reset();

    const unsub = engine.subscribe((e) => {
      switch (e.type) {
        case 'phase': {
          setPhase(e.phase);
          if (e.phase === 'countdown') {
            mapHandleRef.current?.reset();
            startRun(mode, trackId, countryIds, engine.getSnapshot().lives);
          } else if (e.phase === 'aborted') {
            storeAbort();
          } else {
            setStorePhase(e.phase);
          }
          break;
        }
        case 'countryShown': {
          setCurrentIndex(e.index);
          setStoreIndex(e.index);
          const c = countries[e.index];
          if (c) {
            controller?.setCountry(c);
            mapHandleRef.current?.setTarget(c.id);
            mapHandleRef.current?.flyTo([c.id]);
          }
          break;
        }
        case 'countryCommitted': {
          const c = countries[e.index];
          if (c) {
            if (e.skipped) {
              // ESC 스킵(docs/03 §10.2 E3, GDD §5.5): 축하 연출·노선 세그먼트 없이 회색 빗금
              // (--map-skipped)으로만 표시한다 — 스킵은 방문한 경유지가 아니다.
              mapHandleRef.current?.markSkipped(c.id);
            } else {
              // juice #2: 폴리곤이 대륙(노선)색으로 채워진다(§13.3-2).
              mapHandleRef.current?.markSolved(c.id, `var(--continent-${c.continent})`);
              const prev = countries[e.index - 1];
              if (prev) mapHandleRef.current?.drawRouteSegment(prev.id, c.id);
            }
          }
          break;
        }
        case 'lifeChanged':
          setLives(e.lives);
          setStoreLives(e.lives);
          break;
        case 'degradedToPractice':
          setStorePractice(true);
          break;
        case 'finished': {
          setResult(e.result);
          setFinalLives(engine.getSnapshot().lives);
          storeFinish(e.result.score);
          // juice #6: 카메라를 완주(또는 진행분) 노선 전체 bounds로 리빌(1.2s) — ResultView 주석 참조.
          const clearedIds = countryIds.slice(0, e.result.stats.perCountry.length);
          if (clearedIds.length > 0) {
            mapHandleRef.current?.flyTo(clearedIds, { durationMs: 1200 });
          }
          break;
        }
        default:
          break;
      }
    });
    return unsub;
  }, [
    engine,
    controller,
    countries,
    countryIds,
    mode,
    trackId,
    startRun,
    setStorePhase,
    setStoreIndex,
    setStoreLives,
    setStorePractice,
    storeFinish,
    storeAbort,
  ]);

  // 브라우저 뒤로가기 = 포기 확인 모달(진행 중인 판만 차단 — idle/finished/aborted는 자유 이탈).
  const blocker = useBlocker(phase === 'countdown' || phase === 'playing');
  const confirmLeaveRef = useRef<HTMLDivElement | null>(null);
  // 배경 inert + 포커스 트랩 + 닫힘 시 트리거로 복귀(§7.3) — ESC는 이 모달에 아직 없다(의도적
  // 으로 명시 선택만 받는다 — 뒤로가기 확인은 실수 방지가 목적이라 ESC로 즉시 닫히면 원래
  // 취지가 흐려진다).
  useModalA11y(confirmLeaveRef, blocker.state === 'blocked');

  // reducedMotion 'auto'는 AppShell과 동일하게 prefers-reduced-motion을 따른다(§7.3).
  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  const juice = !reducedActive;

  // 지도 juice 레벨(map-handle.ts: 0=풀, 1=강등 — 펄스/파티클 off·카메라 즉시 스냅)도 같은 설정을
  // 따르게 동기화한다. geoIndex가 늦게(비동기) 도착해 WorldMap이 뒤늦게 마운트되는 경우를 포함해,
  // 마운트 시점/설정 변경 시점 둘 다 반영한다.
  useEffect(() => {
    mapHandleRef.current?.setJuiceLevel(reducedActive ? 1 : 0);
  }, [reducedActive, geoIndex]);

  return (
    <div className="wt-game-page" data-testid="game-page">
      {geoIndex && (
        <WorldMap index={geoIndex} className="wt-game-page__map" onReady={onMapReady} />
      )}

      <HiddenTypingInput inputRef={inputRef} retainFocus={phase === 'countdown' || phase === 'playing'} />

      <div className="wt-game-page__content">
        {phase === 'idle' && runStart.status === 'blocked' && <BoardingBlocked />}
        {phase === 'idle' && runStart.status !== 'blocked' && (
          <BoardingPass
            mode={mode}
            trackId={trackId}
            countries={countries}
            lang={lang}
            nickname={nickname}
            guestId={guestId}
            platform={platform}
            start={start}
            focusInput={focusInput}
            locked={SERVER_SET_MODES.has(mode) && runStart.status === 'loading'}
            ghostUnlocked={ghostUnlocked}
            ghostEnabled={ghostModeSetting}
            onToggleGhost={setGhostMode}
          />
        )}
        {(phase === 'countdown' || phase === 'playing') && (
          <GameView
            engine={engine}
            controller={controller}
            getInputValue={getInputValue}
            lang={lang}
            mode={mode}
            countries={countries}
            countryIds={countryIds}
            currentIndex={currentIndex}
            lives={lives}
            bindTimerEl={bindTimerEl}
            bindGaugeEl={bindGaugeEl}
            juice={juice}
            requestSkip={requestSkip}
            ghostIndex={ghostIndex}
          />
        )}
        {phase === 'finished' && result && (
          <ResultView
            engine={engine}
            result={result}
            countries={countries}
            lang={lang}
            mode={mode}
            trackId={trackId}
            platform={platform}
            finalLives={finalLives}
            runToken={runStart.runToken}
            runTokenIssuedAt={runStart.runTokenIssuedAt}
            nickname={nickname}
            retry={retry}
          />
        )}
      </div>

      {blocker.state === 'blocked' && (
        <div
          ref={confirmLeaveRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="wt-confirm-leave-title"
          aria-describedby="wt-confirm-leave-body"
          className="wt-confirm-leave"
          data-testid="confirm-leave"
        >
          <div className="wt-confirm-leave__box">
            <p id="wt-confirm-leave-title" className="wt-confirm-leave__title">
              {t('game.confirmLeave.title')}
            </p>
            <p id="wt-confirm-leave-body" className="wt-confirm-leave__body">
              {t('game.confirmLeave.body')}
            </p>
            <div className="wt-confirm-leave__actions">
              <button type="button" data-testid="confirm-leave-stay" onClick={() => blocker.reset?.()}>
                {t('game.confirmLeave.stay')}
              </button>
              <button
                type="button"
                data-testid="confirm-leave-go"
                onClick={() => {
                  abort();
                  blocker.proceed?.();
                }}
              >
                {t('game.confirmLeave.leave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { GamePage as Component };
