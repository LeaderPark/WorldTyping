// spec: docs/00 §11-D74(페이지 크롬 통일 — 좌상단 브랜드), 설계 §2 결정 3
//
// 좌상단 워드마크(✈ + app.title). 하위 페이지에서는 홈으로 가는 링크(<Link to="/">)로, 홈에서는
// 자기 링크 소음을 피해 비링크 <span>으로 렌더한다(linkToHome={false}). 신규 i18n 키 0 —
// app.title 재사용. 신규 색 쌍 0 — 기존 토큰만(.wt-brand). ✈ 글리프는 장식이라 aria-hidden.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function BrandMark({ linkToHome = true }: { linkToHome?: boolean }) {
  const { t } = useTranslation();
  const inner = (
    <>
      <span aria-hidden="true">✈</span>
      {t('app.title')}
    </>
  );

  if (linkToHome) {
    return (
      <Link to="/" className="wt-brand" data-testid="brand-mark">
        {inner}
      </Link>
    );
  }
  return (
    <span className="wt-brand" data-testid="brand-mark">
      {inner}
    </span>
  );
}
