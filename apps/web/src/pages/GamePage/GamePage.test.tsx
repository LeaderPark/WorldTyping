// @vitest-environment jsdom
//
// spec: docs/01 §2.1(코어 루프)·§10.2(S5→S6→S7), docs/03 §4.2·§4.4·§4.5, WT-M2-06 acceptance —
// "남미선 12개국 한국어 완주 → 결과 표시 → R 리트라이 재개"·"티어 T1 진입 → 방치 → 타임아웃
// 라이프 차감 → 라이프 0 부분 점수 결과"의 dev 서버 수동 플레이 자동화 등가물(작업 특이 조정 3항).
// 전체 여정의 Playwright E2E는 WT-M2-08(E1·E4)이 별도로 커버한다.
//
// useBlocker는 데이터 라우터(useDataRouterContext)를 요구하므로 createMemoryRouter+RouterProvider를
// 쓴다 — router.test.tsx가 피한 "loader의 fetch/AbortController jsdom↔undici 충돌"은 loader 없는
// 라우트에는 재현되지 않는다(이 파일의 라우트는 loader를 달지 않는다).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Country } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { useSessionStore } from '../../stores/session';
import { GamePage } from './index';

function mk(
  id: string,
  nameKo: string,
  nameEn: string,
  tier: Country['difficultyTier'],
  continent: Country['continent'],
): Country {
  return {
    id,
    iso3: `${id}X`,
    nameKo,
    nameEn,
    aliasesKo: [],
    aliasesEn: [],
    continent,
    subregion: '',
    difficultyTier: tier,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '🏳️',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [nameKo],
    acceptedInputsEn: [nameEn.toLowerCase()],
  };
}

// 남미선(ROUTE_SOUTH_AMERICA, @wt/data/content/routes.ts) 12개국 — 순서 그대로.
const SOUTH_AMERICA: Country[] = [
  mk('CO', '콜롬비아', 'colombia', 2, 'south-america'),
  mk('VE', '베네수엘라', 'venezuela', 2, 'south-america'),
  mk('GY', '가이아나', 'guyana', 3, 'south-america'),
  mk('SR', '수리남', 'suriname', 3, 'south-america'),
  mk('BR', '브라질', 'brazil', 2, 'south-america'),
  mk('PY', '파라과이', 'paraguay', 2, 'south-america'),
  mk('UY', '우루과이', 'uruguay', 2, 'south-america'),
  mk('AR', '아르헨티나', 'argentina', 2, 'south-america'),
  mk('CL', '칠레', 'chile', 2, 'south-america'),
  mk('BO', '볼리비아', 'bolivia', 2, 'south-america'),
  mk('PE', '페루', 'peru', 2, 'south-america'),
  mk('EC', '에콰도르', 'ecuador', 2, 'south-america'),
];

// 티어 1 풀(5개, 전부 동일 nameKo="가나" → L=4로 고정해 제한시간을 손계산 가능하게 만든다:
// timeLimitMs = clamp(3, 1.5 + 4*0.4*1.3, 15) = 3.58s, 첫 국가만 ×2 = 7.16s).
const TIER1_POOL: Country[] = [
  mk('Q1', '가나', 'q1', 1, 'africa'),
  mk('Q2', '가나', 'q2', 1, 'africa'),
  mk('Q3', '가나', 'q3', 1, 'africa'),
  mk('Q4', '가나', 'q4', 1, 'africa'),
  mk('Q5', '가나', 'q5', 1, 'africa'),
];

const FIXTURE = [...SOUTH_AMERICA, ...TIER1_POOL];

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: FIXTURE },
    config: {
      schemaVersion: 2,
      dataUrl: '/data/countries.json',
      mapUrl: '/data/countries-110m.json',
      grades: { S: 450, A: 340, B: 230, C: 120 },
      timeLimit: { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 },
      anticheat: { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 },
      featureFlags: {},
    },
    dataVersion: 'test',
  }),
}));

// 지도는 juice 배경일 뿐 게임 로직과 무관(§3.6) — fetch 없이 렌더를 단순화한다. 실제 지구본 배선
// 계약은 GlobeMap.test.tsx(WT-DC-08)가 검증한다. GamePage는 이제 지구본(useGlobeIndex)을 쓴다.
vi.mock('../../features/map/globe/useGlobeIndex', () => ({
  useGlobeIndex: () => null,
}));

