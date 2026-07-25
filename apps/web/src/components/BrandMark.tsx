// spec: docs/00 §11-D74(페이지 크롬 통일 — 좌상단 브랜드), 설계 §2 결정 3, WT-TWEAK-BRAND-LINK
//       (전 페이지 홈 링크화 — D74의 "홈=비링크 span" 조항을 대체, 2026-07-25)
//
// 좌상단 워드마크(✈ + app.title). 홈 포함 전 페이지에서 홈(`/`)으로 가는 <Link>로 렌더한다 —
// 홈에서 클릭해도 같은 경로 네비라 라우터가 무해하게 처리한다(리렌더/네비게이션 부작용 없음).
// 신규 i18n 키 0 — app.title 재사용. 신규 색 쌍 0 — 기존 토큰만(.wt-brand, hover는 기존
// a.wt-brand:hover/:focus-visible의 accent-text 강조 그대로). ✈ 글리프는 장식이라 aria-hidden.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function BrandMark() {
  const { t } = useTranslation();
  return (
    <Link to="/" className="wt-brand" data-testid="brand-home-link">
      <span aria-hidden="true">✈</span>
      {t('app.title')}
    </Link>
  );
}
