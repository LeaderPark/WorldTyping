// spec: docs/03 §4.2(AppShell 역할 — 테마 클래스/전역 토스트/전역 모달/Outlet), §7.3(접근성),
//       §8.1(테마 data-theme 속성), §8.4(PWA 업데이트 UX), docs/00 §11-D68-⑥(SettingsOverlay 전면
//       제거 — 기어=테마 토글, 데이터 열람/삭제 UI는 /privacy 하단으로 이전), §11-D68-⑨(Footer
//       노출은 브라우징 화면 한정), WT-M6-06, WT-AUTH-03, WT-AUTH-06
//
// [WT-AUTH-03] S12 SettingsOverlay와 `?modal=settings` 배선을 전면 삭제했다(§11-D68-⑥). 테마
// 전환은 TopBar/홈 헤더의 ThemeToggle이, 데이터 열람·삭제 셀프서비스는 PrivacyPage 하단이 대신
// 맡는다. AppShell은 이제 라우트 무관 전역 오버레이로 LoginModal 하나만 마운트한다.
//
// [WT-AUTH-06] SiteFooter는 "브라우징 화면"에서만 마운트한다(§11-D68-⑨) — 인게임(`/play/*`:
// 모드선택·트랙선택·게임 진행 전부 포함)과 대기실/레이스(`/multi/:roomCode`)에는 노출하지
// 않는다. `/multi`(로비)는 예외적으로 허용(로비는 브라우징 화면). 두 접두사만 제외하면 나머지는
// 전부 허용목록에 해당하므로(홈·rank·passport·daily·privacy·terms·support·credits·404) 접두사
// 배제 방식으로 구현하되, 의미는 리드가 확정한 허용목록과 동일하다.
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useSettingsStore } from '../stores/settings';
import { useSessionStore } from '../stores/session';
import { useRouteFocus } from '../lib/useRouteFocus';
import { LoginModal } from '../features/auth/LoginModal';
import { SiteFooter } from '../components/SiteFooter';
import { getBootData, type BannerConfig } from './bootLoader';
import { RouteMeta } from './RouteMeta';

/** §11-D68-⑨ 허용목록의 여집합 표현 — `/play`(모드 선택)·`/play/:mode`(트랙 선택)·
 *  `/play/:mode/:trackId`(인게임) 전부와 `/multi/:roomCode`(대기실/레이스)만 제외하고, 그 외
 *  모든 경로(홈·`/multi` 로비·rank·passport·daily·privacy·terms·support·credits·404)는 노출한다. */
function isBrowsingRoute(pathname: string): boolean {
  if (pathname === '/play' || pathname.startsWith('/play/')) return false;
  if (pathname.startsWith('/multi/')) return false; // '/multi'(로비) 자체는 제외 대상이 아님
  return true;
}

export function AppShell() {
  const theme = useSettingsStore((s) => s.theme);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const highContrast = useSettingsStore((s) => s.highContrast);
  const fontScale = useSettingsStore((s) => s.fontScale);
  const { pathname } = useLocation();

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
      {/* 전역 토스트 영역 — 토스트 스토어/디스패처는 이 태스크 범위 밖. */}
      <div id="wt-toast-region" aria-live="polite" className="sr-only" />
      <Outlet />
      {/* [WT-AUTH-06] 브라우징 화면 한정 Footer(§11-D68-⑨) — 인게임·대기실/레이스 제외. */}
      {isBrowsingRoute(pathname) && <SiteFooter />}
      {/* [WT-AUTH-03] 라우트 무관 전역 로그인 모달(§11-D68) — openLogin(reason)으로 어디서든 연다. */}
      <LoginModal />
      <SwUpdateToast />
    </div>
  );
}

/**
 * WT-M6-06: KV config:banner(운영자 장애 공지, docs/06 §10-4 + §11-D9 D1/DO=canonical과 별개인
 * 운영 핫스왑 채널). `getBootData()`는 데이터 라우터의 root loader(bootLoader)가 이미 resolve된
 * 뒤에만 안전하다 — 이 컴포넌트를 AppShell 없이 classic <MemoryRouter>로 직접 렌더하는 기존
 * 테스트에서는 loader가 실행되지 않으므로 effect 안에서 try/catch로 감싸 "배너 없음"으로 조용히
 * 폴백한다(장애 배너는 부가 기능이라 크래시 사유가 아니다).
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
