// @vitest-environment jsdom
//
// spec: docs/06 §9.1(모바일 Web Share / 데스크톱 클립보드+다운로드+X·Threads 인텐트·utm 부착),
// WT-M5-04
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { ShareCard, buildShareUrl } from './ShareCard';

const captureMock = vi.fn();
vi.mock('./capture', () => ({
  captureResultCardPng: (...args: unknown[]) => captureMock(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderShareCard(platform: 'desktop' | 'mobile') {
  const node = document.createElement('div');
  const cardRef = { current: node };
  return render(
    <AppProviders>
      <ShareCard cardRef={cardRef} platform={platform} shareTitle="테스트 공유 텍스트" />
    </AppProviders>,
  );
}

describe('buildShareUrl', () => {
  it('utm_source/medium/campaign을 부착한 홈 URL을 만든다(shareId 폴백, M6-02 이전)', () => {
    const url = buildShareUrl('x');
    expect(url).toContain('utm_source=x');
    expect(url).toContain('utm_medium=share');
    expect(url).toContain('utm_campaign=result');
  });
});

describe('ShareCard — 모바일', () => {
  it('Web Share API(파일 첨부) 지원 시 캡처 후 navigator.share를 호출한다', async () => {
    captureMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { ...navigator, share: shareMock, canShare: canShareMock });

    renderShareCard('mobile');
    await act(async () => {
      fireEvent.click(screen.getByTestId('result-share'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captureMock).toHaveBeenCalledOnce();
    expect(shareMock).toHaveBeenCalledOnce();
    const arg = shareMock.mock.calls[0]?.[0] as { files: File[] };
    expect(arg.files[0]?.name).toBe('worldtyping-result.png');
  });

  it('캡처 실패 시 navigator.share를 호출하지 않는다', async () => {
    captureMock.mockRejectedValue(new Error('capture failed'));
    const shareMock = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, share: shareMock, canShare: () => true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderShareCard('mobile');
    await act(async () => {
      fireEvent.click(screen.getByTestId('result-share'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(shareMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('ShareCard — 데스크톱', () => {
  it('클립보드 write + 다운로드 링크를 트리거하고 상태 메시지를 보여준다', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    captureMock.mockResolvedValue(blob);
    const writeMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write: writeMock } });
    vi.stubGlobal('ClipboardItem', class {
      constructor(public items: Record<string, Blob>) {}
    } as unknown as typeof ClipboardItem);
    const createObjectURLMock = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURLMock = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock });

    renderShareCard('desktop');
    await act(async () => {
      fireEvent.click(screen.getByTestId('result-share'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeMock).toHaveBeenCalledOnce();
    expect(createObjectURLMock).toHaveBeenCalledWith(blob);
    expect(screen.getByTestId('share-card-status')).toBeInTheDocument();
  });

  it('클립보드 미지원이어도 다운로드는 계속 진행되고 조용히 무시한다', async () => {
    captureMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:fake'), revokeObjectURL: vi.fn() });

    renderShareCard('desktop');
    await act(async () => {
      fireEvent.click(screen.getByTestId('result-share'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('share-card-status')).toBeInTheDocument();
  });
});
