// spec: docs/00 §11-D74(페이지 크롬 통일 — 헤더 브랜드)·D75(2행 nav 폐지 — 하위 헤더 = 홈 1행
//       동일, 뒤로가기 링크 제거·title은 sr-only h1로 보존), docs/03 §4.2·§7.3(useRouteFocus 첫 h1)
//
// 브라우징 하위 페이지 공용 헤더(홈 제외 — 홈은 자체 .wt-home__header를 유지하므로 이 컴포넌트를
// 쓰지 않는다). [D75] 홈과 픽셀 동일한 1행 bar만으로 구성한다(2행 nav 시각 폐지 — 메인→하위 진입
// 시 헤더 크기 점프 0):
//   .wt-page-header(=.wt-home__header와 동일 기하) — 좌 BrandMark(전 페이지 홈 링크,
//   WT-TWEAK-BRAND-LINK) + 우
//   .wt-page-header__actions(기본 <AuthChip/> + <ThemeToggle/> — 홈 헤더와 동일한 34px 컴팩트
//    문법. actions prop으로 대체·확장 가능).
// title이 주어지면 시각적으로 감춘 sr-only <h1 tabIndex={-1}>로만 남긴다 — useRouteFocus가 라우트
// 전환 시 문서의 첫 h1을 찾아 포커스하고, router.test·axe가 상위 라우트마다 비어있지 않은 h1을
// 요구하므로 화면에는 안 보여도 DOM/a11y 트리에는 존재해야 한다. [D75] 뒤로가기 <Link>는 렌더
// 자체를 폐지했다(홈 이동은 좌상단 BrandMark로 충분). DailyPage/LobbyPage는 title 미전달(자체
// 콘텐츠 h1 보유).
import type { ReactNode } from 'react';
import { AuthChip } from '../features/auth/AuthChip';
import { ThemeToggle } from '../features/auth/ThemeToggle';
import { BrandMark } from './BrandMark';

export interface PageHeaderProps {
  title?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <header className="wt-page-header" data-testid="page-header">
      <BrandMark />
      <div className="wt-page-header__actions">
        {actions ?? (
          <>
            <AuthChip />
            <ThemeToggle />
          </>
        )}
      </div>
      {title !== undefined && (
        <h1 className="sr-only" tabIndex={-1}>
          {title}
        </h1>
      )}
    </header>
  );
}
