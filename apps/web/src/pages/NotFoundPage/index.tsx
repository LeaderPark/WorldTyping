// spec: docs/06 §10-4(404 "항로 이탈" 콘셉트), docs/00 §11-D18(노출명 TypeTrip), WT-M6-06
//
// 라우트 미매치(router.tsx의 catch-all `path: '*'`) + RootErrorBoundary가 404 RouteErrorResponse를
// 위임하는 공용 셸. 여행/항공 테마(TypeTrip)에 맞춰 "항로 이탈"을 문자 그대로의 404 카피로 쓴다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white p-8 text-center text-slate-900 dark:bg-slate-900 dark:text-white"
      data-testid="not-found-page"
    >
      <p className="text-5xl" aria-hidden="true">
        🧭
      </p>
      <h1 className="text-xl font-bold" tabIndex={-1}>
        {t('error.notFound.title')}
      </h1>
      <p className="max-w-md text-sm opacity-70">{t('error.notFound.body')}</p>
      <Link
        to="/"
        data-testid="not-found-home"
        className="mt-2 rounded border px-4 py-2 text-sm font-medium"
      >
        {t('error.notFound.cta')}
      </Link>
    </main>
  );
}
