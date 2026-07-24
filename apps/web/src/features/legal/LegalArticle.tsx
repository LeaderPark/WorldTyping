// spec: docs/00 §11-D72(footer 법적 모달 + 단일 언어 — 모달·라우트 페이지 동일 콘텐츠), 설계 §3.3
//
// 모달(LegalModal)과 라우트 페이지(Privacy/Terms/SupportPage)가 공유하는 콘텐츠 단일 원천(중복 0).
// 법적 본문은 i18n 카탈로그가 아니라 md 자산이라(privacy|terms|support.{ko,en}.md), 병기 대신
// settings.lang(canonical, docs/03 §8.1)로 소스 하나만 골라 렌더한다 — 언어 전환 시 즉시 반대
// 언어로 리렌더된다(스토어 구독 = 동기 리렌더). 구 "ko+en 병기 + <hr> + privacy.lang.* 헤딩"은
// 여기서 폐기(그 키는 ko/en.json 양쪽에서 삭제). lang은 저빈도 설정값이라 §4.5 고빈도 금지와 무관.
//
// privacy는 본문 + 크레딧 최소 고지 + 데이터 열람/삭제 셀프서비스(§11-D68-⑥ 의무 UI)를 함께
// 렌더한다 — 페이지·모달 100% 동일 구성이라 footer 모달 경로에서도 삭제권 UI에 접근 가능하다.
import { MarkdownLiteBody } from '../../components/MarkdownLiteBody';
import { useSettingsStore } from '../../stores/settings';
import { LEGAL_DOCS, type LegalDocId } from './legal-docs';
import { MyDataSection, PrivacyCreditsSection } from './PrivacySections';

export function LegalArticle({ doc }: { doc: LegalDocId }) {
  const lang = useSettingsStore((s) => s.lang);
  const entry = LEGAL_DOCS[doc];
  const source = lang === 'ko' ? entry.ko : entry.en;

  return (
    <>
      <MarkdownLiteBody source={source} testId={`${doc}-body-${lang}`} />
      {doc === 'privacy' && (
        <>
          <hr className="my-8 border-border" />
          <PrivacyCreditsSection />
          <hr className="my-8 border-border" />
          <MyDataSection />
        </>
      )}
    </>
  );
}
