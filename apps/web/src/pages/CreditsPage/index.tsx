// spec: docs/02 §2(데이터 소스와 라이선스 — world-countries ODbL 1.0 / world-atlas·Natural Earth
//       ISC·public domain / flag-icons MIT 고지 의무), docs/06 §10-8(크레딧/라이선스 고지 페이지),
//       WT-M6-06, WT-UI-09(라이트 리스타일)
//
// PrivacyPage(WT-M6-01)는 이미 최소 요약(같은 3항목 + notice.disputed)을 갖고 있다 — 그 파일의
// 주석대로 "전체 크레딧 페이지 본문은 WT-M6-06 소관"이 이 컴포넌트다. 같은 i18n 키
// (privacy.credits.*)를 재사용해 두 페이지의 문구가 어긋나지 않게 하고, 여기서는 실제 라이선스
// 전문 링크를 추가한다. flag-icons(MIT) 고지는 WT-M6-06이 이미 3항목(world-countries/
// Natural Earth/flag-icons) 전부로 채워 두었다(WT-UI-03이 도입한 국기 SVG 자산 대응) — 아래
// LICENSES는 그 상태 그대로이고, WT-UI-09는 표면 리스타일만 담당한다.
//
// [WT-UI-09] 본문을 전역 .wt-card(surface+radius-card+shadow-card)로 감싸고, 텍스트는
// opacity 트릭 대신 --text-muted 토큰으로 통일했다. 상단 크롬은 공용 PageHeader(D74)를 쓴다 —
// [D75] 뒤로가기 링크(.wt-nav-back)는 폐지됐고 홈 이동은 좌상단 BrandMark가 담당한다.
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';

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
    <div className="wt-page" data-testid="credits-page">
      <PageHeader title={t('credits.title')} />
      <div className="wt-card mt-3 p-6">
        <p className="text-sm text-text-muted">{t('credits.intro')}</p>

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

        {/* WT-UI-01 독립 검증 FAIL 수정: 하드코딩 text-slate-500(#64748b) on --bg(#f4f5ef) =
            4.34:1로 WCAG AA 4.5:1 미달 — --text-muted 토큰으로 교체(PrivacyPage와 동일 사유). */}
        <p className="mt-4 text-sm text-text-muted" data-testid="credits-disputed-notice">
          {t('notice.disputed')}
        </p>
      </div>
    </div>
  );
}
