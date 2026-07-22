// @vitest-environment jsdom
//
// spec: docs/06 §6.3(열람/삭제권 셀프서비스 — "내 데이터 내려받기"/"데이터 초기화 및 삭제" 2단계
// 확인 + localStorage 삭제), WT-M6-01 [산출물] "수정: 설정 오버레이".
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';

const fetchMyDataExportMock = vi.fn();
const deleteMyAccountMock = vi.fn();

vi.mock('../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../net/api-client')>('../net/api-client');
  return {
    ...actual,
    fetchMyDataExport: (...args: unknown[]) => fetchMyDataExportMock(...args),
    deleteMyAccount: (...args: unknown[]) => deleteMyAccountMock(...args),
  };
});

const downloadJsonMock = vi.fn();
vi.mock('../lib/download-json', () => ({
  downloadJson: (...args: unknown[]) => downloadJsonMock(...args),
}));

function renderSettings() {
  localStorage.setItem('wt:lang', 'en'); // 언어 게이트가 다른 시나리오를 방해하지 않도록.
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/?modal=settings']}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('AppShell SettingsOverlay — privacy self-service (WT-M6-01)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the export and reset buttons', async () => {
    renderSettings();
    expect(await screen.findByTestId('settings-data-export')).toBeInTheDocument();
    expect(screen.getByTestId('settings-data-reset')).toBeInTheDocument();
  });

  it('clicking "download my data" fetches the export and triggers a JSON download', async () => {
    const exported = { user: { userId: 'p1' }, runs: [], unlocks: [] };
    fetchMyDataExportMock.mockResolvedValueOnce(exported);
    renderSettings();

    const exportBtn = await screen.findByTestId('settings-data-export');
    await act(async () => {
      exportBtn.click();
    });

    await waitFor(() => expect(fetchMyDataExportMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(downloadJsonMock).toHaveBeenCalledTimes(1));
    expect(downloadJsonMock.mock.calls[0]?.[1]).toEqual(exported);
  });

  it('requires a two-step confirmation before deleting (cancel returns to idle)', async () => {
    renderSettings();
    const resetBtn = await screen.findByTestId('settings-data-reset');
    act(() => resetBtn.click());

    expect(await screen.findByTestId('settings-data-reset-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('settings-data-reset-cancel')).toBeInTheDocument();
    expect(deleteMyAccountMock).not.toHaveBeenCalled();

    act(() => screen.getByTestId('settings-data-reset-cancel').click());
    await waitFor(() => expect(screen.queryByTestId('settings-data-reset-confirm')).not.toBeInTheDocument());
    expect(await screen.findByTestId('settings-data-reset')).toBeInTheDocument();
  });

  it('confirming deletion calls DELETE /users/me, shows the done message, and clears localStorage', async () => {
    deleteMyAccountMock.mockResolvedValueOnce({ ok: true, deletedAt: Date.now(), cacheMaxDelaySec: 600 });
    localStorage.setItem('wt:sessiontoken', 'some-token');
    localStorage.setItem('wt:did', 'some-device-id');
    renderSettings(); // 위 두 키 설정 후 렌더 — renderSettings 자체도 wt:lang을 심어 셋 중 하나가 된다.

    const resetBtn = await screen.findByTestId('settings-data-reset');
    act(() => resetBtn.click());
    const confirmBtn = await screen.findByTestId('settings-data-reset-confirm');
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => expect(deleteMyAccountMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('settings-data-reset-done')).toBeInTheDocument();
    // §6.3 "+ localStorage 삭제" — 삭제 성공 즉시 로컬 신원/설정을 전부 비운다.
    await waitFor(() => expect(localStorage.length).toBe(0));
  });

  it('shows an error message if the delete request fails, without clearing localStorage', async () => {
    deleteMyAccountMock.mockRejectedValueOnce(new Error('network down'));
    localStorage.setItem('wt:sessiontoken', 'some-token');
    renderSettings();

    const resetBtn = await screen.findByTestId('settings-data-reset');
    act(() => resetBtn.click());
    const confirmBtn = await screen.findByTestId('settings-data-reset-confirm');
    await act(async () => {
      confirmBtn.click();
    });

    expect(await screen.findByTestId('settings-data-error')).toBeInTheDocument();
    expect(localStorage.getItem('wt:sessiontoken')).toBe('some-token');
  });
});
