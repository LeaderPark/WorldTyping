// spec: docs/03 §8.3(캡처 dynamic import), docs/06 §9.1(공유 UTM 부착·모바일 Web Share·데스크톱
//       클립보드+다운로드+X/Threads 인텐트), docs/07 WT-M5-04 [산출물·구현 세부 지시 1]
//
// [M5-04 스코프 메모] docs/06 §9.1의 IG "카드 이미지를 캔버스로 재렌더해 이미지 저장" 항목은
// OG 카드 레이아웃(satori/resvg, M6-02)과 동일 레이아웃 공유 컴포넌트를 전제로 하는데 이
// 태스크 산출물 목록(§구현 세부 지시 1)에는 없다 — v1은 모바일 Web Share + 데스크톱
// 클립보드/다운로드/X·Threads 인텐트만 구현한다(최종 보고 escalations 참조).
//
// shareId(서버 발급 공유 랜딩 /r/:shareId)는 M6-02 소관이라 아직 없다 — 이 작업의 세션 환경
// 조정(§3-2 "shareId는 홈 URL 폴백")에 따라 공유 URL은 항상 홈("/") + utm으로 폴백한다.
import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { captureResultCardPng } from './capture';
import { trackShareClick } from '../../net/telemetry';

export type ShareUtmSource = 'x' | 'threads' | 'ig' | 'copy';

/** §9.1 "모든 공유 URL에 utm_source={x|threads|ig|copy}&utm_medium=share&utm_campaign=result
 *  자동 부착". shareId 폴백이라 pathname은 항상 홈("/")이다(M6-02 이전). */
export function buildShareUrl(utmSource: ShareUtmSource): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const search = `?utm_source=${utmSource}&utm_medium=share&utm_campaign=result`;
  return origin ? `${origin}/${search}` : `/${search}`;
}

export interface ShareCardProps {
  /** 캡처 대상 DOM 노드(ResultView가 ResultCard를 감싼 wrapper). */
  cardRef: RefObject<HTMLElement>;
  platform: 'desktop' | 'mobile';
  /** Web Share/X·Threads 인텐트에 실을 텍스트(ResultView가 route/grade/score로 조립). */
  shareTitle: string;
}

type ShareStatus = 'idle' | 'busy' | 'copied' | 'shared' | 'error';

const FILE_NAME = 'worldtyping-result.png';

export function ShareCard({ cardRef, platform, shareTitle }: ShareCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ShareStatus>('idle');

  const capture = useCallback(async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    setStatus('busy');
    try {
      return await captureResultCardPng(cardRef.current);
    } catch (err) {
      console.warn('[ShareCard] 캡처 실패:', err);
      setStatus('error');
      return null;
    }
  }, [cardRef]);

  const shareMobile = useCallback(async () => {
    const blob = await capture();
    if (!blob) return;
    const url = buildShareUrl('copy');
    try {
      const nav = navigator as Navigator & { canShare?(data?: ShareData): boolean };
      const file = new File([blob], FILE_NAME, { type: blob.type || 'image/png' });
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: shareTitle, text: shareTitle, url });
        setStatus('shared');
        trackShareClick({ utmSource: 'copy' });
        return;
      }
      if (nav.share) {
        // 파일 첨부 미지원 브라우저 — 링크 공유만이라도 제공.
        await nav.share({ title: shareTitle, text: shareTitle, url });
        setStatus('shared');
        trackShareClick({ utmSource: 'copy' });
        return;
      }
      setStatus('idle');
    } catch (err) {
      // 사용자가 공유 시트를 취소한 경우(AbortError)는 실패가 아니다.
      if ((err as { name?: string } | null)?.name !== 'AbortError') setStatus('error');
      else setStatus('idle');
    }
  }, [capture, shareTitle]);

  const copyAndDownload = useCallback(async () => {
    const blob = await capture();
    if (!blob) return;
    try {
      const ClipboardItemCtor = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (navigator.clipboard?.write && ClipboardItemCtor) {
        await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type || 'image/png']: blob })]);
      }
    } catch {
      // 클립보드 미지원/권한 거부 — 아래 다운로드는 계속 제공하므로 조용히 무시(WaitingRoom
      // copyInvite와 동일한 실패 관용 패턴).
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = FILE_NAME;
    a.click();
    URL.revokeObjectURL(href);
    setStatus('copied');
    trackShareClick({ utmSource: 'copy' });
  }, [capture]);

  if (platform === 'mobile') {
    return (
      <button
        type="button"
        data-testid="result-share"
        className="wt-btn"
        disabled={status === 'busy'}
        onClick={() => void shareMobile()}
      >
        {t('result.action.share')}
      </button>
    );
  }

  return (
    <div className="wt-share-card" data-testid="share-card-desktop">
      <button
        type="button"
        data-testid="result-share"
        className="wt-btn"
        disabled={status === 'busy'}
        onClick={() => void copyAndDownload()}
      >
        {t('result.action.share')}
      </button>
      {status === 'copied' && (
        <p role="status" data-testid="share-card-status">
          {t('result.share.copied')}
        </p>
      )}
      {status === 'error' && (
        <p role="alert" data-testid="share-card-error">
          {t('result.share.error')}
        </p>
      )}
    </div>
  );
}
