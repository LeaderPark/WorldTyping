// spec: docs/06 §10-4(500 커스텀 에러 페이지), WT-M6-06
//
// RootErrorBoundary(라우터 loader/렌더 예외)가 위임하는 범용 에러 셸. 라우트 미매치(404)는
// NotFoundPage가 별도로 담당하고, 이 컴포넌트는 그 밖의 예기치 못한 에러(500 상당) 전용이다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface ErrorPageProps {
  /** 개발/디버깅 참고용 상세(상태코드+statusText 또는 에러 메시지). 사용자 대상 카피가 아니다. */
  detail?: string;
}

export function ErrorPage({ detail }: ErrorPageProps) {
  const { t } = useTranslation();

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white p-8 text-center text-slate-900 dark:bg-slate-900 dark:text-white"
      data-testid="error-page"
    >
      <h1 className="text-xl font-bold" tabIndex={-1}>
        {t('error.boundary.title')}
      </h1>
      {detail && <p className="mt-2 max-w-md text-sm opacity-70">{detail}</p>}
      <Link
        to="/"
        data-testid="error-page-home"
        className="mt-2 rounded border px-4 py-2 text-sm font-medium"
      >
        {t('error.boundary.cta')}
      </Link>
    </main>
  );
}
