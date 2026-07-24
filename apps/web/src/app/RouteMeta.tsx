// spec: docs/06 §10-2(SEO/OG — 홈·/daily·/rank·/r/:id 별 title/description/OG/Twitter Card,
//       hreflang ko/en), docs/00 §11-D18(노출명 TypeTrip, 도메인 하드코딩 금지), WT-M6-06
//
// /r/:shareId·/multi/:code(초대 미리보기)는 workers/api/src/routes/share.ts가 완전히 별도로
// 서버 렌더하는 HTML이다(이 SPA가 아니다) — 이 컴포넌트의 대상이 아니다. 그 서버 렌더 경로가
// 실제 링크 미리보기(X/카카오 크롤러, JS 미실행)를 전담하므로, 이 컴포넌트는 SPA가 직접 서빙하는
// 나머지 라우트의 브라우저 탭 타이틀 + 검색엔진(JS를 실행하는 크롤러) 대상 기본 SEO 신호만
// 담당한다.
//
// 도메인은 절대 하드코딩하지 않는다(§11-D18) — Worker 전용 추상화인 PUBLIC_ORIGIN 대신, 클라
// 런타임에서는 `location.origin`이 곧 정답이다(어떤 환경에 배포되든 항상 실제 접속 오리진).
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../stores/settings';

interface RouteMetaEntry {
  titleKey: string;
  descKey: string;
}

// 우선순위 순서(구체적인 경로부터) — 배열을 순서대로 검사해 첫 매치를 채택한다.
const ROUTE_META: Array<{ test: (path: string) => boolean; entry: RouteMetaEntry }> = [
  { test: (p) => p === '/daily', entry: { titleKey: 'home.daily.title', descKey: 'seo.daily.description' } },
  { test: (p) => p === '/rank', entry: { titleKey: 'rank.title', descKey: 'seo.rank.description' } },
  { test: (p) => p === '/play', entry: { titleKey: 'mode.select.title', descKey: 'seo.play.description' } },
  { test: (p) => p.startsWith('/play/'), entry: { titleKey: 'game.title', descKey: 'seo.play.description' } },
  { test: (p) => p === '/multi', entry: { titleKey: 'menu.multi', descKey: 'seo.multi.description' } },
  { test: (p) => p.startsWith('/multi/'), entry: { titleKey: 'room.title', descKey: 'seo.multi.description' } },
  { test: (p) => p === '/passport', entry: { titleKey: 'passport.title', descKey: 'seo.passport.description' } },
  { test: (p) => p === '/privacy', entry: { titleKey: 'settings.privacy', descKey: 'seo.privacy.description' } },
  { test: (p) => p === '/terms', entry: { titleKey: 'legal.terms.title', descKey: 'seo.terms.description' } },
  { test: (p) => p === '/support', entry: { titleKey: 'legal.support.title', descKey: 'seo.support.description' } },
  { test: (p) => p === '/credits', entry: { titleKey: 'credits.title', descKey: 'seo.credits.description' } },
];

function upsertMeta(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertLink(rel: string, href: string, hreflang?: string): void {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]`;
  let el = document.head.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    if (hreflang) el.setAttribute('hreflang', hreflang);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

/**
 * SPA 라우트별 <head> 메타 — AppShell에 1회 마운트해 라우트/언어 전환마다 갱신한다(docs/06 §10-2).
 * 반환값 없음(부수효과 전용 컴포넌트) — Outlet 옆에 그냥 마운트해 두면 된다.
 */
export function RouteMeta(): null {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);

  useEffect(() => {
    const matched = ROUTE_META.find((r) => r.test(pathname))?.entry;
    const isHome = pathname === '/';
    const title = isHome
      ? `${t('app.title')} — ${t(`app.tagline.${lang}`)}`
      : matched
        ? `${t(matched.titleKey)} · ${t('app.title')}`
        : `${t('error.notFound.title')} · ${t('app.title')}`;
    const description = isHome
      ? t('seo.home.description')
      : matched
        ? t(matched.descKey)
        : t('seo.home.description');

    document.title = title;

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}${pathname}`;

    upsertMeta('name', 'description', description);
    upsertMeta('property', 'og:title', title);
    upsertMeta('property', 'og:description', description);
    upsertMeta('property', 'og:url', url);
    upsertMeta('name', 'twitter:title', title);
    upsertMeta('name', 'twitter:description', description);
    upsertLink('canonical', url);
    upsertLink('alternate', url, 'ko');
    upsertLink('alternate', url, 'en');
    upsertLink('alternate', url, 'x-default');
  }, [pathname, lang, t]);

  return null;
}
