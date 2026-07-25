// spec: docs/00 §11-D68-②/⑥(GIS ID-token 로그인, 랭킹=로그인 전용·멀티=로그인 필수) + WT-AUTH-03
//
// 전역 로그인 모달. auth 스토어의 loginReason이 세팅되면(어디서든 openLogin(reason)) 열린다.
// AppShell이 라우트 무관 1회만 마운트한다. 공식 GIS renderButton을 지연 로드해 렌더한다.
// DEV & VITE_GOOGLE_CLIENT_ID 부재 시 /auth/dev 폴백 버튼을 대신 노출한다.
//
// [WT-AUTH-REDIRECT] 기본 로그인 방식 = GIS `ux_mode:'redirect'`(전체 페이지 이동). 버튼을 누르면
// 브라우저가 Google로 갔다가 서버 POST /api/v1/auth/google/redirect로 폼 POST되고, 서버가
// `/?authcode=…`로 302를 돌려주면 features/auth/authcode-boot가 부팅 시 그 코드를 계정 세션으로
// 교환한다. 즉 이 컴포넌트는 credential을 JS로 받지 않는다 — 팝업 COOP 차단·FedCM 엠바고로 일부
// 크롬에서 자격증명 자체가 생성되지 않던 라이브 장애의 유일한 구조적 해법이라 D101의
// use_fedcm_for_prompt/button 대신 이 경로를 채택했다(그 옵션들은 redirect 모드에서 무의미).
// `callback`은 GIS 타입상 필수 필드라 남겨 두지만 redirect 모드에서는 호출되지 않는다.
//
// a11y: role=dialog + aria-modal, useModalA11y(포커스 트랩·배경 inert·트리거 복귀), ESC 닫기.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from '../../lib/hotkeys';
import { useModalA11y } from '../../lib/useModalA11y';
import { useAuthStore } from '../../stores/auth';
import { GOOGLE_REDIRECT_LOGIN_PATH, rememberLoginReturnTo, takeAuthRedirectError } from './authcode-boot';
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
  // [WT-AUTH-REDIRECT] `/?authError=1`로 되돌아온 실패. gisPhase와 독립이다 — GIS 로드/렌더는
  // 정상적으로 이어져야 하고(사용자가 곧바로 재시도), 그 phase 전이가 안내 문구를 지우면 안 된다.
  const [redirectError, setRedirectError] = useState(false);

  useHotkeys(open ? { Escape: closeLogin } : {});
  useModalA11y(dialogRef, open);

  // GIS 지연 로드 + 공식 버튼 렌더(clientId가 있을 때만). 모달이 닫히면 phase를 idle로 되돌린다.
  useEffect(() => {
    if (!open) {
      setGisPhase('idle');
      setSubmitting(false);
      setErrorKind('generic'); // 재오픈 시 저장소 안내가 남지 않게 리셋.
      setRedirectError(false);
      return;
    }
    // 부팅 시 `/?authError=1`을 소비한 경우(authcode-boot이 이 모달을 열었다) 안내 문구를 세운다.
    // 함수형 갱신으로 "한 번 켜지면 닫힐 때까지 유지" — StrictMode 이펙트 이중 실행에서 두 번째
    // take()가 false를 돌려줘 문구가 사라지는 것을 막는다(닫힘 분기에서만 false로 리셋).
    setRedirectError((prev) => prev || takeAuthRedirectError());
    // redirect 로그인은 전체 페이지 이동이라 서버가 항상 `/`로 되돌려 준다 — 지금 있는 화면을
    // 기억해 두면 authcode-boot이 부팅 시 그 경로로 복원한다(저장 실패는 홈 착지로 폴백).
    rememberLoginReturnTo();
    if (!clientId) return;

    let cancelled = false;
    setGisPhase('loading');
    loadGis()
      .then((google) => {
        if (cancelled) return;
        google.accounts.id.initialize({
          client_id: clientId,
          // [WT-AUTH-REDIRECT] 전체 페이지 이동 경로 — 팝업/COOP/FedCM/엠바고와 전부 무관하다.
          // login_uri는 절대 URI여야 하고(GIS 규약) 오리진 하드코딩은 금지라(§7 gotcha 7) 현재
          // 페이지 오리진에서 조립한다. Google Cloud Console "승인된 리디렉션 URI"에 등록 필수.
          ux_mode: 'redirect',
          login_uri: `${window.location.origin}${GOOGLE_REDIRECT_LOGIN_PATH}`,
          itp_support: true,
          // redirect 모드에서는 호출되지 않는다(GIS 타입상 필수라 안전망으로만 유지).
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
              {(gisPhase === 'error' || redirectError) && (
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
