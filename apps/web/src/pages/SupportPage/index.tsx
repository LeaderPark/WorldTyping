// spec: docs/00 §11-D68-⑨(/support 신설 — FAQ + 문의처, "법률 자문 아님" 고지),
//       §11-D72(footer 제자리 모달 + 단일 언어 — 페이지·모달 동일 콘텐츠), WT-AUTH-06 → WT-LGL-01
//
// [WT-LGL-01, §11-D72] 백링크+h1 크롬만 남기고 본문을 모달과 공유하는 features/legal/LegalArticle로
// 위임한다(중복 0). 본문은 이제 ko/en 병기가 아니라 settings.lang 단일 언어만 렌더한다(§11-D72 —
// 병기·privacy.lang.* 헤딩 폐기). 파서/렌더러는 여전히 components/MarkdownLiteBody(재구현 금지),
// md 본문(support.{ko,en}.md)은 legal-docs.ts가 ?raw로 소비. 라우트는 eager `element` 존치.
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { LegalArticle } from '../../features/legal/LegalArticle';

export function SupportPage() {
  const { t } = useTranslation();

  return (
    <div className="wt-page" data-testid="support-page">
      <PageHeader title={t('legal.support.title')} />
      <LegalArticle doc="support" />
    </div>
  );
}
