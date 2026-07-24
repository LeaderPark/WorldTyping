// spec: docs/00 §11-D68-②/⑥(GIS ID-token 로그인, 랭킹=로그인 전용·멀티=로그인 필수) + WT-AUTH-03
//
// 전역 로그인 모달. auth 스토어의 loginReason이 세팅되면(어디서든 openLogin(reason)) 열린다.
// AppShell이 라우트 무관 1회만 마운트한다. 공식 GIS renderButton을 지연 로드해 렌더하고, 사용자가
// 구글 계정으로 로그인하면 credential→/auth/google로 계정 세션을 발급받아 스토어에 반영 후 닫는다.
// DEV & VITE_GOOGLE_CLIENT_ID 부재 시 /auth/dev 폴백 버튼을 대신 노출한다.
//
// a11y: role=dialog + aria-modal, useModalA11y(포커스 트랩·배경 inert·트리거 복귀), ESC 닫기.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from '../../lib/hotkeys';
import { useModalA11y } from '../../lib/useModalA11y';
import { useAuthStore } from '../../stores/auth';
import { loadGis } from './gis-loader';
import { useLogin } from './useLogin';

type GisPhase = 'idle' | 'loading' | 'ready' | 'error';

export function LoginModal() {
  const { t } = useTranslation();
  const reason = useAuthStore((s) => s.loginReason);
  const closeLogin = useAuthStore((s) => s.closeLogin);
  const { clientId, devFallback, handleCredential, loginDev } = useLogin();

  const open = reason !== null;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const buttonHostRef = useRef<HTMLDivElement | null>(null);
  const [gisPhase, setGisPhase] = useState<GisPhase>('idle');
  const [submitting, setSubmitting] = useState(false);
  // [§11-D86 F4] 로그인 실패 원인 구분 — 저장소 영속 실패(AuthPersistError)면 저장소 안내 문구로.
  const [errorKind, setErrorKind] = useState<'generic' | 'storage'>('generic');

  useHotkeys(open ? { Escape: closeLogin } : {});
  useModalA11y(dialogRef, open);

  // GIS 지연 로드 + 공식 버튼 렌더(clientId가 있을 때만). 모달이 닫히면 phase를 idle로 되돌린다.
  useEffect(() => {
    if (!open) {
      setGisPhase('idle');
      setSubmitting(false);
      setErrorKind('generic'); // 재오픈 시 저장소 안내가 남지 않게 리셋.
      return;
    }
    if (!clientId) return;

    let cancelled = false;
    setGisPhase('loading');
    loadGis()
      .then((google) => {
        if (cancelled) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp) => {
            setSubmitting(true);
            handleCredential(resp.credential)
              .then(() => {
                if (!cancelled) closeLogin();
              })
              .catch((err: unknown) => {
                if (!cancelled) {
                  setSubmitting(false);
                  setErrorKind(err instanceof Error && err.name === 'AuthPersistError' ? 'storage' : 'generic');
                  setGisPhase('error');
                }
              });
          },
        });
        const host = buttonHostRef.current;
        if (host) {
          host.innerHTML = '';
          google.accounts.id.renderButton(host, {
            type: 'standard',
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'pill',
            width: 240,
          });
        }
        setGisPhase('ready');
      })
      .catch(() => {
        if (!cancelled) setGisPhase('error');
      });

    return () => {
      cancelled = true;
    };
  }, [open, clientId, handleCredential, closeLogin]);

  if (!open) return null;

  const reasonKey = `auth.reason.${reason ?? 'general'}`;

  const runDevLogin = (): void => {
    setSubmitting(true);
    loginDev()
      .then(() => closeLogin())
      .catch((err: unknown) => {
        setSubmitting(false);
        setErrorKind(err instanceof Error && err.name === 'AuthPersistError' ? 'storage' : 'generic');
        setGisPhase('error');
      });
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('auth.modal.title')}
      data-testid="login-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="wt-card w-full max-w-sm p-6 text-center">
        <h2 className="text-lg font-bold">{t('auth.modal.title')}</h2>
        <p data-testid="login-reason" data-reason={reason ?? 'general'} className="mt-2 text-sm text-text-muted">
          {t(reasonKey)}
        </p>

        <div className="mt-5 flex flex-col items-center gap-3">
          {clientId ? (
            <>
              {/* 공식 GIS 버튼이 이 호스트에 렌더된다. */}
              <div ref={buttonHostRef} data-testid="login-gis-host" />
              {gisPhase === 'loading' && <p className="text-sm text-text-muted">{t('auth.modal.title')}…</p>}
              {gisPhase === 'error' && (
                <p role="alert" data-testid="login-error" className="text-sm text-red-700 dark:text-red-400">
                  {t(errorKind === 'storage' ? 'auth.storageError' : 'auth.error')}
                </p>
              )}
            </>
          ) : devFallback ? (
            <button
              type="button"
              data-testid="login-dev"
              className="wt-pill"
              disabled={submitting}
              onClick={runDevLogin}
            >
              {t('auth.devLogin')}
            </button>
          ) : (
            <p role="alert" data-testid="login-error" className="text-sm text-red-700 dark:text-red-400">
              {t('auth.error')}
            </p>
          )}
        </div>

        <button
          type="button"
          data-testid="login-cancel"
          className="mt-5 wt-pill wt-pill--compact"
          disabled={submitting}
          onClick={closeLogin}
        >
          {t('auth.cancel')}
        </button>
      </div>
    </div>
  );
}
