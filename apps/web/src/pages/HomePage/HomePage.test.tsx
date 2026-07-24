// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S1 홈 와이어프레임), §11.1(1단계 — 싱글플레이 카드 펄스), WT-M2-07,
//       WT-AUTH-07(홈 배경이 HeroMap+RouteMotifBackdrop에서 HomeGlobe로 교체됨)
//
// bootLoader를 일부러 목킹하지 않는다 — HomeGlobe(useGlobeIndex)가 부팅 데이터 없이도 안전하게
// placeholder로 폴백하는지(app/router.test.tsx의 "로더 없이 홈을 렌더" 전제와 동일 계약, 이전
// HeroMap/useWorldGeoIndex와 동일한 방어 패턴)를 이 파일 자체가 실증한다.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { HomePage } from './index';

const fetchDailyTodayMock = vi.fn();
const fetchDailyMeMock = vi.fn();
const fetchLbPageMock = vi.fn();
const ensureSessionMock = vi.fn();
// [WT-AUTH-03] importActual로 실제 모듈을 보존한 뒤 4개 조회 함수만 목킹한다 — HomePage가 이제
// AuthChip→stores/auth를 거쳐 api-client의 계정 토큰/LOGIN_REQUIRED 시그널 함수를 로드하므로,
// 전체 대체 목이면 auth 스토어 모듈 로드가 onLoginRequired undefined로 크래시한다.
vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return {
    ...actual,
    fetchDailyToday: (...args: unknown[]) => fetchDailyTodayMock(...args),
    fetchDailyMe: (...args: unknown[]) => fetchDailyMeMock(...args),
    fetchLbPage: (...args: unknown[]) => fetchLbPageMock(...args),
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
    fetchLbPageMock.mockResolvedValue({ entries: [], nextCursor: null, total: 0 });
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: 'GUEST_0001', expiresAt: '' });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
    expect(screen.getByTestId('home-daily-badge').getAttribute('href')).toMatch(/^\/play\/daily\//);
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

  it('데일리 뱃지가 실 dailyNo·alreadyPlayed를 반영한다(WT-M3-06)', async () => {
    fetchDailyMeMock.mockResolvedValue({ dateKst: '2026-07-21', alreadyPlayed: true, streakDaily: 3 });
    renderHome();

    await waitFor(() => expect(screen.getByTestId('home-daily-badge').textContent).toContain('42'));
    expect(screen.getByTestId('home-daily-badge')).toHaveAttribute('data-played', 'true');
  });

  it('서버 전체 1위가 있으면 home-ticker-top1을 렌더한다', async () => {
    fetchLbPageMock.mockResolvedValue({
      entries: [{ rank: 1, userId: 'p1', nickname: 'NIMBUS', passportCover: 'basic-green', score: 61430, elapsedMs: 1000, accMilli: 989, achievedAt: 1 }],
      nextCursor: null,
      total: 1,
    });
    renderHome();

    await waitFor(() => expect(screen.getByTestId('home-ticker-top1')).toBeInTheDocument());
    expect(screen.getByTestId('home-ticker-top1').textContent).toContain('NIMBUS');
    expect(screen.getByTestId('home-ticker-top1').textContent).toContain('61430');
  });

  it('보드가 비어있으면 home-ticker-top1을 렌더하지 않는다', () => {
    renderHome();
    expect(screen.queryByTestId('home-ticker-top1')).not.toBeInTheDocument();
  });
});
