// @vitest-environment jsdom
//
// spec: docs/09-chase-mode-goldrunner.md §7.1(브리핑)·§7.2(카운트다운)·§7.7(결과)·§8.1(화면 흐름·
//       ESC=자수), docs/00 §11-D90·D95, WT-CH-08 acceptance.
//
// 실 데이터(public/data/countries.json + countries-110m.json + @wt/data CHASE_GRAPH)로 전체 여정
// (로딩→브리핑→카운트다운→플레이→자수→결과)을 검증한다 — CandidateCallouts/WantedHud가 실
// GlobeChaseHandle(projectAnchor 등)을 요구해 legacy GamePage.test.tsx의 "useGlobeIndex: () => null"
// 우회가 불가능하다(globe-chase.test.ts와 동일하게 실 GlobeIndex를 구성 — WT-CH-05 전례). 타이핑으로
// 정확히 후보를 맞히는 홉 진행은(실 seed 의존 후보 텍스트 필요) 다루지 않고, 결정적인 ESC 자수
// 경로로 finished 전이를 검증한다.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CHASE_GRAPH } from '@wt/data';
import type { Country, ChaseGraph } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { useAuthStore, type AccountSession } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { ChaseGameRoot } from './ChaseGameRoot';

// vi.mock 팩토리는 파일 최상단으로 호이스트되므로(vitest 계약), 그 안에서 참조하는 픽스처는
// vi.hoisted로 같이 끌어올린다 — 일반 top-level const를 mock factory 안에서 참조하면
// "Cannot access before initialization"으로 실패한다.
const { COUNTRIES_DATASET, TOPOLOGY } = vi.hoisted(() => {
  // vi.hoisted 콜백은 실제 import 문보다 앞으로 물리적으로 끌어올려지므로(vitest 계약 — 위 주석
  // 참조) 파일 상단의 ESM import를 참조하면 TDZ로 깨진다. node 빌트인은 항상 사용 가능하므로
  // require()로 동기 로드한다(다른 대안인 top-level await 없는 동기 dynamic import는 없음).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolve } = require('node:path') as typeof import('node:path');
  function load(name: string): unknown {
    for (const base of ['public/data', 'apps/web/public/data']) {
      const p = resolve(process.cwd(), base, name);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    }
    throw new Error(`fixture not found: ${name}`);
  }
  return {
    COUNTRIES_DATASET: load('countries.json') as { countries: Country[] },
    TOPOLOGY: load('countries-110m.json'),
  };
});

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: COUNTRIES_DATASET.countries },
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

// GlobeMap이 실제로 마운트되어야 CandidateCallouts/WantedHud가 필요로 하는 GlobeChaseHandle이
// 만들어진다(chase는 legacy GamePage와 달리 지도가 배경 소품이 아니라 무대 자체 — 최종 보고 기재).
// topology fetch를 피하려 useGlobeIndex 자체를 실 인덱스로 목킹한다(globe-chase.test.ts 전례).
vi.mock('../../features/map/globe/useGlobeIndex', async () => {
  const { buildGlobeIndex } = await import('../../features/map/globe/globe-index');
  const index = buildGlobeIndex(TOPOLOGY as never, COUNTRIES_DATASET.countries);
  return { useGlobeIndex: () => index };
});

const startChaseMock = vi.fn().mockResolvedValue({ runToken: 'test-run-token', seed: 424242, constantsVersion: 1 });
const submitChaseRunMock = vi.fn().mockResolvedValue({
  verdict: 'valid', score: 1, pi: 1, cpm: 1, accMilli: 1000, grade: 'A', completed: false,
  rank: null, total: null, isPersonalBest: null, newUnlocks: [], shareText: null, shareId: null,
});
vi.mock('../../net/api-client', () => ({
  ensureSession: () => Promise.resolve(null),
  startChase: (...args: unknown[]) => startChaseMock(...args),
  submitChaseRun: (...args: unknown[]) => submitChaseRunMock(...args),
  getSessionToken: () => 'wt1.guest-session-token',
  getAuthToken: () => 'wt1.acct',
  setAuthToken: () => true,
  onLoginRequired: () => () => {},
  onAccountTokenRejected: () => () => {},
}));

vi.mock('./load-chase-graph', () => ({
  loadChaseGraph: () => Promise.resolve(CHASE_GRAPH as unknown as ChaseGraph),
}));

function loginSession(over: Partial<AccountSession> = {}): AccountSession {
  return {
    token: 'wt1.acct',
    playerId: 'p-acct',
    nickname: 'Traveler',
    expiresAt: Date.now() + 60_000,
    geo: 'KR',
    profile: { name: 'Traveler', picture: null, email: null },
    ...over,
  };
}

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