/** runs/start(모드별 세트)·runs/submit(제출)에 응답하는 최소 fetch 목(WT-M3-06). 티어는
 *  TIER1_POOL과 동일 순서의 countryIds를 내려줘 이 파일의 손계산 제한시간 시나리오가 그대로
 *  성립하게 한다(서버 세트로 교체되어도 로컬 픽스처와 동일 국가 집합·순서). */
function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
  const json = (obj: unknown): Response =>
    new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (url.includes('/runs/start')) {
    const countryIds = body?.mode === 'tier' ? TIER1_POOL.map((c) => c.id) : SOUTH_AMERICA.map((c) => c.id);
    return Promise.resolve(
      json({ runToken: 'test-run-token', runId: 'test-run-id', serverStartTs: Date.now(), countryIds, seed: 'test-seed' }),
    );
  }
  if (url.includes('/runs/submit')) {
    return Promise.resolve(
      json({ verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'S', completed: true, rank: 1, total: 1, isPersonalBest: true }),
    );
  }
  return Promise.resolve(json({}));
}

/** microtask 체인(fetch→json→apiClient→useRunStart의 .then)이 여러 hop이라 act(async) 몇 회로
 *  전부 흘려보낸다(fake timers는 매크로태스크만 대상 — 마이크로태스크 큐와는 무관). */
async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderGame(mode: string, trackId: string) {
  const router = createMemoryRouter(
    [
      // 홈 스텁: confirm-leave "나가기"/"다른 노선"이 실제로 navigate(...)하는 대상 경로가
      // 매치되지 않으면 RR 기본 ErrorBoundary가 콘솔에 소음을 낸다 — 실제 라우트 트리(router.tsx)
      // 대신 이 테스트가 조작하는 것만 최소로 둔다.
      { path: '/', element: <div data-testid="home-stub" /> },
      { path: '/play/:mode', element: <div data-testid="track-select-stub" /> },
      { path: '/play/:mode/:trackId', element: <GamePage /> },
    ],
    { initialEntries: [`/play/${mode}/${trackId}`] },
  );
  const result = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, ...result };
}

/** 한 음절씩 누적 입력(한 스냅샷당 최대 3자모 — BULK_INSERT_MAX_ADDED=8 미만이라 붙여넣기로
 *  오판되지 않는다). 실제 IME 조합 이벤트는 흉내내지 않지만 §2.3 value-snapshot 판정 원칙상
 *  최종 스냅샷만이 EXACT 여부를 가른다. */
function typeKoIncremental(input: HTMLInputElement, full: string): void {
  let acc = '';
  for (const ch of full) {
    acc += ch;
    const value = acc;
    act(() => {
      input.value = value;
      fireEvent.input(input, { target: { value } });
    });
  }
}

function boardAndDepart(): void {
  fireEvent.click(screen.getByTestId('boarding-card'));
  act(() => vi.advanceTimersByTime(200)); // 개찰 애니메이션(§10.2 S5)
  act(() => vi.advanceTimersByTime(3000)); // COUNTDOWN_MS
}

