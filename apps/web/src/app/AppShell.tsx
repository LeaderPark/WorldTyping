// spec: docs/03 §4.2(AppShell 역할 — 테마 클래스/전역 토스트/설정 오버레이/Outlet),
//       §7.3(접근성 — 모달 ESC/focus), §8.1(테마 data-theme 속성), WT-M2-05
//
// M0 스캐폴드("Hello WORLD TYPING" 한 줄)를 라우팅 루트 레이아웃으로 교체한다.

import { Outlet, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settings';
import { useHotkeys } from '../lib/hotkeys';

export function AppShell() {
  const theme = useSettingsStore((s) => s.theme);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const highContrast = useSettingsStore((s) => s.highContrast);

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

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-900 dark:text-white">
      {/* 전역 토스트 영역 — 토스트 스토어/디스패처는 이 태스크 범위 밖(스토어 5종 고정, §4.3). */}
      <div id="wt-toast-region" aria-live="polite" className="sr-only" />
      <Outlet />
      <SettingsOverlay />
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

  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('modal');
    setSearchParams(next, { replace: true });
  };

  useHotkeys(isOpen ? { Escape: close } : {});

  if (!isOpen) return null;

  return (
    <div
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

        <button type="button" data-testid="settings-close" className="rounded border px-3 py-1" onClick={close}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