/** microtask 체인(fetch/promise .then)을 여러 hop 흘려보낸다(GamePage.test.tsx flushAsync 전례). */
async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderChase() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/play/chase']}>
        <ChaseGameRoot />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('ChaseGameRoot — 로딩→브리핑→카운트다운→플레이→자수→결과(WT-CH-08 acceptance)', () => {
  beforeAll(() => {
    // reduced-motion ON — globe-chase.ts의 immediate() 분기로 카메라 이동이 즉시 스냅되어(RAF
    // 루프 없음) fake timers와 안전하게 상호작용한다(globe-chase.test.ts와 동일 이유).
    stubMatchMedia(true);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.getState().setLang('ko');
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('부팅 중에는 로딩 화면을 보여주고, 완료되면 브리핑 카드로 전환한다', async () => {
    renderChase();
    expect(screen.getByTestId('chase-loading')).toBeInTheDocument();

    await flushAsync();

    expect(screen.getByTestId('chase-briefing-card')).toBeInTheDocument();
    // 미션 텍스트에 실 홈 국가명이 보간되어 있다(빈 문자열이 아님).
    const mission = screen.getByTestId('chase-briefing-mission').textContent ?? '';
    expect(mission.length).toBeGreaterThan(0);
    expect(startChaseMock).toHaveBeenCalledTimes(1);
  });

  it('브리핑 클릭 → 카운트다운 → 플레이 화면(WantedHud+콜아웃 오버레이)까지 전환된다', async () => {
    renderChase();
    await flushAsync();

    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(300)); // 스탬프 낙하
    expect(screen.getByTestId('chase-countdown')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000)); // COUNTDOWN_MS
    await flushAsync();

    expect(screen.getByTestId('chase-wanted-hud')).toBeInTheDocument();
    expect(screen.getByTestId('chase-candidate-overlay')).toBeInTheDocument();
    // 콜아웃 칩 3개가 고정 생성돼 있다(§8.5 "마운트 시 고정 생성").
    expect(document.querySelectorAll('[data-candidate]').length).toBe(3);
  });

  it('chase 오버레이는 브리핑(idle)에서 은닉, playing에서 표시, 결과(finished)에서 다시 은닉된다(§11-D111 ②-a)', async () => {
    renderChase();
    await flushAsync();

    const overlay = (): Element => document.querySelector('svg.wt-chase__overlay')!;
    // idle(브리핑) — 코어 idle spin 구간이라 은닉(마커 좌표가 회전을 따라가지 않는다).
    expect(overlay().classList.contains('is-hidden')).toBe(true);

    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(3300)); // 스탬프 낙하 + COUNTDOWN_MS
    await flushAsync();
    expect(overlay().classList.contains('is-hidden')).toBe(false);

    vi.useRealTimers(); // findBy*/waitFor는 real timers 필요(위 테스트들과 동일 사유)
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('chase-resign-confirm-btn'));
    await screen.findByTestId('chase-result-card');
    expect(overlay().classList.contains('is-hidden')).toBe(true);
  });

  it('첫 런 코치마크는 playing에서만 뜬다(브리핑·카운트다운엔 없음, §11-D111 ①)', async () => {
    localStorage.removeItem('wt:chase:tipsSeen');
    renderChase();
    await flushAsync();
    expect(screen.queryByTestId('chase-first-run-tips')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(300)); // 카운트다운 진입
    expect(screen.queryByTestId('chase-first-run-tips')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000)); // playing 진입
    await flushAsync();
    expect(screen.getByTestId('chase-first-run-tips')).toBeInTheDocument();
    // 비블로킹 — 코치마크는 포커스 가능 요소를 두지 않는다(입력을 가로채지 않는다, D96).
    expect(screen.getByTestId('chase-first-run-tips').querySelector('button, input')).toBeNull();
  });

  it('ESC(playing 중) → 자수 확인 모달 → 확인 시 심이 종료되고 결과 화면(비로그인=로그인 CTA)을 보여준다', async () => {
    renderChase();
    await flushAsync();
    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(3300));
    await flushAsync();
    // 카운트다운 스킵(fake timers)은 여기서 끝 — 이후 findBy*/waitFor의 내부 폴링(setTimeout/
    // Date.now() 기반)이 fake 시계 아래에서는 절대 전진하지 않아 vitest 테스트 타임아웃(5000ms)까지
    // 그대로 행(hang)한다(testing-library 알려진 함정). resign()은 동기 호출이라 실시간 전환은
    // 안전하다.
    vi.useRealTimers();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('chase-resign-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chase-resign-confirm-btn'));

    const resultCard = await screen.findByTestId('chase-result-card');
    expect(resultCard).toBeInTheDocument();
    expect(screen.getByTestId('chase-result-bounty').textContent).toMatch(/\d/);
    // 비로그인 — 랭킹 게이팅(§11-D68-①)으로 제출 시도 없이 로그인 CTA를 보여준다.
    expect(screen.getByTestId('chase-result-login-cta')).toBeInTheDocument();
    expect(submitChaseRunMock).not.toHaveBeenCalled();
  });

  it('로그인 상태로 자수하면 제출을 시도하고 서버 verdict를 반영한다', async () => {
    act(() => useAuthStore.getState().login(loginSession()));
    renderChase();
    await flushAsync();
    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(3300));
    await flushAsync();
    // 위 테스트와 동일 이유(findBy*/waitFor는 real timers 필요) — resign()은 동기 호출.
    vi.useRealTimers();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('chase-resign-confirm-btn'));

    await screen.findByTestId('chase-result-card');
    await waitFor(() => expect(submitChaseRunMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('chase-result-registered')).toBeInTheDocument();
  });

  it('결과 화면의 재도전은 새 시드를 재발급한다(startChase 재호출)', async () => {
    renderChase();
    await flushAsync();
    fireEvent.click(screen.getByTestId('chase-briefing-card'));
    act(() => vi.advanceTimersByTime(3300));
    await flushAsync();
    // 위 테스트들과 동일 이유(findBy*/waitFor는 real timers 필요) — resign()은 동기 호출.
    vi.useRealTimers();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('chase-resign-confirm-btn'));
    await screen.findByTestId('chase-result-card');

    expect(startChaseMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('chase-result-retry'));
    await flushAsync();
    expect(startChaseMock).toHaveBeenCalledTimes(2);
  });
});
