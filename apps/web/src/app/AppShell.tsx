// spec: docs/03 §4.2(AppShell 역할 — 테마 클래스/전역 토스트/설정 오버레이/Outlet),
//       §7.3(접근성 — 모달 ESC/focus), §8.1(테마 data-theme 속성), §8.4(PWA 업데이트 UX —
//       "인게임 중에는 토스트 유예"), docs/06 §6.3(열람/삭제권 셀프서비스 UI), WT-M2-05,
//       WT-M5-01, WT-M6-01
//
// M0 스캐폴드("Hello WORLD TYPING" 한 줄)를 라우팅 루트 레이아웃으로 교체한다.

import { Link, Outlet, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useSettingsStore } from '../stores/settings';
import { useSessionStore } from '../stores/session';
import { useHotkeys } from '../lib/hotkeys';
import { useRouteFocus } from '../lib/useRouteFocus';
import { useModalA11y } from '../lib/useModalA11y';
import { deleteMyAccount, fetchMyDataExport } from '../net/api-client';
import { downloadJson } from '../lib/download-json';
import { getBootData, type BannerConfig } from './bootLoader';
import { RouteMeta } from './RouteMeta';

export function AppShell() {
  const theme = useSettingsStore((s) => s.theme);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const highContrast = useSettingsStore((s) => s.highContrast);
  const fontScale = useSettingsStore((s) => s.fontScale);

  // 라우트 전환 시 새 화면의 h1으로 포커스 이동(§7.3) — AppShell은 Outlet을 감싸는 루트라
  // 라우트가 바뀌어도 그 자신은 리마운트되지 않는다(useRouteFocus.ts 주석 참조).
  useRouteFocus();

  // 테마: <html data-theme> 갱신 + FOUC 스니펫이 다음 로드에 읽을 원시 키 동기화(§8.1).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const reduced =
      reducedMotion === 'auto'
        ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        : reducedMotion;
    document.documentElement.toggleAttribute('data-reduced', Boolean(reduced));
  }, [reducedMotion]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-contrast', highContrast);
  }, [highContrast]);

  // fontScale 0/1/2 → 프롬프트 clamp 배수 ×1/×1.25/×1.5(§7.3, globals.css의
  // [data-font-scale] 셀렉터가 이 값을 읽는다).
  useEffect(() => {
    document.documentElement.setAttribute('data-font-scale', String(fontScale));
  }, [fontScale]);

  return (
    // WT-UI-01(D57): bg-white/dark:bg-slate-900 하드코딩 → --bg/--text 시맨틱 토큰(tailwind.config.ts
    // var() 매핑). 토큰 자체가 [data-theme='dark']에서 반전되므로 dark: 변형이 더 이상 필요 없다.
    <div className="min-h-screen bg-bg text-text">
      {/* WT-M6-06: 라우트별 SEO 메타(title/description/OG/Twitter/hreflang) — 시각 출력 없음. */}
      <RouteMeta />
      {/* WT-M6-06: KV config:banner 장애 배너(docs/06 §10-4). */}
      <BannerBar />
      {/* 전역 토스트 영역 — 토스트 스토어/디스패처는 이 태스크 범위 밖(스토어 5종 고정, §4.3). */}
      <div id="wt-toast-region" aria-live="polite" className="sr-only" />
      <Outlet />
      <SettingsOverlay />
      <SwUpdateToast />
    </div>
  );
}

/**
 * WT-M6-06: KV config:banner(운영자 장애 공지, docs/06 §10-4 "API 장애 시 배너 동작 확인" +
 * §11-D9 D1/DO=canonical과 별개인 운영 핫스왑 채널). `getBootData()`는 데이터 라우터의 root
 * loader(bootLoader)가 이미 resolve된 뒤에만 안전하다 — 이 컴포넌트를 AppShell 없이 classic
 * <MemoryRouter>로 직접 렌더하는 기존 테스트(router.test.tsx 등)에서는 loader가 전혀 실행되지
 * 않으므로, effect 안에서 try/catch로 감싸 "배너 없음"으로 조용히 폴백한다(장애 배너는 부가
 * 기능이라 크래시 사유가 아니다 — HomePage의 데일리/티커 조회 실패 폴백과 같은 정신).
 */
