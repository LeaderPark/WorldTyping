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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Country, GameMode } from '@wt/shared';
import type { RunResult as EngineRunResult, SessionPhase } from '@wt/engine';
import { useGameSession } from '../../features/typing/useGameSession';
import { useTypingEngine } from '../../features/typing/useTypingEngine';
import { useGameClock } from '../../features/typing/useGameClock';
import { HiddenTypingInput } from '../../features/typing/HiddenTypingInput';
import { isGhostUnlocked, loadGhost, useGhostProgress } from '../../features/typing/ghost';
import { useSoundManager } from '../../audio/useSoundManager';
// WT-DC-08(00 §11-D67): 싱글 인게임 지도를 평면 WorldMap+leg 카메라(D63)에서 d3-geo 지구본 +
// 비행기 홉(GlobeMap)으로 대체한다. 평면 WorldMap·camera(leg)·route-layer는 홈 히어로 전용 존치.
import { GlobeMap, type GlobeMapHandle } from '../../features/map/globe/GlobeMap';
import { useGlobeIndex } from '../../features/map/globe/useGlobeIndex';
import { useSessionStore } from '../../stores/session';
import { useSettingsStore } from '../../stores/settings';
import { useAuthStore } from '../../stores/auth';
import { useMetaStore } from '../../stores/meta';
import { SERVER_SET_MODES } from '../../net/run-session';
import { useModalA11y } from '../../lib/useModalA11y';
import { Mascot } from '../../components/Mascot';
import { BoardingBlocked, BoardingPass } from './BoardingPass';
import { GameView } from './GameView';
import { ResultView } from './ResultView';

const VALID_MODES: readonly GameMode[] = ['continent', 'tier', 'worldtour', 'daily'];

function isValidMode(m: string | undefined): m is GameMode {
  return VALID_MODES.includes(m as GameMode);
}

/** WT-DC-04(①): 카운트다운 숫자·마스코트 꼬리의 모드 억센트 색(tokens var). 대륙=노선색(현
 *  출제국 대륙), 티어=--grade-b, 세계일주=--grade-s, 데일리=--grade-a(디자인 정본). */
function countdownAccentVar(mode: GameMode, countries: readonly Country[]): string {
  switch (mode) {
    case 'continent':
      return `var(--continent-${countries[0]?.continent ?? 'europe'})`;
    case 'worldtour':
      return 'var(--grade-s)';
    case 'daily':
      return 'var(--grade-a)';
    default:
      return 'var(--grade-b)'; // tier(+ race 안전 폴백)
  }
}

/** 초기 카운트다운(3000ms)=3·2·1, 리트라이(1500ms)=2·1의 폴백(countdownEndsAt 부재/이상 시). */
const COUNTDOWN_FALLBACK_MS = 3000;
/** sound-manager 비프 케이던스와 동일한 절대 시각(ms). 표시 숫자는 이 시점에 재생되는 비프에 동기. */
const COUNTDOWN_BEEP_TIMES = [0, 1000, 2000] as const;

// WT-CH-08(docs/09 §8.1, §11-D90): chase는 GameSessionEngine(고정 국가 배열 전제)과 완전히 다른
// 세션 모델(무한 생존)이라 이 화면의 나머지 90%(useGameSession/useTypingEngine/GameView/ResultView)와
// 공유할 것이 없다 — features/chase/ChaseGameRoot.tsx가 자체 페이지 루트를 소유한다. React.lazy로
// 감싸 별도 번들 청크로 분리한다(vite.config.ts manualChunks의 "chase" 규칙 — entry/기존 5모드
// "game" 청크에 chase 코드가 섞이지 않는다, size-limit.json chase-*.js 제외 글롭 참조).
const ChaseGameRoot = lazy(() =>
  import('../../features/chase/ChaseGameRoot').then((m) => ({ default: m.ChaseGameRoot })),
);

/**
 * 기존 5모드(대륙/티어/세계일주/데일리) 세션 화면 — 이름만 내부용으로 바뀌었을 뿐 로직은 전혀
 * 수정되지 않았다(§8 "다른 모드 화면에 픽셀 영향 0"). 아래 GamePage가 라우트(pathname)로 이
 * 컴포넌트와 ChaseGameRoot 중 하나를 고른다.
 */
