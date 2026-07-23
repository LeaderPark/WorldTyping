// spec: docs/06 §10-4(404 "항로 이탈" 콘셉트), docs/00 §11-D18(노출명 TypeTrip), WT-M6-06,
//       WT-UI-09(라이트 리스타일 — .wt-card + .wt-pill 귀환 CTA, docs/00 §11-D57)
//
// 라우트 미매치(router.tsx의 catch-all `path: '*'`) + RootErrorBoundary가 404 RouteErrorResponse를
// 위임하는 공용 셸. 여행/항공 테마(TypeTrip)에 맞춰 "항로 이탈"을 문자 그대로의 404 카피로 쓴다.
//
// [WT-UI-09] 구 bg-white/dark:bg-slate-900 하드코딩 리터럴을 --bg/--text 시맨틱 토큰(WT-UI-01 이후
// AppShell이 이미 쓰는 값)으로 교체하고, 본문 카드를 전역 .wt-card(surface+radius-card+shadow-card)
// 로 감싼다 — 이 페이지는 RootErrorBoundary의 errorElement 경로로 AppShell 없이 단독 렌더될 수도
// 있어(루트 loader 예외) bg-bg/text-text를 이 <main> 자신에도 직접 부여해 두 경로 모두 안전하다.
// 귀환 CTA는 다른 화면의 필 버튼과 동일한 .wt-pill로 리스타일(구 "rounded border" 임시 스타일 대체).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-6 text-center text-text"
      data-testid="not-found-page"
    >
      <div className="wt-card flex max-w-sm flex-col items-center gap-3 p-8">
        <p className="text-5xl" aria-hidden="true">
          🧭
        </p>
        <h1 className="text-xl font-bold" tabIndex={-1}>
          {t('error.notFound.title')}
        </h1>
        <p className="text-sm text-text-muted">{t('error.notFound.body')}</p>
        <Link to="/" data-testid="not-found-home" className="wt-pill mt-2">
          {t('error.notFound.cta')}
        </Link>
      </div>
    </main>
  );
}
