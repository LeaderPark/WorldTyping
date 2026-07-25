// spec: docs/01 §8.2(레이스 중 UX — 상대 진행 실시간)·§10.2(S11), docs/03 §3.7(지구본 여정 무대)·
//       §4.2(GamePage 지도 배선 패턴)·§4.5(고빈도 값은 React state/Zustand 금지 — 명령형 핸들만)·
//       §6.5(opponents 구독), docs/05 §8-2(progress-tick 250ms 코얼레싱), docs/00 §11-D63·D67,
//       WT-RACE-GLOBE.
//
// S11(레이스) 배경 지구본. GamePage(싱글)가 GlobeMap을 배경 무대로 깔고 엔진 이벤트를 지도 핸들에
// 배선하는 것과 같은 구조를, 레이스에 필요한 최소 집합으로 재현한다:
//   · 내 비행기 = 코어(base) 핸들 그대로 — countryShown(setTarget·index 0 스냅) / countryCommitted
//     (markSolved + drawRouteSegment + moveVehicle). 웨이포인트 라벨·체크포인트 링·완주 flyTo는
//     싱글 전용 연출이라 레이스에서는 배선하지 않는다(스코프 절제).
//   · 상대 비행기 = globe-race.ts의 오버레이 핸들(코어 무접촉 additive 확장, WT-CH-05 선례).
//
// [§4.5 준수] 이 컴포넌트는 상태를 React에 전혀 올리지 않는다. opponents 갱신은 zustand 스토어를
// **구독만** 하고(useMultiplayerStore.subscribe — 렌더 경유 없음) 핸들 메서드로 흘려보낸다. 따라서
// 250ms progress-tick이 몇 번 오든 이 트리는 단 한 번도 리렌더되지 않는다(GlobeMap의 "마운트 후
// 리렌더 0" 계약도 그대로 유지된다 — index/className/onReady가 마운트 상수).
//
// [배치 규약] 서버 idx는 "완주한 국가 수"다(OpponentTracks의 진행률 분자와 동일 값). 내 비행기가
// "마지막으로 확정한 국가"에 머무르는 싱글 규약과 맞추기 위해 상대 기체 위치도 max(0, idx-1)로
// 환산한다 — 같은 진행도의 두 기체가 같은 국가에 있게 하려면 이 환산이 필수다.
//
// [파일 위치] 리드 지시문은 features/multiplayer/RaceGlobe.tsx를 지정했으나, .eslintrc.cjs의
// import/no-restricted-paths(features/* 상호 직접 참조 금지, CLAUDE.md 동일 규약)가 features/
// multiplayer → features/map import를 금지한다. GamePage가 지도 배선을 소유하는 것과 동일하게
// "화면(page)이 지도 배선을 소유"하는 배치로 옮겼다(최종 보고 기재).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CountryId } from '@wt/shared';
import type { EngineEvent } from '@wt/engine';
import { GlobeMap, type GlobeMapHandle } from '../../../features/map/globe/GlobeMap';
import { useGlobeIndex } from '../../../features/map/globe/useGlobeIndex';
import { createGlobeRaceHandle, type GlobeRaceHandle } from '../../../features/map/globe/globe-race';
import {
  useMultiplayerStore,
  type OpponentProgress,
  type RoomPlayer,
} from '../../../stores/multiplayer';

/**
 * 상대 기체 색 팔레트. OpponentTracks에는 플레이어별 색 규칙이 없어(트랙 fill은 전원 --grade-b,
 * 1위만 --grade-s 억센트) 그 어휘를 그대로 확장한다 — 신규 토큰을 만들지 않고 기존 등급색 5종만
 * 순환 배정한다(장식 전용, 텍스트 아님 → D50/D62 대비 규정 무관). 배정 순서는 OpponentTracks가
 * 받는 players 배열 순서와 동일하므로 "위에서 n번째 트랙 = n번째 색 기체"가 성립한다.
 */
const RACE_PLANE_COLOR_VARS = [
  'var(--grade-b)',
  'var(--grade-a)',
  'var(--grade-c)',
  'var(--grade-s)',
  'var(--grade-d)',
] as const;

/** 로스터 i번째 상대의 기체 색(순환). */
export function racePlaneColor(i: number): string {
  return RACE_PLANE_COLOR_VARS[i % RACE_PLANE_COLOR_VARS.length] as string;
}

