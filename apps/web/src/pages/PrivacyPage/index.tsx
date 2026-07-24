// spec: docs/06 §6.5(개인정보처리방침 페이지 — 정적 라우트 존치), docs/00 §11-D18(런칭명 TypeTrip),
//       §11-D72(footer 제자리 모달 + 단일 언어 — 페이지·모달 동일 콘텐츠), §11-D76(내 데이터
//       셀프서비스 UI 제거), WT-M2-05 → WT-M6-01 → WT-AUTH-03 → WT-LGL-01 → WT-LGL-02
//
// [WT-LGL-01, §11-D72] 페이지 크롬(h1)만 남기고 본문·크레딧 고지는 모달과 공유하는
// features/legal/LegalArticle로 위임한다(중복 0). 본문은 이제 ko/en 병기가 아니라 settings.lang
// 단일 언어만 렌더한다(§11-D72 — 병기·privacy.lang.* 헤딩 폐기). 구 로컬 렌더러(InlineText/
// BlockView/MarkdownBody)·크레딧 섹션·md import는 삭제됐다(LegalArticle·PrivacySections·legal-docs로
// 이동). 데이터 열람/삭제 셀프서비스 UI(구 MyDataSection)는 §11-D76으로 제거됐다 — 정보주체 권리는
// 방침 §7의 이메일 접수 채널로 행사한다. markdown-lite.ts·privacy.{ko,en}.md·markdown-lite.test.ts는
// 파일 위치 그대로 존치(파서는 MarkdownLiteBody가, md는 legal-docs.ts가 계속 소비).
//
// 라우트는 여전히 non-lazy `element`(router.tsx, router-config.test.ts eager 불변식 유지) — Google
// OAuth 동의화면 공개 방침 URL·SEO·외부 직접 링크용으로 존치한다(§11-D72 라우트 존치 결정).
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { LegalArticle } from '../../features/legal/LegalArticle';

export function PrivacyPage() {
  const { t } = useTranslation();

  return (
    <div className="wt-page">
      <PageHeader title={t('settings.privacy')} />
      <LegalArticle doc="privacy" />
    </div>
  );
}
