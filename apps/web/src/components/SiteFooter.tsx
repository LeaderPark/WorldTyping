// spec: docs/00 §11-D68-⑨(Footer 노출은 브라우징 화면 한정 — 인게임·대기실/레이스 제외),
//       footer-ref.png(구조 참조 — 중앙 정렬 링크 3개 + ⓒ 카피라이트), WT-AUTH-06
//
// 마운트 여부(허용목록 판단)는 이 컴포넌트가 아니라 app/AppShell.tsx가 라우트별로 결정한다 —
// 이 컴포넌트 자신은 항상 동일하게 렌더한다. i18n 키(footer.*)는 WT-AUTH-03이 이미 채워 뒀다
// (footer.privacy/footer.terms/footer.support/footer.copyright) — 새 키를 추가하지 않는다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function SiteFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <footer className="wt-footer" data-testid="site-footer">
      <nav className="wt-footer__links">
        <Link to="/privacy" data-testid="footer-link-privacy" className="wt-footer__link">
          {t('footer.privacy')}
        </Link>
        <span className="wt-footer__divider" aria-hidden="true">
          |
        </span>
        <Link to="/terms" data-testid="footer-link-terms" className="wt-footer__link">
          {t('footer.terms')}
        </Link>
        <span className="wt-footer__divider" aria-hidden="true">
          |
        </span>
        <Link to="/support" data-testid="footer-link-support" className="wt-footer__link">
          {t('footer.support')}
        </Link>
      </nav>
      <p className="wt-footer__copyright">{t('footer.copyright', { year })}</p>
    </footer>
  );
}