/** 완주 수(서버 idx) → 기체가 서 있어야 할 세트 인덱스(위 "배치 규약" 주석). */
export function racePlanePosIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  const pos = Math.min(idx - 1, total - 1);
  return pos < 0 ? 0 : pos;
}

/** 이 컴포넌트가 실제로 쓰는 엔진 표면(구조적 부분집합 — GameSessionEngine이 그대로 만족한다). */
export interface RaceGlobeEngine {
  subscribe(listener: (e: EngineEvent) => void): () => void;
  getSnapshot(): { currentIndex: number };
}

export interface RaceGlobeProps {
  /** 세트 국가 ID 순서(내 노선·상대 위치 공통 원천). */
  countryIds: readonly CountryId[];
  /** 내 비행기 배선용 로컬 엔진. 관전 모드(§7.2-4)는 엔진이 없어 null/미전달. */
  engine?: RaceGlobeEngine | null;
  /** 나를 제외한 방 플레이어(OpponentTracks에 넘기는 것과 동일 배열·동일 순서). */
  opponents: readonly RoomPlayer[];
  /** reduced-motion 판정 결과(호출부가 이미 계산 — RaceView와 동일 규칙). true면 홉 없이 스냅. */
  reducedMotion: boolean;
}

export function RaceGlobe({ countryIds, engine, opponents, reducedMotion }: RaceGlobeProps): JSX.Element {
  const index = useGlobeIndex();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<GlobeRaceHandle | null>(null);
  /** 상대별로 "지금 배치돼 있는 세트 인덱스". 미배치는 키 부재. */
  const placedRef = useRef<Map<string, number>>(new Map());
  /** 관전 모드 카메라가 마지막으로 따라간 선두 위치. */
  const followedRef = useRef<number | null>(null);

  // 아래 값들은 스토어 구독 콜백(렌더 밖)에서 읽으므로 ref로 최신값을 들고 있는다 — 구독을
  // 재생성하면 그때마다 스냅/재배치가 일어나므로 의도적으로 마운트 1회 구독을 유지한다.
  const countryIdsRef = useRef(countryIds);
  countryIdsRef.current = countryIds;
  const opponentsRef = useRef(opponents);
  opponentsRef.current = opponents;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const spectating = !engine;
  const spectatingRef = useRef(spectating);
  spectatingRef.current = spectating;

  /** opponents 스토어 스냅샷 → 기체 배치/홉. 렌더를 거치지 않는다(§4.5). */
  const applyOpponents = useCallback((progress: ReadonlyMap<string, OpponentProgress>): void => {
    const handle = handleRef.current;
    const ids = countryIdsRef.current;
    if (!handle || ids.length === 0) return;
    let leader = 0;
    for (const p of opponentsRef.current) {
      const cur = racePlanePosIndex(progress.get(p.playerId)?.idx ?? 0, ids.length);
      if (cur > leader) leader = cur;
      const prev = placedRef.current.get(p.playerId);
      // 위치 변화가 없는 상대는 아무것도 하지 않는다 — 250ms tick마다 전원 재배치하면 DOM을 헛
      // 건드린다(진행이 없어도 tick은 계속 온다).
      if (prev === cur) continue;
      const to = ids[cur];
      if (to === undefined) continue;
      placedRef.current.set(p.playerId, cur);
      // 최초 배치·되감기(재동기)는 스냅. 전진은 마지막 한 구간만 홉하고(2칸 이상 점프 시 직전
      // 국가로 먼저 스냅) 나머지는 건너뛴다 — tick 유실/재접속으로 여러 칸이 한 번에 올 수 있다.
      const from = prev === undefined || cur < prev ? undefined : ids[cur - 1];
      if (from === undefined) {
        handle.snapPlane(p.playerId, to);
        continue;
      }
      if (prev !== undefined && cur - prev >= 2) handle.snapPlane(p.playerId, from);
      handle.movePlane(p.playerId, from, to);
    }
    // 관전 모드는 내 비행기(카메라 추적 주체)가 없다 — 선두를 카메라로 따라가 무대가 비지 않게 한다.
    if (spectatingRef.current && followedRef.current !== leader) {
      followedRef.current = leader;
      const target = ids[leader];
      if (target !== undefined) handle.flyTo([target], { durationMs: 600 });
    }
  }, []);
  const applyOpponentsRef = useRef(applyOpponents);
  applyOpponentsRef.current = applyOpponents;

  // 엔진 스냅샷 → 내 비행기 초기 상태(핸들이 늦게 준비되는 경우/재마운트 복구).
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const onReady = useCallback(
    (core: GlobeMapHandle): void => {
      const container = wrapRef.current;
      if (!index || !container) return; // 방어적 가드 — GlobeMap은 index가 truthy일 때만 마운트된다.
      const handle = createGlobeRaceHandle({ core, container, index });
      handleRef.current = handle;
      handle.setJuiceLevel(reducedRef.current ? 1 : 0);
      handle.setRoster(
        opponentsRef.current.map((p, i) => ({ id: p.playerId, color: racePlaneColor(i) })),
      );

      const ids = countryIdsRef.current;
      const eng = engineRef.current;
      if (eng) {
        // 이미 진행 중인 판(핸들이 늦게 붙은 경우) — 현 출제국에 비행기·타깃을 스냅한다.
        const at = ids[eng.getSnapshot().currentIndex];
        if (at !== undefined) {
          handle.setTarget(at);
          handle.moveVehicle(at, at, { durationMs: 0 });
        }
      } else {
        // 관전: 내 기체는 없다 — 코어 기체를 숨기고 카메라만 출발국에 둔다.
        handle.setVehicleVisible(false);
        const first = ids[0];
        if (first !== undefined) handle.flyTo([first], { durationMs: 0 });
      }
      applyOpponentsRef.current(useMultiplayerStore.getState().opponents);
    },
    [index],
  );

  // 내 비행기 배선(GamePage §4.2 배선의 레이스 최소 집합). 핸들은 콜백 안에서 지연 조회한다 —
  // GlobeMap(자식) 마운트 순서와 무관하게 안전하다.
  useEffect(() => {
    if (!engine) return undefined;
    return engine.subscribe((e: EngineEvent) => {
      const handle = handleRef.current;
      if (!handle) return;
      const ids = countryIdsRef.current;
      if (e.type === 'countryShown') {
        const id = ids[e.index];
        if (id === undefined) return;
        handle.setTarget(id);
        // 출발국: 비행기 스냅 배치 + 카메라 즉시 고정(싱글 index 0 규약과 동일).
        if (e.index === 0) handle.moveVehicle(id, id, { durationMs: 0 });
        return;
      }
      if (e.type === 'countryCommitted') {
        const id = ids[e.index];
        if (id === undefined) return;
        if (e.skipped) {
          handle.markSkipped(id);
          return;
        }
        handle.markSolved(id, `var(--continent-${index?.continent.get(id) ?? 'asia'})`);
        const prev = ids[e.index - 1];
        if (prev !== undefined) {
          handle.drawRouteSegment(prev, id);
          handle.moveVehicle(prev, id);
        }
      }
    });
  }, [engine, index]);

  // 상대 진행 구독(마운트 1회) — 스토어 갱신마다 핸들로 흘려보낸다(리렌더 0).
  useEffect(() => {
    return useMultiplayerStore.subscribe((s) => applyOpponentsRef.current(s.opponents));
  }, []);

  // 로스터 변동(입퇴장)에만 반응 — 배열 참조가 아니라 id 시퀀스로 게이팅한다.
  const rosterKey = useMemo(() => opponents.map((p) => p.playerId).join(','), [opponents]);
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setRoster(
      opponentsRef.current.map((p, i) => ({ id: p.playerId, color: racePlaneColor(i) })),
    );
    applyOpponentsRef.current(useMultiplayerStore.getState().opponents);
  }, [rosterKey, index]);

  // reduced-motion(§7.3) → juice 강등(홉/펄스 없이 스냅). geoIndex가 늦게 도착하는 경우도 반영.
  useEffect(() => {
    handleRef.current?.setJuiceLevel(reducedMotion ? 1 : 0);
  }, [reducedMotion, index]);

  // 언마운트: 오버레이 프레임 해제(누수 방지). DOM 자체는 React가 컨테이너째 제거한다.
  useEffect(() => {
    return () => {
      handleRef.current?.clearRace();
      handleRef.current = null;
      placedRef.current.clear();
      followedRef.current = null;
    };
  }, []);

  return (
    <div ref={wrapRef} className="wt-race-globe" aria-hidden="true" data-testid="race-globe">
      {index && <GlobeMap index={index} className="wt-race-globe__map" onReady={onReady} />}
    </div>
  );
}
