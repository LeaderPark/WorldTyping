// spec: docs/01 §10.1(S8 리더보드), docs/03 §4.1(lazy route — RRv6 `Component` 계약),
//       WT-M2-05 산출물 — 제목만 렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function RankPage() {
  const { t } = useTranslation();
  return <h1 className="p-8 text-2xl font-bold">{t('rank.title')}</h1>;
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { RankPage as Component };
