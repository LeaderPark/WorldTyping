// @vitest-environment jsdom
//
// spec: docs/06 §6.5(11항 아웃라인 + ko/en 병기), WT-M6-01 [완료 조건] "privacy 페이지가 ko/en
// 병기로 렌더, 11항 전부 존재".
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { PrivacyPage } from './index';

// [WT-AUTH-03] 데이터 열람/삭제 셀프서비스(구 S12 설정 오버레이에서 이전, docs/06 §6.3). api-client의
// export/delete 두 함수만 목킹하고 나머지는 실제 모듈을 보존한다.
const fetchMyDataExportMock = vi.fn();
const deleteMyAccountMock = vi.fn();
vi.mock('../../net/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../net/api-client')>('../../net/api-client');
  return {
    ...actual,
    fetchMyDataExport: (...args: unknown[]) => fetchMyDataExportMock(...args),
    deleteMyAccount: (...args: unknown[]) => deleteMyAccountMock(...args),
  };
});

const downloadJsonMock = vi.fn();
vi.mock('../../lib/download-json', () => ({
  downloadJson: (...args: unknown[]) => downloadJsonMock(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderPage() {
  return render(
    <AppProviders>
      {/* WT-M6-06: 크레딧 섹션이 <Link to="/credits">를 렌더하므로 Router 컨텍스트가 필요하다. */}
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('PrivacyPage', () => {
  it('renders an h1 (tabIndex=-1 for route-focus, docs/03 §7.3) with non-empty text', () => {
    renderPage();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.textContent).not.toBe('');
  });

  it('renders both the Korean and English bodies side by side (§6.5 "ko/en 병기")', () => {
    renderPage();
    expect(screen.getByTestId('privacy-body-ko')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-en')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-body-ko').textContent).toContain('개인정보처리방침');
    expect(screen.getByTestId('privacy-body-en').textContent).toContain('Privacy Policy');
  });

  it('contains all 11 outline sections in Korean and English, as actual headings (§6.5 numbering)', () => {
    renderPage();
    const koHeadings = within(screen.getByTestId('privacy-body-ko'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    const enHeadings = within(screen.getByTestId('privacy-body-en'))
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '');
    for (let n = 1; n <= 11; n += 1) {
      const prefix = `${n}. `;
      expect(koHeadings.some((h) => h.startsWith(prefix)), `ko section ${n} heading missing (got: ${JSON.stringify(koHeadings)})`).toBe(true);
      expect(enHeadings.some((h) => h.startsWith(prefix)), `en section ${n} heading missing (got: ${JSON.stringify(enHeadings)})`).toBe(true);
    }
    // 계정/이메일/실명 미수집 원칙이 실문안에 선명하게 등장하는지(§6.5 항목 2 지시).
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('수집하지 않습니다');
    expect(en).toContain('never collect');
  });

  it('leaves the operator/contact placeholders for the lead to fill in (§3 세션 조정 지시)', () => {
    renderPage();
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('{PLACEHOLDER');
    expect(en).toContain('{PLACEHOLDER');
  });

  it('renders the addendum version-history table (§6.5 "부칙: 변경 이력 표")', () => {
    renderPage();
    expect(screen.getByTestId('privacy-body-ko').textContent).toContain('v1.0');
    // 보유기간(§4)·변경이력(부칙) 두 개씩(ko/en) — 파이프 테이블이 실제로 <table>로 렌더되는지만 확인.
    expect(within(screen.getByTestId('privacy-body-ko')).getAllByRole('table').length).toBeGreaterThanOrEqual(2);
    expect(within(screen.getByTestId('privacy-body-en')).getAllByRole('table').length).toBeGreaterThanOrEqual(2);
  });

  it('renders the credits section with notice.disputed and ODbL/Natural Earth/flag-icons notices', () => {
    renderPage();
    const credits = screen.getByTestId('privacy-credits');
    expect(credits.textContent).toContain('ODbL');
    expect(credits.textContent).toContain('Natural Earth');
    expect(credits.textContent).toContain('flag-icons');
    expect(credits.textContent).toMatch(/정치적 입장을 나타내지 않습니다|do not reflect any political position/);
  });

  it('links to the full /credits page (WT-M6-06)', () => {
    renderPage();
    expect(screen.getByTestId('privacy-credits-link')).toHaveAttribute('href', '/credits');
  });

  it('describes the self-service export/delete rights in both languages (§6.3)', () => {
    renderPage();
    const ko = screen.getByTestId('privacy-body-ko').textContent ?? '';
    const en = screen.getByTestId('privacy-body-en').textContent ?? '';
    expect(ko).toContain('내 데이터 내려받기');
    expect(ko).toContain('데이터 초기화 및 삭제');
    expect(en).toContain('Download my data');
    expect(en).toContain('Reset and delete my data');
  });
});

// 구 AppShell SettingsOverlay(WT-M6-01)에서 이전된 열람/삭제권 셀프서비스 UI(§11-D68-⑥).
describe('PrivacyPage — 내 데이터 셀프서비스 (WT-AUTH-03)', () => {
  it('열람/삭제 버튼(내 데이터 섹션)을 렌더한다', () => {
    renderPage();
    expect(screen.getByTestId('privacy-my-data')).toBeInTheDocument();
    expect(screen.getByTestId('settings-data-export')).toBeInTheDocument();
    expect(screen.getByTestId('settings-data-reset')).toBeInTheDocument();
  });

  it('"내 데이터 내려받기" 클릭 시 export를 가져와 JSON 다운로드를 트리거한다', async () => {
    const exported = { user: { userId: 'p1' }, runs: [], unlocks: [] };
    fetchMyDataExportMock.mockResolvedValueOnce(exported);
    renderPage();

    await act(async () => {
      screen.getByTestId('settings-data-export').click();
    });

    await waitFor(() => expect(fetchMyDataExportMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(downloadJsonMock).toHaveBeenCalledTimes(1));
    expect(downloadJsonMock.mock.calls[0]?.[1]).toEqual(exported);
  });

  it('삭제는 2단계 확인을 요구한다(취소 시 idle로 복귀)', async () => {
    renderPage();
    act(() => screen.getByTestId('settings-data-reset').click());

    expect(await screen.findByTestId('settings-data-reset-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('settings-data-reset-cancel')).toBeInTheDocument();
    expect(deleteMyAccountMock).not.toHaveBeenCalled();

    act(() => screen.getByTestId('settings-data-reset-cancel').click());
    await waitFor(() => expect(screen.queryByTestId('settings-data-reset-confirm')).not.toBeInTheDocument());
    expect(screen.getByTestId('settings-data-reset')).toBeInTheDocument();
  });

  it('삭제 확정 시 DELETE /users/me 호출 + 완료 메시지 + localStorage 비움', async () => {
    deleteMyAccountMock.mockResolvedValueOnce({ ok: true, deletedAt: Date.now(), cacheMaxDelaySec: 600 });
    localStorage.setItem('wt:sessiontoken', 'some-token');
    localStorage.setItem('wt:did', 'some-device-id');
    renderPage();

    act(() => screen.getByTestId('settings-data-reset').click());
    const confirmBtn = await screen.findByTestId('settings-data-reset-confirm');
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => expect(deleteMyAccountMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('settings-data-reset-done')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.length).toBe(0));
  });

  it('삭제 실패 시 에러 메시지를 표시하고 localStorage를 비우지 않는다', async () => {
    deleteMyAccountMock.mockRejectedValueOnce(new Error('network down'));
    localStorage.setItem('wt:sessiontoken', 'some-token');
    renderPage();

    act(() => screen.getByTestId('settings-data-reset').click());
    const confirmBtn = await screen.findByTestId('settings-data-reset-confirm');
    await act(async () => {
      confirmBtn.click();
    });

    expect(await screen.findByTestId('settings-data-error')).toBeInTheDocument();
    expect(localStorage.getItem('wt:sessiontoken')).toBe('some-token');
  });
});