function BannerBar() {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<BannerConfig | null>(null);

  useEffect(() => {
    try {
      setBanner(getBootData().config.banner ?? null);
    } catch {
      setBanner(null);
    }
  }, []);

  if (!banner) return null;

  return (
    <div
      role="status"
      data-testid="app-banner"
      data-level={banner.level}
      aria-label={t('banner.ariaLabel')}
      className={`px-4 py-2 text-center text-sm font-medium text-white ${
        banner.level === 'warning' ? 'bg-amber-600' : 'bg-sky-700'
      }`}
    >
      {banner.message}
    </div>
  );
}

/**
 * §8.4 "새 SW 대기 시 토스트 … 인게임(playing) 중에는 유예(판 종료 후 표시)". registerType:
 * 'prompt'(vite.config.ts)라 vite-plugin-pwa는 자동으로 새 SW를 활성화하지 않고 이 훅의
 * `needRefresh` 플래그만 세운다 — 실제 갱신은 사용자가 버튼을 눌러야 `updateServiceWorker()`가
 * 호출된다. session.phase 구독은 이 컴포넌트가 "인게임 중" 여부만 읽고 렌더 여부를 결정할
 * 뿐, 세션 자체를 조작하지 않는다(고빈도 값이 아니라 phase 자체이므로 §4.5 불변식과 무관).
 */
function SwUpdateToast() {
  const { t } = useTranslation();
  const phase = useSessionStore((s) => s.phase);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // SW 등록 실패는 오프라인 기능 저하일 뿐 앱 크래시 사유가 아니다 — 조용히 로그만.
      console.warn('[sw] register error', error);
    },
  });

  if (!needRefresh || phase === 'playing') return null;

  const reload = () => {
    setNeedRefresh(false);
    void updateServiceWorker();
  };

  return (
    <div
      role="status"
      data-testid="sw-update-toast"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit items-center gap-3 rounded-lg bg-slate-800 px-4 py-3 text-sm text-white shadow-xl"
    >
      <span>{t('pwa.updateAvailable')}</span>
      <button
        type="button"
        data-testid="sw-update-reload"
        className="rounded bg-white/20 px-3 py-1 font-medium"
        onClick={reload}
      >
        {t('pwa.reload')}
      </button>
    </div>
  );
}

