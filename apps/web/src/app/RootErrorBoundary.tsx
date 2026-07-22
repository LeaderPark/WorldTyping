// spec: docs/03 §4.1(router errorElement), docs/06 §10-4(404/500 커스텀 페이지), WT-M2-05,
//       WT-M6-06
// bootLoader의 countries.json fetch/파싱 실패 등 루트 loader 예외의 폴백 화면. 라우트 자체가
// 매치되지 않은 404(RouteErrorResponse status 404 — react-router가 매치 실패 시 던지는 표준
// 형태)는 NotFoundPage(항로 이탈 콘셉트)로 위임하고, 그 밖의 예기치 못한 에러는 범용 ErrorPage로
// 위임한다.

import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ErrorPage } from '../pages/ErrorPage';

export function RootErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }

  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);

  return <ErrorPage detail={detail} />;
}