function LegacyGamePage() {
  const { t } = useTranslation();
  const params = useParams<{ mode: string; trackId: string }>();
  const lang = useSettingsStore((s) => s.lang);
  // [§11-D88] 탑승권 승객명은 계정(Google) 닉네임을 우선 표시(수동 입력 플로우 폐지). 비로그인
  // 게스트는 null → BoardingPass가 GUEST_ 표시 전용 폴백으로 대체(서버 전송 없음, 싱글 코스메틱).
  const authNickname = useAuthStore((s) => s.nickname);
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
  const geoIndex = useGlobeIndex();

  const mapHandleRef = useRef<GlobeMapHandle | null>(null);
  const onMapReady = useCallback((h: GlobeMapHandle) => {
    mapHandleRef.current = h;
  }, []);

  // WT-DC-04(①): 카운트다운 숫자 노드(intro가 countdown phase에만 마운트). 값 갱신은 아래 전용
  // 로컬 타이머가 textContent로 직접 쓴다(§4.5 — React state 미경유).
  const countdownNumRef = useRef<HTMLSpanElement | null>(null);

  // 웨이포인트 라벨명(§11-D63)은 현지화된 국가명(countries.json nameKo|nameEn)이다. lang을 ref로
  // 잡아 지도 배선 effect의 구독을 재생성하지 않고(재구독은 reset을 유발) 최신 lang을 읽는다.
  const langRef = useRef(lang);
  langRef.current = lang;

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

    // 현지화 국가명(웨이포인트 라벨용). langRef로 최신 lang을 읽는다(§11-D67).
    const nameOf = (c: Country): string => (langRef.current === 'ko' ? c.nameKo : c.nameEn);

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
            const h = mapHandleRef.current;
            h?.setTarget(c.id);
            // 출발역(첫 국가): 비행기 스냅 배치 + 카메라를 첫 국가로 즉시 고정(§11-D67). 이후
            // 카메라 이동은 확정 시 홉(moveVehicle)만 담당한다.
            if (e.index === 0) h?.moveVehicle(c.id, c.id, { durationMs: 0 });
            // §11-D67: 전 싱글 모드 홉 추적 통일 — leg 카메라 flyTo 폐기(D63 대체). 웨이포인트
            // 라벨(prev·cur·next 역명)만 전 모드 무조건 갱신한다. 먼 타깃은 지구본 뒷면(비가시)일
            // 수 있으나 타이핑은 텍스트 프롬프트 기반이라 무영향(리드 확정 ①).
            const prev = countries[e.index - 1];
            const next = countries[e.index + 1];
            h?.setWaypointLabels({
              prev: prev ? { id: prev.id, label: nameOf(prev) } : null,
              cur: { id: c.id, label: nameOf(c) },
              next: next ? { id: next.id, label: nameOf(next) } : null,
            });
          }
          break;
        }
        case 'countryCommitted': {
          const c = countries[e.index];
          if (c) {
            if (e.skipped) {
              // ESC 스킵(docs/03 §10.2 E3, GDD §5.5): 축하 연출·노선 세그먼트·비행기 홉 없이 회색
              // 빗금(--map-skipped)으로만 표시한다 — 스킵은 방문한 경유지가 아니다. 단 카메라만
              // 400ms 이징으로 스킵국으로 돌려 무대가 진행을 따라오게 한다(§11-D67, 신규).
              mapHandleRef.current?.markSkipped(c.id);
              mapHandleRef.current?.flyTo([c.id], { durationMs: 400 });
            } else {
              // juice #2: 폴리곤이 대륙(노선)색으로 채워지고, 노선 세그먼트가 이전 국가에서 그려져
              // 들어오며(§13.3-2), 그 경로를 따라 이동체가 날아 들어온다(§11-D63).
              mapHandleRef.current?.markSolved(c.id, `var(--continent-${c.continent})`);
              const prev = countries[e.index - 1];
              if (prev) {
                mapHandleRef.current?.drawRouteSegment(prev.id, c.id);
                mapHandleRef.current?.moveVehicle(prev.id, c.id);
              }
              // WT-DC-04(③): 세계일주 경유지 도착(10/20/30/40번째, 종착 제외) 시 지도에 앰버 링 펄스.
              // 배너/칩(GameView·BoardingStrip)과 별개 구독 — 여기는 지도 핸들을 소유한 GamePage 몫.
              const reached = e.index + 1;
              if (mode === 'worldtour' && reached % 10 === 0 && reached < countryIds.length) {
                mapHandleRef.current?.pulseCheckpointRing(c.id);
              }
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
          // 현 구간 웨이포인트 라벨은 완주 리트레이스/썸네일에 남지 않도록 비운다(§11-D63) —
          // 노선·스테이션 도트·이동체(마지막 종점)는 완성된 여정으로 유지한다.
          mapHandleRef.current?.setWaypointLabels({ prev: null, cur: null, next: null });
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

  // WT-DC-08(리드 지시 ②, §11-D67): idle spin은 보딩(idle)·결과(finished) 배경에서만 ON,
  // countdown·playing 중 OFF — playing 중 정지 = canvas 재그리기 0 = 입력 핫패스 무비용. juice
  // 효과가 이 효과보다 먼저 실행되므로(정의 순서) reduced-motion/juice 강등 시 spin은 자동 억제된다.
  // geoIndex가 늦게 도착해 GlobeMap이 뒤늦게 마운트되는 경우도 현재 phase에 맞춰 반영한다.
  useEffect(() => {
    mapHandleRef.current?.setIdleSpin(phase === 'idle' || phase === 'finished');
  }, [phase, geoIndex]);

  // WT-DC-04(①): 카운트다운 숫자 로컬 타이머. sound-manager 비프 케이던스(0/1000/2000ms)에 동기해
  // 재생되는 비프 개수만큼 숫자를 센다 — 풀(3000ms)=3·2·1, 리트라이(1500ms)=2·1. 길이는 엔진
  // countdownEndsAt에서 도출한다(엔진 시간 무수정). tick 애니는 juice일 때만 WAAPI scale(1.6)→1 +
  // fade 300ms(reduced-motion=숫자 tick만 정지, 값 갱신은 유지). phase가 countdown일 때만 활성.
  const accentVar = countdownAccentVar(mode, countries);
  useEffect(() => {
    if (phase !== 'countdown') return undefined;
    const el = countdownNumRef.current;
    if (!el) return undefined;
    const nowMs =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const endsAt = engine.getSnapshot().countdownEndsAt;
    let duration = endsAt != null ? endsAt - nowMs : COUNTDOWN_FALLBACK_MS;
    if (!Number.isFinite(duration) || duration <= 0) duration = COUNTDOWN_FALLBACK_MS;
    const beepTimes = COUNTDOWN_BEEP_TIMES.filter((t) => t < duration);
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
    beepTimes.forEach((t, i) => {
      if (t === 0) showAt(0);
      else timers.push(setTimeout(() => showAt(i), t));
    });
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [phase, engine, juice]);

  return (
    <div className="wt-game-page" data-testid="game-page">
      {geoIndex && (
        <GlobeMap index={geoIndex} className="wt-game-page__map" onReady={onMapReady} />
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
            nickname={authNickname ?? ''}
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
        {/* WT-DC-04(①): 카운트다운 딤 스크림 — 게임 화면 전체(지도·HUD·스트립)를 덮되(content가
            지도 위 z1이라 map까지 시각적으로 딤) 숫자(intro z5) 아래(z4)에 둔다. phase가 playing으로
            바뀌는 즉시 이 조건이 거짓이 되어 제거된다(플레이 시야 가림 없음). */}
        {phase === 'countdown' && (
          <div className="wt-countdown-scrim" data-testid="countdown-scrim" aria-hidden="true" />
        )}
        {/* 카운트다운 인트로 카피(WT-UI-03, 원작 "운행을 시작합니다"에 대응) — 엔진 카운트다운
            메커니즘은 그대로 두고, 출발 직전 잠깐 지도 무대 위에 안내를 얹는다. WT-DC-04(①): 마스코트
            (모드 억센트 꼬리) + 92px 카운트다운 숫자(로컬 타이머가 textContent 직접 갱신). */}
        {phase === 'countdown' && (
          <div className="wt-game-intro" data-testid="game-intro" role="status" aria-live="polite">
            <div className="wt-game-intro__box">
              <Mascot width={46} tail={accentVar} />
              <p className="wt-game-intro__title">{t('game.intro.title')}</p>
              <p className="wt-game-intro__hint">{t('game.intro.hint')}</p>
            </div>
            <span
              ref={countdownNumRef}
              className="wt-game-intro__count"
              data-testid="countdown-number"
              style={{ color: accentVar }}
              aria-hidden="true"
            />
          </div>
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
              <button
                type="button"
                className="wt-btn"
                data-testid="confirm-leave-stay"
                onClick={() => blocker.reset?.()}
              >
                {t('game.confirmLeave.stay')}
              </button>
              {/* WT-DC-06 ⑤: 확인(나가기) 버튼만 위험색(globals.css .wt-confirm-leave .wt-btn--danger). */}
              <button
                type="button"
                className="wt-btn wt-btn--danger"
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

/**
 * 실제 라우트 진입점(router.tsx `play/:mode/:trackId` + `play/chase` 둘 다 이 모듈을 가리킨다).
 * `/play/chase`는 시드가 홈을 정하므로 trackId 세그먼트가 없다(§8.1 "TrackSelect 없이 직행") —
 * useParams()로는 구분할 수 없어 pathname으로 분기한다. 두 분기는 서로 다른 컴포넌트 타입을
 * 반환하므로(LegacyGamePage vs ChaseGameRoot) React가 항상 완전히 언마운트/마운트하며 훅 순서
 * 문제가 없다(이 GamePage 함수 자체는 훅을 전혀 호출하지 않는다 — useLocation 하나뿐).
 */
export function GamePage() {
  const location = useLocation();
  if (location.pathname === '/play/chase') {
    return (
      <Suspense fallback={<div className="wt-game-page" data-testid="chase-loading" />}>
        <ChaseGameRoot />
      </Suspense>
    );
  }
  return <LegacyGamePage />;
}

export { GamePage as Component };
