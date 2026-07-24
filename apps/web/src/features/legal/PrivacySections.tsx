// spec: docs/00 §11-D72(footer 법적 모달 — privacy 구성은 페이지·모달 동일),
//       §11-D76(내 데이터 셀프서비스 UI 제거 — 데이터 권리는 이메일 채널), docs/06 §6.3
//
// 크레딧 최소 고지 단일 원천(§11-D76: 내 데이터 셀프서비스 UI 제거 — 데이터 권리는 이메일 채널,
// docs/06 §6.3). LegalArticle이 doc==='privacy'일 때 이 섹션을 렌더하므로 footer 모달과 /privacy
// 페이지가 동일 구성(본문 + 크레딧 고지)을 공유한다(중복 0).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * 크레딧 최소 고지 섹션. notice.disputed(i18n) + ODbL/Natural Earth/flag-icons 고지(docs/02 §2·§12).
 * 전체 크레딧 페이지(라이선스 전문 링크 포함)는 /credits(WT-M6-06)가 신설했다 — 여기는 방침에
 * 요구되는 최소 고지 + 그 페이지로의 링크만 유지한다. 모달에서 이 링크를 누르면 라우트가 바뀌고
 * LegalModal의 pathname effect가 모달을 자동으로 닫는다(자연스러운 "전체 크레딧 페이지로 이동").
 */
export function PrivacyCreditsSection() {
  const { t } = useTranslation();
  return (
    <section aria-label={t('privacy.credits.heading')} data-testid="privacy-credits">
      <h2 className="text-base font-semibold">{t('privacy.credits.heading')}</h2>
      <ul className="mt-2 list-disc pl-6 text-sm leading-relaxed">
        <li>{t('privacy.credits.worldCountries')}</li>
        <li>{t('privacy.credits.naturalEarth')}</li>
        <li>{t('privacy.credits.flagIcons')}</li>
      </ul>
      <p className="mt-2 text-sm text-text-muted">{t('notice.disputed')}</p>
      <p className="mt-1 text-sm">
        <Link to="/credits" data-testid="privacy-credits-link" className="underline">
          {t('credits.title')}
        </Link>
      </p>
    </section>
  );
}
