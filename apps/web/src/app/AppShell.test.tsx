// @vitest-environment jsdom
//
// spec: docs/06 §6.3(열람/삭제권 셀프서비스 — "내 데이터 내려받기"/"데이터 초기화 및 삭제" 2단계
// 확인 + localStorage 삭제), WT-M6-01 [산출물] "수정: 설정 오버레이".
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';
import { useSettingsStore } from '../stores/settings';

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

describe('AppShell SettingsOverlay — 사운드/연출 토글 + 정치중립 고지 (WT-DC-06)', () => {
  beforeEach(() => {
    // 기존 스토어 필드만 배선(신규 필드 없음) — 매 테스트를 알려진 베이스라인에서 시작한다.
    // lang을 명시적으로 고정(PassportPage.test.tsx와 동일 관례) — i18next 활성 언어는
    // settings.lang 단방향 동기화(providers.tsx)를 따르지 renderSettings()의 'wt:lang' 게이트
    // localStorage 키와는 무관하다.
    useSettingsStore.getState().setLang('ko');
    useSettingsStore.setState({
      keySound: 'off',
      volume: { master: 0.8, sfx: 0.8, bgm: 0.5 },
      reducedMotion: 'auto',
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('기본 상태: keySound="off"→사운드 OFF, reducedMotion="auto"는 jsdom에 matchMedia가 없어 false로 해석되어 연출 ON', async () => {
    renderSettings();

    const soundBtn = await screen.findByTestId('settings-sound-toggle');
    expect(soundBtn.textContent).toBe('OFF');
    expect(soundBtn).toHaveAttribute('aria-pressed', 'false');

    const motionBtn = screen.getByTestId('settings-motion-toggle');
    expect(motionBtn.textContent).toBe('ON');
    expect(motionBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('사운드 토글: 클릭 시 keySound와 volume.master를 함께 반영한다(§WT-DC-06 ③ "사운드=keySound+volume")', async () => {
    renderSettings();
    const soundBtn = await screen.findByTestId('settings-sound-toggle');

    act(() => soundBtn.click());
    expect(useSettingsStore.getState().keySound).toBe('mech');
    expect(useSettingsStore.getState().volume.master).toBe(0.8);
    expect(soundBtn.textContent).toBe('ON');
    expect(soundBtn).toHaveAttribute('aria-pressed', 'true');

    act(() => soundBtn.click());
    expect(useSettingsStore.getState().keySound).toBe('off');
    expect(useSettingsStore.getState().volume.master).toBe(0);
    expect(soundBtn.textContent).toBe('OFF');
  });

  it('연출(모션) 토글: reducedMotion을 명시적 boolean으로 확정하고 html[data-reduced]에 실반영된다(에스컬레이션 매핑 — 최종 보고 참조)', async () => {
    renderSettings();
    const motionBtn = await screen.findByTestId('settings-motion-toggle');
    expect(document.documentElement).not.toHaveAttribute('data-reduced');

    act(() => motionBtn.click());
    expect(useSettingsStore.getState().reducedMotion).toBe(true);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-reduced'));
    expect(motionBtn.textContent).toBe('OFF');
    expect(motionBtn).toHaveAttribute('aria-pressed', 'false');

    act(() => motionBtn.click());
    expect(useSettingsStore.getState().reducedMotion).toBe(false);
    await waitFor(() => expect(document.documentElement).not.toHaveAttribute('data-reduced'));
    expect(motionBtn.textContent).toBe('ON');
  });

  it('모달 하단에 정치중립 고지(기존 키 notice.disputed)를 표시한다(§WT-DC-06 ④)', async () => {
    renderSettings();
    expect(await screen.findByText('국가 표기는 게임 목적의 편의상 구분이며 정치적 입장을 나타내지 않습니다.')).toBeInTheDocument();
  });
});
