// spec: docs/03 §4.1(router errorElement), WT-M2-05
// bootLoader의 countries.json fetch/파싱 실패 등 루트 loader 예외의 폴백 화면.

import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function RootErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation();

  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <main className="flex min-h-screen items-center justify-center bg-white p-8 text-center text-slate-900 dark:bg-slate-900 dark:text-white">
      <div>
        <h1 className="text-xl font-bold" tabIndex={-1}>
          {t('error.boundary.title')}
        </h1>
        <p className="mt-2 text-sm opacity-70">{detail}</p>
      </div>
    </main>
  );
}
