// spec: docs/06 §6.5(정적 단일 페이지 관행 승계 — ko 본문 전체 다음 en 본문 전체), docs/00
//       §11-D68-⑨(/support 신설 — FAQ + 문의처, "법률 자문 아님" 고지), WT-AUTH-06
//
// TermsPage와 동일한 패턴(md?raw + 공용 MarkdownLiteBody). 본문은 로그인/랭킹 기준/데이터
// 열람·삭제(→/privacy)/신고 FAQ와 문의처(dkdleldjqkr976@gmail.com)를 다룬다(support.{ko,en}.md).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MarkdownLiteBody } from '../../components/MarkdownLiteBody';
import supportKo from './support.ko.md?raw';
import supportEn from './support.en.md?raw';

export function SupportPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-2xl p-6" data-testid="support-page">
      <Link to="/" data-testid="support-back" className="wt-nav-back">
        {t('nav.back.home')}
      </Link>

      <h1 className="mt-3 text-2xl font-bold" tabIndex={-1}>
        {t('legal.support.title')}
      </h1>

      <section aria-label={t('privacy.lang.ko')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.ko')}
        </h2>
        <MarkdownLiteBody source={supportKo} testId="support-body-ko" />
      </section>

      <hr className="my-8 border-border" />

      <section aria-label={t('privacy.lang.en')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.en')}
        </h2>
        <MarkdownLiteBody source={supportEn} testId="support-body-en" />
      </section>
    </div>
  );
}