describe('GamePage — S5→S6→S7 수직 슬라이스(WT-M2-06 acceptance)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.getState().setLang('ko');
    useSessionStore.getState().reset();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('대륙 모드: 남미선 12개국 완주 → 결과 표시 → R 리트라이로 재개', () => {
    renderGame('continent', 'south-america');

    expect(screen.getByTestId('boarding-pass')).toBeInTheDocument();
    boardAndDepart();

    expect(screen.getByTestId('game-view')).toBeInTheDocument();
    const input = screen.getByTestId('hidden-typing-input') as HTMLInputElement;

    for (const country of SOUTH_AMERICA) {
      typeKoIncremental(input, country.nameKo);
    }

    // 완주 → 결과 화면. 점수는 엔진의 computeScore 산출을 그대로 표시할 뿐(재계산 금지 제약).
    const resultView = screen.getByTestId('result-view');
    expect(resultView).toBeInTheDocument();
    const cardText = screen.getByTestId('result-card').textContent ?? '';
    expect(cardText).toContain('완주'); // 미완주(outcome=gameover) 라벨이 아니다.
    expect(cardText).toContain('100%'); // 무오타 완주 — 정확도 100%.
    expect(cardText).toContain('×12'); // 콤보 12(전 국가 무오타 확정).

    // 랭킹은 /rank 링크(WT-M3-06), 공유는 WT-M5-04에서 실배선(desktop 기본 — 클립보드/다운로드).
    expect(screen.getByTestId('result-ranking')).toHaveAttribute('href', '/rank');
    expect(screen.getByTestId('result-share')).not.toBeDisabled();

    // R 리트라이 → 2초(RETRY_COUNTDOWN_MS=1500ms) 내 재개.
    act(() => fireEvent.keyDown(window, { key: 'r' }));
    expect(screen.queryByTestId('result-view')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));

    expect(screen.getByTestId('game-view')).toBeInTheDocument();
    expect(screen.getByTestId('progress-count').textContent).toBe('1 / 12');
  });

  it('티어 모드: T1 방치 → 타임아웃마다 라이프 차감 → 라이프 0 → 부분 점수(미완주) 결과', async () => {
    renderGame('tier', '1');
    // runs/start(서버 세트 확정) 응답을 기다린다 — 티어는 그 전까지 BoardingPass CTA가
    // 잠긴다(WT-M3-06 구현 세부 지시 1, useRunStart status==='loading').
    await flushAsync();

    boardAndDepart();
    expect(screen.getByTestId('game-view')).toBeInTheDocument();
    expect(screen.getByTestId('hud-lives').textContent).toBe('♥♥♥');

    // 손계산: §7.2 3.58s × TIER_TIME_FACTOR[T1]=1.2 = 4.296s(§11-D107 티어 모드 계수),
    // 첫 국가(indexInRun=0)는 ×2 = 8.592s. 버퍼 48ms.
    act(() => vi.advanceTimersByTime(8640));
    expect(screen.getByTestId('hud-lives').textContent).toBe('♥♥');

    // 이후 국가(indexInRun>0) 제한시간 = 4.296s(×2 없음).
    act(() => vi.advanceTimersByTime(4340));
    expect(screen.getByTestId('hud-lives').textContent).toBe('♥');

    act(() => vi.advanceTimersByTime(4340));

    // 라이프 0 → 게임오버(부분 점수, 5개국 중 3개국만 진행됐으므로 미완주).
    const resultView = screen.getByTestId('result-view');
    expect(resultView).toBeInTheDocument();
    const cardText = screen.getByTestId('result-card').textContent ?? '';
    expect(cardText).toContain('라이프 소진');
    expect(screen.queryByTestId('hud-lives')).not.toBeInTheDocument();
  });

  it('브라우저 뒤로가기(진행 중) = 포기 확인 모달, "계속하기" 선택 시 판이 유지된다', () => {
    // [환경 메모] "나가기"(confirm-leave-go)는 blocker.proceed()로 실제 내비게이션을 재개하는데,
    // 이 jsdom+Node 조합에서 데이터 라우터의 navigate()가 내부적으로 만드는 Request의
    // AbortSignal이 jsdom 실체와 undici 실체가 달라 충돌한다(router.test.tsx가 loader
    // 관련으로 이미 문서화한 것과 동일 부류의 jsdom↔undici interop 이슈 — 실브라우저에는 없다).
    // 그래서 이 자동화 테스트는 "계속하기"(blocker.reset(), 내비게이션 없음) 경로만 검증하고,
    // "나가기"의 실제 라우트 전환은 리드 수동 확인/E2E(WT-M2-08)로 넘긴다.
    const { router } = renderGame('continent', 'south-america');
    boardAndDepart();
    expect(screen.getByTestId('game-view')).toBeInTheDocument();

    act(() => {
      void router.navigate('/');
    });
    expect(screen.getByTestId('confirm-leave')).toBeInTheDocument();

    act(() => fireEvent.click(screen.getByTestId('confirm-leave-stay')));
    expect(screen.queryByTestId('confirm-leave')).not.toBeInTheDocument();
    expect(screen.getByTestId('game-view')).toBeInTheDocument();
    expect(useSessionStore.getState().phase).not.toBe('aborted');
  });
});
