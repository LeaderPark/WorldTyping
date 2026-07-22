// @vitest-environment jsdom
//
// spec: docs/01 §10.1(S13)·§10.2(여권 펼침 뷰), docs/06 §4.3, WT-M5-03
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { PassportPage } from './index';
import type { PassportRes } from '../../net/api-client';

const ensureSessionMock = vi.fn();
const fetchSessionMeMock = vi.fn();
const fetchPassportMock = vi.fn();
const putPassportCoverMock = vi.fn();

vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return {
    ...actual,
    ensureSession: (...args: unknown[]) => ensureSessionMock(...args),
    fetchSessionMe: (...args: unknown[]) => fetchSessionMeMock(...args),
    fetchPassport: (...args: unknown[]) => fetchPassportMock(...args),
    putPassportCover: (...args: unknown[]) => putPassportCoverMock(...args),
  };
});

function basePassport(overrides: Partial<PassportRes> = {}): PassportRes {
  return {
    userId: 'p1',
    nickname: 'NIMBUS',
    passportCover: 'basic-green',
    streakDaily: 3,
    bestPi: 402,
    unlocks: [
      { type: 'achievement', id: 'ach:first_flight', meta: null, createdAt: 1 },
      { type: 'stamp', id: 'stamp:continent:asia:A', meta: null, createdAt: 1 },
      { type: 'cover', id: 'cover:continent-asia', meta: null, createdAt: 1 },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <AppProviders>
      <PassportPage />
    </AppProviders>,
  );
}

describe('PassportPage', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('ko');
    ensureSessionMock.mockResolvedValue({ token: 't', playerId: 'p1', nickname: 'NIMBUS', expiresAt: '', geo: 'KR' });
    fetchSessionMeMock.mockResolvedValue({ playerId: 'p1', nickname: 'NIMBUS', status: 'active', geo: 'KR' });
    fetchPassportMock.mockResolvedValue(basePassport());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('로딩 중에도 h1은 즉시 렌더된다', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('여권');
  });

  it('로드 후 닉네임/스트릭/최고 PI/스탬프/업적을 표시한다', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('passport-nickname').textContent).toBe('NIMBUS'));
    expect(screen.getByTestId('passport-streak').textContent).toContain('3');
    expect(screen.getByTestId('passport-best-pi').textContent).toContain('402');

    // 획득한 stamp:continent:asia만 owned 클래스가 붙는다.
    expect(screen.getByTestId('passport-stamp-continent:asia').className).toContain('--owned');
    expect(screen.getByTestId('passport-stamp-continent:europe').className).not.toContain('--owned');
    expect(screen.getByTestId('passport-stamp-worldtour').className).not.toContain('--owned');

    expect(screen.getByTestId('passport-achievement-ach:first_flight')).toBeInTheDocument();
    expect(screen.getByTestId('passport-achievements-count').textContent).toContain('1/24');
  });

  it('조회 실패는 error 상태를 보여준다', async () => {
    fetchPassportMock.mockRejectedValue(new Error('down'));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('passport-error')).toBeInTheDocument());
  });

  it('미획득 커버는 비활성, 기본/획득분은 선택 가능하다(§9.4 "커버 선택은 획득분만")', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('passport-cover-basic-green')).toBeInTheDocument());

    expect(screen.getByTestId('passport-cover-basic-green')).not.toBeDisabled();
    expect(screen.getByTestId('passport-cover-continent-asia')).not.toBeDisabled(); // 획득분
    expect(screen.getByTestId('passport-cover-gold')).toBeDisabled(); // 미획득
  });

  it('획득한 커버를 선택하면 서버에 반영하고 현재 커버 표시가 바뀐다', async () => {
    putPassportCoverMock.mockResolvedValue({ passportCover: 'continent-asia' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('passport-cover-continent-asia')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('passport-cover-continent-asia'));
      await Promise.resolve();
    });

    await waitFor(() => expect(putPassportCoverMock).toHaveBeenCalledWith('continent-asia'));
    await waitFor(() =>
      expect(screen.getByTestId('passport-cover-continent-asia').textContent).toBe('사용 중'),
    );
  });
});
