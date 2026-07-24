// spec: docs/00 §11-D68-⑨(Footer 노출은 브라우징 화면 한정 — 인게임·대기실/레이스 제외),
//       §11-D72(footer 법적 링크 → 제자리 딤 스크림 모달, URL·히스토리 불변), footer-ref.png,
//       WT-AUTH-06, WT-LGL-01
//
// 마운트 여부(허용목록 판단)는 이 컴포넌트가 아니라 app/AppShell.tsx가 라우트별로 결정한다 —
// 이 컴포넌트 자신은 항상 동일하게 렌더한다. i18n 키(footer.*)는 WT-AUTH-03이 이미 채워 뒀다
// (footer.privacy/footer.terms/footer.support/footer.copyright) — 새 키를 추가하지 않는다.
//
// [WT-LGL-01, §11-D72] 개인정보/약관/지원은 더 이상 라우트로 이동하지 않는다 — <Link> 3개를
// <button> 3개로 바꾸고(testid 3종 유지), 로컬 state로 LegalModal을 현재 화면 위에 조건부
// 마운트한다(URL·히스토리 절대 불변, pushState·?legal= 불사용). /privacy·/terms·/support 라우트는
// OAuth 공개 URL·SEO·직접 링크용으로 존치하되 footer는 그리로 잇지 않는다.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LegalModal } from '../features/legal/LegalModal';
import type { LegalDocId } from '../features/legal/legal-docs';

export function SiteFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const [doc, setDoc] = useState<LegalDocId | null>(null);

  return (
    <footer className="wt-footer" data-testid="site-footer">
      <nav className="wt-footer__links">
        <button
          type="button"
          data-testid="footer-link-privacy"
          className="wt-footer__link"
          onClick={() => setDoc('privacy')}
        >
          {t('footer.privacy')}
        </button>
        <span className="wt-footer__divider" aria-hidden="true">
          |
        </span>
        <button
          type="button"
          data-testid="footer-link-terms"
          className="wt-footer__link"
          onClick={() => setDoc('terms')}
        >
          {t('footer.terms')}
        </button>
        <span className="wt-footer__divider" aria-hidden="true">
          |
        </span>
        <button
          type="button"
          data-testid="footer-link-support"
          className="wt-footer__link"
          onClick={() => setDoc('support')}
        >
          {t('footer.support')}
        </button>
      </nav>
      <p className="wt-footer__copyright">{t('footer.copyright', { year })}</p>

      {/* [§11-D72] 라우트 이동 없이 현재 화면 위에 딤 스크림 모달로 연다(URL 불변). */}
      {doc && <LegalModal doc={doc} onClose={() => setDoc(null)} />}
    </footer>
  );
}
