// @vitest-environment jsdom
//
// spec: docs/00 §11-D72(footer 제자리 딤 스크림 모달 + 단일 언어), §11-D76(내 데이터 셀프서비스 UI
// 제거). LegalModal의 a11y 계약(role/aria-modal/aria-label·초기 포커스·닫기 3경로), doc별 구성
// (terms=본문만 / privacy=크레딧), 언어 전환 반영, 라우트 전환 시 자동 닫힘을 검증한다.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { LegalModal } from './LegalModal';
import type { LegalDocId } from './legal-docs';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().setLang('ko');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderModal(doc: LegalDocId, onClose: () => void = vi.fn()) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <LegalModal doc={doc} onClose={onClose} />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('LegalModal (§11-D72)', () => {
  it('role=dialog + aria-modal + 비어있지 않은 aria-label(트리거 라벨 재사용)', () => {
    renderModal('terms');
    const dialog = screen.getByTestId('legal-modal');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.getAttribute('aria-label') ?? '').not.toBe('');
  });

  it('초기 포커스가 닫기 버튼으로 이동한다(useModalA11y)', async () => {
    renderModal('terms');
    await waitFor(() => expect(screen.getByTestId('legal-modal-close')).toHaveFocus());
  });

  it('닫기 버튼 클릭 → onClose', () => {
    const onClose = vi.fn();
    renderModal('terms', onClose);
    act(() => screen.getByTestId('legal-modal-close').click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC → onClose', () => {
    const onClose = vi.fn();
    renderModal('terms', onClose);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('스크림 자기-클릭(바깥 클릭) → onClose (내부 카드 클릭은 무시)', () => {
    const onClose = vi.fn();
    renderModal('terms', onClose);
    // 카드 내부(본문) 클릭은 닫지 않는다.
    act(() => {
      fireEvent.click(screen.getByTestId('legal-modal-body'));
    });
    expect(onClose).not.toHaveBeenCalled();
    // 스크림 요소 자신 클릭(target === currentTarget) → 닫힘.
    act(() => {
      fireEvent.click(screen.getByTestId('legal-modal'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('terms는 본문만(크레딧·데이터 셀프서비스 없음)', () => {
    renderModal('terms');
    expect(screen.getByTestId('terms-body-ko')).toBeInTheDocument();
    expect(screen.queryByTestId('privacy-credits')).not.toBeInTheDocument();
    expect(screen.queryByTestId('privacy-my-data')).not.toBeInTheDocument();
  });

  it('privacy는 본문 + 크레딧 고지(내 데이터 섹션 부재 — §11-D76)', () => {
    renderModal('privacy');
    expect(screen.getByTestId('privacy-body-ko')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-credits')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-credits-link')).toHaveAttribute('href', '/credits');
    expect(screen.queryByTestId('privacy-my-data')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-data-export')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-data-reset')).not.toBeInTheDocument();
  });

  it('settings.lang 전환이 본문 언어에 반영된다(활성 언어 1개만 DOM 존재)', async () => {
    renderModal('support');
    expect(screen.getByTestId('support-body-ko')).toBeInTheDocument();
    expect(screen.queryByTestId('support-body-en')).not.toBeInTheDocument();

    act(() => useSettingsStore.getState().setLang('en'));
    await waitFor(() => expect(screen.getByTestId('support-body-en')).toBeInTheDocument());
    expect(screen.queryByTestId('support-body-ko')).not.toBeInTheDocument();
  });

  it('라우트(pathname) 변경 시 onClose를 호출한다(초회는 스킵)', async () => {
    const onClose = vi.fn();

    function NavHarness() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" data-testid="nav-away" onClick={() => navigate('/credits')}>
            go
          </button>
          <LegalModal doc="privacy" onClose={onClose} />
        </>
      );
    }

    render(
      <AppProviders>
        <MemoryRouter initialEntries={['/privacy']}>
          <NavHarness />
        </MemoryRouter>
      </AppProviders>,
    );

    // 마운트만으로는 닫히지 않는다(초회 스킵).
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByTestId('nav-away'));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
