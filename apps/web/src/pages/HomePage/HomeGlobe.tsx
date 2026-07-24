// spec: docs/00 §11-D67-⑦(평면 WorldMap·HeroMap·RouteMotifBackdrop은 홈 배선 폐기, 파일 존치)·
//       D68-⑦(홈 배경 = GlobeMap 자동 데모 — idle spin + 주기 홉, reduced-motion 시 정적),
//       docs/03 §3.7(지구본 여정 무대 — canvas 베이스+SVG 오버레이)·§4.5(고빈도 값은 React
//       state/Zustand 금지 — 명령형 DOM/핸들만), WT-AUTH-07(이 태스크).
//
// 홈 전체 화면 배경 지구본. GlobeMap(WT-DC-08)의 핸들만 소비한다 — features/map/globe 내부는
// 전혀 수정하지 않는다(setIdleSpin/moveVehicle/drawRouteSegment/markSolved/reset만 호출). 게임
// 세션이 없는 화면이라 이 파일이 "자동 데모 드라이버"(startHomeGlobeDemo)를 직접 소유한다:
// idle spin을 켜고, 8±3초마다 tier1/2(난이도 낮음=식별하기 쉬운) 국가 중 무작위 목적지로
// drawRouteSegment→markSolved→moveVehicle을 호출해 노선이 계속 그려지며 비행기가 날아다니게
// 만든다. ~16홉마다 reset()으로 노선/스테이션을 비우고 처음부터 다시 시작한다(무한히 쌓이는
// 궤적 방지).
//
// startHomeGlobeDemo는 React state를 전혀 쓰지 않는다 — setTimeout 체인 + 핸들 호출뿐(§4.5).
// reduced-motion·목적지 없음·pause/resume/stop을 전부 이 함수 스스로 판단한다(React 컴포넌트는
// 얇은 배선만) — 그래야 "가짜 핸들"만으로 온전히 단위 테스트된다. reduced-motion이면 idle spin도
// 켜지 않고 홉도 걸지 않는다(GlobeMap도 immediate() 가드로 스스로 억제하지만, 카메라가 순간이동
// 하듯 튀는 것을 막기 위해 애초에 홉을 걸지 않는다 — 지구본은 INITIAL_CENTER에 정적으로 남는다).
// document.hidden 동안은 이 드라이버의 타이머만 pause()한다 — GlobeMap 자체의 rAF 정지/재개는
// GlobeMap.tsx 자신의 visibilitychange 핸들러가 이미 처리하므로 중복할 필요가 없다.
import { useCallback, useEffect, useRef } from 'react';
import type { Continent, Country, CountryId } from '@wt/shared';
import { getBootData } from '../../app/bootLoader';
import { GlobeMap, type GlobeMapHandle } from '../../features/map/globe/GlobeMap';
import { useGlobeIndex } from '../../features/map/globe/useGlobeIndex';

/** 홉 간격 10~22초([WT-UI 후속] 5~11초는 카메라 스윙이 잦아 "확확 도는" 느낌이라 리드 요청으로
 *  약 2배로 늘려 더 자연스럽고 은은한 배경으로 — 이동 자체(hopDurationMs)는 게임플레이 공용이라 불변). */
export const HOME_GLOBE_MIN_HOP_DELAY_MS = 10_000;
export const HOME_GLOBE_MAX_HOP_DELAY_MS = 22_000;
/** ~16홉마다 reset() 후 재시작(리드 확정). */
export const HOME_GLOBE_RESET_EVERY_HOPS = 16;
/** 홈 데모 순항 시간(ms) — 참조 프로토타입의 크루즈 느낌 이식(Tweak E, §11-D73). B의 10~22초 홉
 *  간격 안에 순항 2.6s + 트레일 페이드 0.6s가 여유 있게 수용된다. 인게임 hopDurationMs는 불변. */
export const HOME_GLOBE_HOP_DURATION_MS = 2600;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** tier1/2(난이도 낮음=식별하기 쉬운 국가)만 데모 목적지 풀로 쓴다. 순수 함수(단위 테스트용). */
export function selectHomeGlobeDestinations(countries: readonly Country[]): CountryId[] {
  return countries.filter((c) => c.difficultyTier === 1 || c.difficultyTier === 2).map((c) => c.id);
}

export interface HomeGlobeDemoDeps {
  handle: GlobeMapHandle;
  /** tier1/2 목적지 풀(selectHomeGlobeDestinations 결과) — 비어 있으면 홉 루프는 기동하지 않는다. */
  destinations: readonly CountryId[];
  continentOf: (id: CountryId) => Continent | undefined;
  /** true면 idle spin도 켜지 않고 홉도 걸지 않는다(정적 유지) — 기본 false. */
  reducedMotion?: boolean;
  /** 테스트 결정성 주입용(기본 Math.random). */
  random?: () => number;
}

