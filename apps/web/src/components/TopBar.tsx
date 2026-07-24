// spec: docs/00 §11-D68-⑥/⑧(크롬·로비 상단바) + WT-AUTH-03(TopBar: 뒤로·브랜드·[로그인|프로필]·테마)
//
// 브라우징 화면(로비 등, W3-05가 소비) 공용 상단바. 홈은 자체 헤더를 쓰므로 이 컴포넌트를 마운트하지
// 않는다(HomePage 헤더가 AuthChip/ThemeToggle을 직접 배치). 인게임·대기실/레이스에는 노출하지
// 않는다(§11-D68-⑨ Footer/크롬 노출 범위와 동일 정신).

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthChip } from '../features/auth/AuthChip';
import { ThemeToggle } from '../features/auth/ThemeToggle';

export interface TopBarProps {
  /** 뒤로 가기 버튼 노출(기본 false). */
  back?: boolean;
  /** 브랜드 자리 표시 텍스트. 미지정 시 앱 타이틀. */
  title?: string;
}

export function TopBar({ back = false, title }: TopBarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const brand = title ?? t('app.title');

  return (
    <header
      className="wt-appbar"
      data-testid="topbar"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}
    >
      <div className="wt-appbar__left" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
        {back && (
          <button
            type="button"
            data-testid="topbar-back"
            aria-label={t('nav.back.home')}
            className="wt-appbar__exit"
            onClick={() => navigate(-1)}
          >
            <span aria-hidden="true">←</span>
          </button>
        )}
        <span className="wt-appbar__title" title={brand}>
          {brand}
        </span>
      </div>

      <div className="wt-appbar__right" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <AuthChip />
        <ThemeToggle />
      </div>
    </header>
  );
}
