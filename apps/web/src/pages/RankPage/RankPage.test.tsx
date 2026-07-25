// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S8), docs/06 §1.4(조회 계약), docs/00 §11-D68, WT-M3-06·WT-AUTH-04(랭킹 게이팅)
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useAuthStore, type AccountSession } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { RankPage } from './index';

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

const fetchLbPageMock = vi.fn();
const fetchLbMeMock = vi.fn();
const ensureSessionMock = vi.fn();
const fetchSessionMeMock = vi.fn();

vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return {
    ...actual,
    fetchLbPage: (...args: unknown[]) => fetchLbPageMock(...args),
    fetchLbMe: (...args: unknown[]) => fetchLbMeMock(...args),
    ensureSession: (...args: unknown[]) => ensureSessionMock(...args),
    fetchSessionMe: (...args: unknown[]) => fetchSessionMeMock(...args),
  };
});

function mkEntry(o: {
  rank?: number;
  userId?: string;
  nickname?: string;
  score?: number;
  elapsedMs?: number;
  accMilli?: number;
} = {}) {
  return {
    rank: o.rank ?? 1,
    userId: o.userId ?? 'p1',
    nickname: o.nickname ?? 'NIMBUS',
    passportCover: 'basic-green',
    score: o.score ?? 1000,
    elapsedMs: o.elapsedMs ?? 60000,
    accMilli: o.accMilli ?? 980,
    achievedAt: 1,
  };
}

function renderPage() {
  return render(
    <AppProviders>
      {/* [D74] PageHeader(브랜드/뒤로가기 <Link>) 도입으로 Router 컨텍스트가 필요하다. */}
      <MemoryRouter>
        <RankPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('RankPage', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
    useSettingsStore.getState().setLang('ko');
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: 'NIMBUS', expiresAt: '', geo: 'XX' });
    fetchSessionMeMock.mockResolvedValue({ playerId: 'p1', nickname: 'NIMBUS', status: 'active', geo: 'XX' });
    fetchLbMeMock.mockResolvedValue({ rank: null, total: 0, percentile: null, onBoard: false });
    fetchLbPageMock.mockResolvedValue({ entries: [mkEntry()], nextCursor: null, total: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAuthStore.getState().logout();
    useAuthStore.getState().closeLogin();
  });

  it('마운트 시 기본 필터(전체·세계일주)로 조회한다', async () => {
    renderPage();
    await waitFor(() => expect(fetchLbPageMock).toHaveBeenCalled());
    expect(fetchLbPageMock).toHaveBeenCalledWith('worldtour|ko|desktop|all', {});
  });

  it('모드/언어 필터를 바꾸면 새 board_key로 재조회한다(기간·기기·지역은 고정)', async () => {
    renderPage();
    await waitFor(() => expect(fetchLbPageMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('rank-filter-mode'), { target: { value: 'tier:3' } });
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toBe('tier:3|ko|desktop|all');
    });

    fireEvent.click(screen.getByTestId('rank-lang-en'));
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toBe('tier:3|en|desktop|all');
    });
  });

  it('행 목록·내 행 하이라이트를 렌더한다', async () => {
    fetchLbPageMock.mockResolvedValue({
      entries: [mkEntry({ rank: 1, userId: 'other', nickname: 'OTHER' }), mkEntry({ rank: 2, userId: 'p1', nickname: 'ME' })],
      nextCursor: null,
      total: 2,
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rank-row-p1')).toBeInTheDocument());
    expect(screen.getByTestId('rank-row-p1').textContent).toContain('나 (ME)');
    expect(screen.getByTestId('rank-row-other').textContent).toContain('OTHER');
    expect(screen.getByTestId('rank-total').textContent).toBe('2');
  });

  it('로그인 상태 + 내 행이 페이지 밖이면 /lb/me 요약을 고정 표시한다', async () => {
    act(() => useAuthStore.getState().login(loginSession()));
    fetchLbPageMock.mockResolvedValue({ entries: [mkEntry({ userId: 'other' })], nextCursor: null, total: 2000 });
    fetchLbMeMock.mockResolvedValue({ rank: 841, total: 2000, percentile: 0.42, onBoard: true });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rank-my-row-pinned')).toBeInTheDocument());
    expect(screen.getByTestId('rank-my-row-pinned').textContent).toContain('841');
    expect(screen.queryByTestId('rank-login-cta')).not.toBeInTheDocument();
  });

  // ── 랭킹 게이팅(WT-AUTH-04, §11-D68-①) ────────────────────────────────────
  describe('로그인 게이팅', () => {
    it('비로그인이면 "내 순위" 자리에 로그인 CTA를 보여준다(등재된 순위가 있을 수 없다)', async () => {
      fetchLbMeMock.mockResolvedValue({ rank: 841, total: 2000, percentile: 0.42, onBoard: true }); // 실제로는 불가능한 값이어도 CTA가 우선한다.
      renderPage();

      await waitFor(() => expect(screen.getByTestId('rank-login-cta')).toBeInTheDocument());
      expect(screen.getByTestId('rank-login-cta').textContent).toBe('로그인하고 내 기록을 등록하세요');
      expect(screen.queryByTestId('rank-my-row-pinned')).not.toBeInTheDocument();
    });

    it('로그인 CTA 클릭 → 로그인 모달을 "랭킹" 사유로 연다', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rank-login-cta')).toBeInTheDocument());

      act(() => fireEvent.click(screen.getByTestId('rank-login-cta')));
      expect(useAuthStore.getState().loginReason).toBe('ranking');
    });
  });

  it('더 보기 클릭 시 커서로 다음 페이지를 이어붙인다', async () => {
    fetchLbPageMock.mockResolvedValueOnce({ entries: [mkEntry({ userId: 'p1' })], nextCursor: 'cursor-1', total: 2 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('rank-load-more')).toBeInTheDocument());

    fetchLbPageMock.mockResolvedValueOnce({ entries: [mkEntry({ userId: 'p2', rank: 2, nickname: 'B' })], nextCursor: null, total: 2 });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rank-load-more'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('rank-row-p2')).toBeInTheDocument());
    expect(screen.getByTestId('rank-row-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('rank-load-more')).not.toBeInTheDocument();
  });

  it('빈 목록은 empty 상태, 조회 실패는 error 상태를 보여준다', async () => {
    fetchLbPageMock.mockResolvedValue({ entries: [], nextCursor: null, total: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('rank-empty')).toBeInTheDocument());
    cleanup();

    fetchLbPageMock.mockRejectedValue(new Error('down'));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('rank-error')).toBeInTheDocument());
  });
});