/** S12 — 라우트 무관 전역 오버레이, `?modal=settings` 검색 파라미터로 딥링크(§4.1). */
function SettingsOverlay() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isOpen = searchParams.get('modal') === 'settings';
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  // WT-DC-06 ③ — 사운드/연출 토글은 기존 스토어 필드만 배선(신규 필드 없음).
  const keySound = useSettingsStore((s) => s.keySound);
  const setKeySound = useSettingsStore((s) => s.setKeySound);
  const setVolume = useSettingsStore((s) => s.setVolume);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const setReducedMotion = useSettingsStore((s) => s.setReducedMotion);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [dataStatus, setDataStatus] = useState<
    'idle' | 'exporting' | 'confirmingReset' | 'deleting' | 'deleted' | 'error'
  >('idle');

  // 사운드 on/off: keySound + volume.master를 함께 반영한다(§WT-DC-06 ③ "사운드=keySound+volume").
  // 마스터 볼륨을 조절하는 슬라이더가 아직 없어(이 태스크 범위 밖) 이 pill이 유일한 쓰기 경로다 —
  // 완전 무음(둘 다 0/off)과 기본 복원(mech + 0.8) 두 상태만 오가므로 왕복이 결정적이다.
  const soundOn = keySound !== 'off';
  const toggleSound = () => {
    if (soundOn) {
      setKeySound('off');
      setVolume({ master: 0 });
    } else {
      setKeySound('mech');
      setVolume({ master: 0.8 });
    }
  };

  // 연출(모션) on/off: reducedMotion은 3상(boolean | 'auto')이라 이 2상 pill과 직접 맞지 않는다
  // (에스컬레이션 — 최종 보고의 매핑 표 참조). 'auto'는 위 AppShell 최상단 effect와 동일하게
  // matchMedia로 해석해 "현재 표시값"만 읽고, 클릭 시에는 항상 명시적 boolean으로 확정한다
  // (auto를 사용자의 실제 의도로 굳히는 낙관적 결정 — 재클릭하면 다시 반대로 뒤집힌다).
  const motionReduced =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  const juiceOn = !motionReduced;
  const toggleJuice = () => setReducedMotion(!motionReduced);

  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('modal');
    setSearchParams(next, { replace: true });
  };

  useHotkeys(isOpen ? { Escape: close } : {});
  // 배경 inert + 포커스 트랩 + 닫힘 시 트리거로 복귀(§7.3) — ESC는 위 useHotkeys가 이미 처리.
  useModalA11y(dialogRef, isOpen);

  // docs/06 §6.3 열람/삭제권 셀프서비스 — "내 데이터 내려받기"는 즉시 다운로드, "데이터 초기화
  // 및 삭제"는 2단계 확인 후 DELETE /users/me + localStorage 전체 삭제(§6.3 "+ localStorage
  // 삭제") + 새로고침으로 완전히 새 신원처럼 부팅되게 한다(session.ts의 재부트스트랩 리셋과는
  // 별개의 클라 측 방어 — 둘 다 있어야 "삭제"가 실제로 체감된다).
  const handleExport = async () => {
    setDataStatus('exporting');
    try {
      const data = await fetchMyDataExport();
      downloadJson(`typetrip-data-${Date.now()}.json`, data);
      setDataStatus('idle');
    } catch {
      setDataStatus('error');
    }
  };

  const handleResetConfirm = async () => {
    setDataStatus('deleting');
    try {
      await deleteMyAccount();
      setDataStatus('deleted');
      localStorage.clear();
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch {
      setDataStatus('error');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('menu.settings')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="min-w-[280px] rounded-lg bg-white p-6 shadow-xl dark:bg-slate-800">
        <h2 className="mb-4 text-lg font-bold">{t('menu.settings')}</h2>

        <p className="mb-2 text-sm font-medium">{t('settings.theme.label')}</p>
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            data-testid="theme-dark"
            aria-pressed={theme === 'dark'}
            className="rounded border px-3 py-1"
            onClick={() => setTheme('dark')}
          >
            {t('settings.theme.dark')}
          </button>
          <button
            type="button"
            data-testid="theme-light"
            aria-pressed={theme === 'light'}
            className="rounded border px-3 py-1"
            onClick={() => setTheme('light')}
          >
            {t('settings.theme.light')}
          </button>
        </div>

        {/* WT-DC-06 ③ — 사운드/연출 토글 pill. .wt-pill/.wt-pill--active + 32px 압축 변형
            .wt-settings-toggle(globals.css 모달 섹션에 정의) 재사용 — 신규 토큰 없음. */}
        <div className="mb-2 flex items-center justify-between gap-4">
          <span className="text-sm">{t('settings.sound.label')}</span>
          <button
            type="button"
            data-testid="settings-sound-toggle"
            aria-pressed={soundOn}
            className={`wt-pill wt-settings-toggle${soundOn ? ' wt-pill--active' : ''}`}
            onClick={toggleSound}
          >
            {soundOn ? t('common.on') : t('common.off')}
          </button>
        </div>
        <div className="mb-4 flex items-center justify-between gap-4">
          <span className="text-sm">{t('settings.motion.label')}</span>
          <button
            type="button"
            data-testid="settings-motion-toggle"
            aria-pressed={juiceOn}
            className={`wt-pill wt-settings-toggle${juiceOn ? ' wt-pill--active' : ''}`}
            onClick={toggleJuice}
          >
            {juiceOn ? t('common.on') : t('common.off')}
          </button>
        </div>

        {/* WT-M6-06 a11y 수정(docs/03 §7.3, e2e E10 wcag2aa 게이트): text-red-600 단독은 이 모달의
            기본(다크) 배경 dark:bg-slate-800 위에서 실측 3.02:1로 WCAG AA 4.5:1 미달(axe-core
            color-contrast, e10-a11y.spec.ts "S12 설정 모달"에서 발견). 라이트 배경(흰색)에서는
            red-600이 이미 AA를 충족하므로 dark: 변형만 더 밝은 red-400으로 교체한다(D50과 같은
            정신 — 원색을 텍스트로 쓸 때는 배경별 대비를 보정해야 한다). */}
        <div className="mb-4 flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
          <button
            type="button"
            data-testid="settings-data-export"
            className="rounded border px-3 py-1 text-left"
            disabled={dataStatus === 'exporting'}
            onClick={() => void handleExport()}
          >
            {t('settings.data.export')}
          </button>

          {dataStatus === 'confirmingReset' ? (
            <div className="rounded border border-red-400 p-3">
              <p className="text-sm font-semibold">{t('settings.resetConfirm.title')}</p>
              <p className="mt-1 text-sm">{t('settings.resetConfirm.body')}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="settings-data-reset-confirm"
                  className="rounded border border-red-500 px-3 py-1 text-red-600 dark:text-red-400"
                  onClick={() => void handleResetConfirm()}
                >
                  {t('settings.resetConfirm.confirm')}
                </button>
                <button
                  type="button"
                  data-testid="settings-data-reset-cancel"
                  className="rounded border px-3 py-1"
                  onClick={() => setDataStatus('idle')}
                >
                  {t('settings.resetConfirm.cancel')}
                </button>
              </div>
            </div>
          ) : dataStatus === 'deleting' || dataStatus === 'deleted' ? (
            <p role="status" data-testid="settings-data-reset-done" className="text-sm">
              {t('settings.resetConfirm.done')}
            </p>
          ) : (
            <button
              type="button"
              data-testid="settings-data-reset"
              className="rounded border px-3 py-1 text-left text-red-600 dark:text-red-400"
              onClick={() => setDataStatus('confirmingReset')}
            >
              {t('settings.data.reset')}
            </button>
          )}

          {dataStatus === 'error' && (
            <p role="alert" data-testid="settings-data-error" className="text-sm text-red-600 dark:text-red-400">
              {t('settings.data.error')}
            </p>
          )}
        </div>

        {/* WT-M6-06: docs/06 §10-8 크레딧/라이선스 고지 페이지 + §6.5 처리방침 페이지의 실제
            진입점(둘 다 라우트는 이미 존재했지만 이전까지 앱 내 어디에서도 링크되지 않았다). */}
        <div className="mb-4 flex gap-4 border-t border-slate-200 pt-4 text-sm dark:border-slate-700">
          <Link to="/privacy" data-testid="settings-link-privacy" onClick={close}>
            {t('settings.privacy')}
          </Link>
          <Link to="/credits" data-testid="settings-link-credits" onClick={close}>
            {t('settings.credits')}
          </Link>
        </div>

        {/* WT-DC-06 ④ — 정치중립 고지(기존 키 notice.disputed 재사용, 신규 키 없음). */}
        <p className="mb-4 border-t border-border pt-2.5 text-xs text-text-muted">{t('notice.disputed')}</p>

        <button type="button" data-testid="settings-close" className="rounded border px-3 py-1" onClick={close}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
