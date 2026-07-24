// spec: docs/00 §11-D72(footer 법적 문서 제자리 모달 + 단일 언어), 설계 §3.1
//
// 법적 문서 레지스트리(순수 데이터). md 본문은 기존 위치에서 ?raw import한다(파일 이동 없음 —
// 파서/렌더러는 components/MarkdownLiteBody가 재사용, markdown-lite 재구현 금지). 모달·라우트
// 페이지가 공유하는 LegalArticle이 이 레지스트리에서 활성 언어(settings.lang) 소스 하나만 골라
// 렌더한다. ko/en 두 파일 모두 유지 — 언어 전환 시 즉시 반대 언어를 렌더한다.
import privacyKo from '../../pages/PrivacyPage/privacy.ko.md?raw';
import privacyEn from '../../pages/PrivacyPage/privacy.en.md?raw';
import termsKo from '../../pages/TermsPage/terms.ko.md?raw';
import termsEn from '../../pages/TermsPage/terms.en.md?raw';
import supportKo from '../../pages/SupportPage/support.ko.md?raw';
import supportEn from '../../pages/SupportPage/support.en.md?raw';

export type LegalDocId = 'privacy' | 'terms' | 'support';

export interface LegalDocEntry {
  ko: string;
  en: string;
  /** 모달 aria-label·트리거 라벨에 재사용하는 기존 i18n 키(신규 키 금지 — footer.* 재사용). */
  titleKey: 'footer.privacy' | 'footer.terms' | 'footer.support';
}

export const LEGAL_DOCS: Record<LegalDocId, LegalDocEntry> = {
  privacy: { ko: privacyKo, en: privacyEn, titleKey: 'footer.privacy' },
  terms: { ko: termsKo, en: termsEn, titleKey: 'footer.terms' },
  support: { ko: supportKo, en: supportEn, titleKey: 'footer.support' },
};
