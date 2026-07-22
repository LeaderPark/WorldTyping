// spec: docs/02 §2(데이터 소스와 라이선스 — world-countries ODbL 1.0 / world-atlas·Natural Earth
//       ISC·public domain / flag-icons MIT 고지 의무), docs/06 §10-8(크레딧/라이선스 고지 페이지),
//       WT-M6-06
//
// PrivacyPage(WT-M6-01)는 이미 최소 요약(같은 3항목 + notice.disputed)을 갖고 있다 — 그 파일의
// 주석대로 "전체 크레딧 페이지 본문은 WT-M6-06 소관"이 이 컴포넌트다. 같은 i18n 키
// (privacy.credits.*)를 재사용해 두 페이지의 문구가 어긋나지 않게 하고, 여기서는 실제 라이선스
// 전문 링크를 추가한다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const LICENSES = [
  {
    key: 'privacy.credits.worldCountries',
    href: 'https://opendatacommons.org/licenses/odbl/1-0/',
    linkLabel: 'ODbL 1.0',
  },
  {
    key: 'privacy.credits.naturalEarth',
    href: 'https://www.naturalearthdata.com/about/terms-of-use/',
    linkLabel: 'Natural Earth — Terms of Use',
  },
  {
    key: 'privacy.credits.flagIcons',
    href: 'https://github.com/lipis/flag-icons/blob/main/LICENSE',
    linkLabel: 'MIT License',
  },
] as const;

export function CreditsPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-2xl p-6" data-testid="credits-page">
      <Link to="/" data-testid="credits-back" className="wt-nav-back">
        {t('nav.back.home')}
      </Link>
      <h1 className="mt-2 text-2xl font-bold" tabIndex={-1}>
        {t('credits.title')}
      </h1>
      <p className="mt-2 text-sm opacity-80">{t('credits.intro')}</p>

      <ul className="mt-4 list-disc space-y-2 pl-6 text-sm leading-relaxed" data-testid="credits-list">
        {LICENSES.map((item) => (
          <li key={item.key}>
            {t(item.key)}{' '}
            <a href={item.href} target="_blank" rel="noreferrer noopener" className="underline">
              ({item.linkLabel})
            </a>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-sm text-slate-500 dark:text-slate-400" data-testid="credits-disputed-notice">
        {t('notice.disputed')}
      </p>
    </div>
  );
}
