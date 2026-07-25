// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S1 홈 와이어프레임), §11.1(1단계 — 싱글플레이 카드 펄스), WT-M2-07,
//       WT-AUTH-07(홈 배경이 HeroMap+RouteMotifBackdrop에서 HomeGlobe로 교체됨),
//       WT-PASSPORT-LOGIN-GATE-v3(리드 확정 — 여권 카드는 비로그인 클릭을 게이트한다)
//
// bootLoader를 일부러 목킹하지 않는다 — HomeGlobe(useGlobeIndex)가 부팅 데이터 없이도 안전하게
// placeholder로 폴백하는지(app/router.test.tsx의 "로더 없이 홈을 렌더" 전제와 동일 계약, 이전
// HeroMap/useWorldGeoIndex와 동일한 방어 패턴)를 이 파일 자체가 실증한다.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { useAuthStore, type AccountSession } from '../../stores/auth';
import { HomePage } from './index';

function loginSession(): AccountSession {
  return {
    token: 'wt1.acct',
    playerId: 'p1',
    nickname: 'NIMBUS',
    expiresAt: Date.now() + 60_000,
    geo: 'KR',
    profile: { name: 'NIMBUS', picture: null, email: null },
  };
}

/** 여권 카드 게이트는 실제 <Link>/navigate 이동 여부를 관측해야 하므로 목적지 라우트를 갖춘
 *  트리가 필요하다(맨몸 renderHome()은 HomePage만 마운트해 이동 여부를 볼 수 없다). */
function renderHomeRouted() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/passport" element={<div data-testid="passport-stub" />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

const fetchDailyTodayMock = vi.fn();
const fetchDailyMeMock = vi.fn();
const ensureSessionMock = vi.fn();
// [WT-AUTH-03] importActual로 실제 모듈을 보존한 뒤 조회 함수만 목킹한다 — HomePage가 이제
// AuthChip→stores/auth를 거쳐 api-client의 계정 토큰/LOGIN_REQUIRED 시그널 함수를 로드하므로,
// 전체 대체 목이면 auth 스토어 모듈 로드가 onLoginRequired undefined로 크래시한다.
// [§11-D87] 홈 전체1위 티커 제거로 fetchLbPage 조회가 없어져 해당 목도 함께 폐지.
vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return {
    ...actual,
    fetchDailyToday: (...args: unknown[]) => fetchDailyTodayMock(...args),
    fetchDailyMe: (...args: unknown[]) => fetchDailyMeMock(...args),
    ensureSession: (...args: unknown[]) => ensureSessionMock(...args),
  };
});

function renderHome() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <HomePage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('HomePage (S1)', () => {
  beforeEach(() => {
    localStorage.setItem('wt:lang', 'ko'); // 언어 게이트가 다른 어서션을 가리지 않게.
    useMetaStore.getState().reset();
    useSettingsStore.getState().setLang('ko');
    fetchDailyTodayMock.mockResolvedValue({ dailyNo: 42, dateKst: '2026-07-21', seed: 's', countryIds: [] });
    fetchDailyMeMock.mockResolvedValue({ dateKst: '2026-07-21', alreadyPlayed: false, streakDaily: 0 });
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: 'GUEST_0001', expiresAt: '' });
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });

  it('부팅 데이터 없이도 배경 지구본이 placeholder로 안전하게 렌더된다(throw 없음, WT-AUTH-07)', () => {
    renderHome();
    // Suspense fallback(HomeGlobePlaceholder)과 HomeGlobe 내부의 "인덱스 대기" 상태가 동일
    // 마크업(같은 testid)을 공유하므로, 청크/인덱스 로딩 타이밍과 무관하게 항상 참이다(D45 패턴).
    expect(screen.getByTestId('home-globe')).toBeInTheDocument();
    expect(screen.getByTestId('home-globe-loading')).toBeInTheDocument();
  });

  it('싱글/멀티/데일리 3개 카드와 랭킹/여권/설정 내비를 렌더한다', () => {
    renderHome();
    expect(screen.getByTestId('home-card-single')).toHaveAttribute('href', '/play');
    expect(screen.getByTestId('home-card-multi')).toHaveAttribute('href', '/multi');
    expect(screen.getByTestId('home-card-daily').getAttribute('href')).toMatch(/^\/play\/daily\//);
    expect(screen.getByTestId('home-nav-rank')).toHaveAttribute('href', '/rank');
    expect(screen.getByTestId('home-nav-passport')).toHaveAttribute('href', '/passport');
  });

  it('완주 기록이 하나도 없으면 싱글플레이 행이 펄스된다(§11.1 1단계)', () => {
    renderHome();
    expect(screen.getByTestId('home-card-single').className).toContain('wt-home__menu-row--pulse');
  });

  it('완주 기록이 있으면 펄스가 사라진다', () => {
    useMetaStore.getState().addStamp('continent:asia');
    renderHome();
    expect(screen.getByTestId('home-card-single').className).not.toContain('wt-home__menu-row--pulse');
  });

  it('언어 토글 버튼이 lang을 뒤집는다', () => {
    renderHome();
    const toggle = screen.getByTestId('home-lang-toggle');
    toggle.click();
    expect(useSettingsStore.getState().lang).toBe('en');
  });

  // ── 여권 카드 로그인 게이트(WT-PASSPORT-LOGIN-GATE-v3, 리드 확정) ──────────────────────
  // 비로그인 클릭은 네비게이션을 막고 로그인 모달만 연다(홈에 머무름). 로그인이 같은 탭에서
  // 성립하면 보류해 둔 /passport 이동을 자동 재개하고, 모달을 취소하면 보류를 폐기한다.
  describe('여권 카드 로그인 게이트', () => {
    it('비로그인 상태로 클릭하면 네비게이션 없이 "passport" 사유로 로그인 모달만 연다', () => {
      renderHomeRouted();
      fireEvent.click(screen.getByTestId('home-nav-passport'));

      expect(screen.queryByTestId('passport-stub')).not.toBeInTheDocument();
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
      expect(useAuthStore.getState().loginReason).toBe('passport');
    });

    it('로그인 상태로 클릭하면 정상적으로 /passport로 이동한다', () => {
      act(() => useAuthStore.getState().login(loginSession()));
      renderHomeRouted();
      fireEvent.click(screen.getByTestId('home-nav-passport'));

      expect(screen.getByTestId('passport-stub')).toBeInTheDocument();
    });

    it('비로그인 클릭 후 로그인이 성립하면 보류해 둔 /passport 이동을 자동 재개한다', () => {
      renderHomeRouted();
      fireEvent.click(screen.getByTestId('home-nav-passport'));
      expect(useAuthStore.getState().loginReason).toBe('passport');

      act(() => useAuthStore.getState().login(loginSession()));

      expect(screen.getByTestId('passport-stub')).toBeInTheDocument();
    });

    it('비로그인 클릭 후 모달을 취소하면 보류가 해제되어 이후 로그인에도 자동 이동하지 않는다', () => {
      renderHomeRouted();
      fireEvent.click(screen.getByTestId('home-nav-passport'));
      expect(useAuthStore.getState().loginReason).toBe('passport');

      act(() => useAuthStore.getState().closeLogin());
      act(() => useAuthStore.getState().login(loginSession()));

      expect(screen.queryByTestId('passport-stub')).not.toBeInTheDocument();
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });
  });
});
