// spec: docs/06 §6.5(정적 단일 페이지 관행 승계 — ko 본문 전체 다음 en 본문 전체), docs/00
//       §11-D68-⑨(/terms 신설 — 표준 초안, 운영주체 LeaderPark, "법률 자문 아님" 고지), WT-AUTH-06
//
// PrivacyPage(WT-M6-01)와 동일한 패턴을 그대로 따른다: md?raw로 가져온 ko/en 본문을 이어 붙여
// 렌더하는 정적 단일 페이지, 파서는 PrivacyPage/markdown-lite.ts(재사용, 재구현 아님), JSX 렌더는
// 공용 components/MarkdownLiteBody.tsx(신규 — 이유는 그 파일 상단 주석 참조). i18n 키는 03이
// 이미 채운 legal.terms.title/nav.back.home/privacy.lang.{ko,en}만 재사용하고 새 키를 추가하지
// 않는다. eager `element` 라우트(router.tsx)로 등록해 router-config.test.ts의 "Privacy/Credits와
// 동일하게 eager" 불변식에 합류한다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MarkdownLiteBody } from '../../components/MarkdownLiteBody';
import termsKo from './terms.ko.md?raw';
import termsEn from './terms.en.md?raw';

export function TermsPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-2xl p-6" data-testid="terms-page">
      <Link to="/" data-testid="terms-back" className="wt-nav-back">
        {t('nav.back.home')}
      </Link>

      <h1 className="mt-3 text-2xl font-bold" tabIndex={-1}>
        {t('legal.terms.title')}
      </h1>

      <section aria-label={t('privacy.lang.ko')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.ko')}
        </h2>
        <MarkdownLiteBody source={termsKo} testId="terms-body-ko" />
      </section>

      <hr className="my-8 border-border" />

      <section aria-label={t('privacy.lang.en')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.en')}
        </h2>
        <MarkdownLiteBody source={termsEn} testId="terms-body-en" />
      </section>
    </div>
  );
}