export interface HomeGlobeDemoController {
  /** 언마운트 시 1회 — 이후 어떤 타이머도 남지 않는다. */
  stop(): void;
  /** document.hidden 진입 — 다음 홉 타이머만 취소. */
  pause(): void;
  /** document.hidden 해제 — 타이머 재개. */
  resume(): void;
}

/**
 * 홈 배경 홉 데모 드라이버(§4.5 — React state 0, 타이머+핸들 호출뿐). reducedMotion이거나
 * destinations가 비어 있으면 아무 타이머도 걸지 않는 no-op 컨트롤러를 반환한다.
 */
export function startHomeGlobeDemo(deps: HomeGlobeDemoDeps): HomeGlobeDemoController {
  const { handle, destinations, continentOf, reducedMotion = false, random = Math.random } = deps;

  const hopLoopEnabled = !reducedMotion && destinations.length > 0;
  let stopped = !hopLoopEnabled;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: CountryId | null = null;
  let hops = 0;

  // idle spin은 홉 목적지 유무와 무관하게 reduced-motion에만 종속된다(부팅 데이터가 늦게 와도
  // 지구본은 계속 천천히 돈다).
  if (!reducedMotion) handle.setIdleSpin(true);

  function pickNext(exclude: CountryId | null): CountryId {
    // 호출 시점(hop() 내부)엔 항상 destinations.length>=1이 보장된다(stopped 가드) — 논-널
    // 단언은 noUncheckedIndexedAccess가 요구하는 형식적 가드일 뿐 실제 undefined 분기는 없다.
    let candidate = destinations[0]!;
    if (destinations.length === 1) return candidate;
    for (let attempt = 0; attempt < 8; attempt++) {
      const picked = destinations[Math.floor(random() * destinations.length)];
      if (picked !== undefined) candidate = picked;
      if (candidate !== exclude) break;
    }
    return candidate;
  }

  function scheduleNext(): void {
    if (stopped || paused) return;
    const span = HOME_GLOBE_MAX_HOP_DELAY_MS - HOME_GLOBE_MIN_HOP_DELAY_MS;
    timer = setTimeout(hop, HOME_GLOBE_MIN_HOP_DELAY_MS + random() * span);
  }

  function hop(): void {
    timer = null;
    if (stopped || paused) return;
    const next = pickNext(current);
    if (current === null) {
      // 첫 홉 — 출발지 스냅 배치(노선 없음, GamePage의 index===0 패턴과 동일).
      handle.moveVehicle(next, next, { durationMs: 0 });
    } else {
      handle.drawRouteSegment(current, next);
      handle.markSolved(next, `var(--continent-${continentOf(next) ?? 'asia'})`);
      handle.moveVehicle(current, next, { durationMs: HOME_GLOBE_HOP_DURATION_MS });
    }
    current = next;
    hops += 1;
    if (hops >= HOME_GLOBE_RESET_EVERY_HOPS) {
      handle.reset();
      current = null;
      hops = 0;
    }
    scheduleNext();
  }

  scheduleNext(); // reducedMotion/목적지 없음이면 stopped=true라 no-op.

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      scheduleNext();
    },
  };
}

export function HomeGlobe(): JSX.Element {
  const index = useGlobeIndex();
  const controllerRef = useRef<HomeGlobeDemoController | null>(null);

  const onReady = useCallback(
    (handle: GlobeMapHandle): void => {
      if (!index) return; // 방어적 가드 — GlobeMap은 index가 truthy일 때만 마운트되므로 항상 참이다.

      let countries: readonly Country[] = [];
      try {
        countries = getBootData().countries.countries;
      } catch {
        countries = []; // 부팅 데이터 미도착 — 홉 없이 idle spin만(reduced-motion 아니면).
      }
      controllerRef.current = startHomeGlobeDemo({
        handle,
        destinations: selectHomeGlobeDestinations(countries),
        continentOf: (id) => index.continent.get(id),
        reducedMotion: prefersReducedMotion(),
      });
    },
    [index],
  );

  useEffect(() => {
    const onVisibility = (): void => {
      const controller = controllerRef.current;
      if (!controller) return;
      if (typeof document !== 'undefined' && document.hidden) controller.pause();
      else controller.resume();
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, []);

  return (
    <div className="wt-home__globe" aria-hidden="true" data-testid="home-globe">
      {index ? (
        <GlobeMap index={index} className="wt-home__globe-canvas" onReady={onReady} />
      ) : (
        <div className="wt-home__globe-placeholder" data-testid="home-globe-loading" />
      )}
    </div>
  );
}

// React.lazy(() => import('./HomeGlobe'))는 default export를 요구한다(HeroMap.tsx와 동일 패턴).
export default HomeGlobe;
