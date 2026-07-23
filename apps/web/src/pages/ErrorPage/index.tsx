// spec: docs/06 §10-4(500 커스텀 에러 페이지), WT-M6-06,
//       WT-UI-09(라이트 리스타일 — .wt-card + .wt-pill 귀환 CTA, docs/00 §11-D57)
//
// RootErrorBoundary(라우터 loader/렌더 예외)가 위임하는 범용 에러 셸. 라우트 미매치(404)는
// NotFoundPage가 별도로 담당하고, 이 컴포넌트는 그 밖의 예기치 못한 에러(500 상당) 전용이다.
//
// [WT-UI-09] NotFoundPage와 동일한 사유(errorElement 경로는 AppShell 바깥에서도 단독 렌더될 수
// 있다)로 bg-bg/text-text를 <main> 자신에 직접 부여하고, 본문을 .wt-card로 감싼다. 귀환 CTA는
// .wt-pill(다른 화면의 필 버튼과 동일 클래스)로 통일했다.
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
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-6 text-center text-text"
      data-testid="error-page"
    >
      <div className="wt-card flex max-w-sm flex-col items-center gap-3 p-8">
        <h1 className="text-xl font-bold" tabIndex={-1}>
          {t('error.boundary.title')}
        </h1>
        {detail && <p className="text-sm text-text-muted">{detail}</p>}
        <Link to="/" data-testid="error-page-home" className="wt-pill mt-2">
          {t('error.boundary.cta')}
        </Link>
      </div>
    </main>
  );
}
