// spec: docs/00 §11-D68-⑨(/terms 신설 — 표준 초안, 운영주체 LeaderPark, "법률 자문 아님" 고지),
//       §11-D72(footer 제자리 모달 + 단일 언어 — 페이지·모달 동일 콘텐츠), WT-AUTH-06 → WT-LGL-01
//
// [WT-LGL-01, §11-D72] 백링크+h1 크롬만 남기고 본문을 모달과 공유하는 features/legal/LegalArticle로
// 위임한다(중복 0). 본문은 이제 ko/en 병기가 아니라 settings.lang 단일 언어만 렌더한다(§11-D72 —
// 병기·privacy.lang.* 헤딩 폐기, 그 키는 ko/en.json 양쪽에서 삭제됨). 파서/렌더러는 여전히
// components/MarkdownLiteBody(재구현 금지), md 본문(terms.{ko,en}.md)은 legal-docs.ts가 ?raw로 소비.
// 라우트는 eager `element` 존치(router.tsx 무수정 — SEO·직접 링크용).
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { LegalArticle } from '../../features/legal/LegalArticle';

export function TermsPage() {
  const { t } = useTranslation();

  return (
    <div className="wt-page" data-testid="terms-page">
      <PageHeader
        back={{ to: '/', labelKey: 'nav.back.home', testId: 'terms-back' }}
        title={t('legal.terms.title')}
      />
      <LegalArticle doc="terms" />
    </div>
  );
}
