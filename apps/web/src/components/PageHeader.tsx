// spec: docs/00 §11-D74(페이지 크롬 통일 — 헤더 브랜드 + 뒤로가기 2행), docs/03 §4.2·§7.3(useRouteFocus
//       첫 h1 계약), 설계 §2 결정 2·4
//
// 브라우징 하위 페이지 공용 헤더(홈 제외 — 홈은 자체 .wt-home__header를 유지하므로 이 컴포넌트를
// 쓰지 않는다). 구조:
//   1행 .wt-page-header__bar — 좌 BrandMark(홈으로 가는 링크) + 우 .wt-page-header__actions
//     (기본 <AuthChip/> + <ThemeToggle/> — 홈 헤더와 동일한 34px 컴팩트 문법. actions prop으로
//      대체·확장 가능).
//   2행 .wt-page-header__nav(back 또는 title이 있을 때만) — .wt-nav-back 뒤로가기 <Link>(유닛의
//     href 단언을 보존하려 button이 아니라 Link) + h1.wt-page-header__title(tabIndex={-1} —
//     useRouteFocus가 라우트 전환 시 문서의 첫 h1을 찾아 포커스한다).
// 홈/하위의 차이(홈엔 뒤로가기 없음)는 1행(전 페이지 동일)과 2행(하위 전용)의 분리로 흡수한다.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthChip } from '../features/auth/AuthChip';
import { ThemeToggle } from '../features/auth/ThemeToggle';
import { BrandMark } from './BrandMark';

export interface PageHeaderBack {
  to: string;
  labelKey: string;
  testId: string;
}

export interface PageHeaderProps {
  title?: string;
  back?: PageHeaderBack;
  actions?: ReactNode;
}

export function PageHeader({ title, back, actions }: PageHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="wt-page-header" data-testid="page-header">
      <div className="wt-page-header__bar">
        <BrandMark />
        <div className="wt-page-header__actions">
          {actions ?? (
            <>
              <AuthChip />
              <ThemeToggle />
            </>
          )}
        </div>
      </div>

      {(back || title) && (
        <div className="wt-page-header__nav">
          {back && (
            <Link to={back.to} data-testid={back.testId} className="wt-nav-back">
              {t(back.labelKey)}
            </Link>
          )}
          {title !== undefined && (
            <h1 className="wt-page-header__title" tabIndex={-1}>
              {title}
            </h1>
          )}
        </div>
      )}
    </header>
  );
}
