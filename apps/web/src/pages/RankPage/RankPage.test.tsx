// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S8), docs/06 §1.4(조회 계약), WT-M3-06
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { RankPage } from './index';

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
      <RankPage />
    </AppProviders>,
  );
}

describe('RankPage', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('ko');
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: 'NIMBUS', expiresAt: '' });
    fetchSessionMeMock.mockResolvedValue({ playerId: 'p1', nickname: 'NIMBUS', status: 'active' });
    fetchLbMeMock.mockResolvedValue({ rank: null, total: 0, percentile: null, onBoard: false });
    fetchLbPageMock.mockResolvedValue({ entries: [mkEntry()], nextCursor: null, total: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('마운트 시 기본 필터(전체·세계일주)로 조회한다', async () => {
    renderPage();
    await waitFor(() => expect(fetchLbPageMock).toHaveBeenCalled());
    expect(fetchLbPageMock).toHaveBeenCalledWith('worldtour|ko|desktop|all');
  });

  it('기간/모드/언어/플랫폼 필터를 바꾸면 새 board_key로 재조회한다', async () => {
    renderPage();
    await waitFor(() => expect(fetchLbPageMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('rank-period-daily'));
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toMatch(/^worldtour\|ko\|desktop\|d:\d{4}-\d{2}-\d{2}$/);
    });

    fireEvent.change(screen.getByTestId('rank-filter-mode'), { target: { value: 'tier:3' } });
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toMatch(/^tier:3\|ko\|desktop\|d:/);
    });

    fireEvent.click(screen.getByTestId('rank-lang-en'));
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toMatch(/^tier:3\|en\|desktop\|d:/);
    });

    fireEvent.click(screen.getByTestId('rank-platform-mobile'));
    await waitFor(() => {
      const lastCall = fetchLbPageMock.mock.calls.at(-1) as [string, unknown];
      expect(lastCall[0]).toMatch(/^tier:3\|en\|mobile\|d:/);
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

  it('내 행이 페이지 밖이면 /lb/me 요약을 고정 표시한다', async () => {
    fetchLbPageMock.mockResolvedValue({ entries: [mkEntry({ userId: 'other' })], nextCursor: null, total: 2000 });
    fetchLbMeMock.mockResolvedValue({ rank: 841, total: 2000, percentile: 0.42, onBoard: true });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('rank-my-row-pinned')).toBeInTheDocument());
    expect(screen.getByTestId('rank-my-row-pinned').textContent).toContain('841');
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

  it('"내 지역" 스코프 탭은 v1에서 비활성 스텁이다(세션 응답에 geo 없음)', async () => {
    renderPage();
    await waitFor(() => expect(fetchLbPageMock).toHaveBeenCalled());
    expect(screen.getByTestId('rank-scope-mine')).toBeDisabled();
  });
});
