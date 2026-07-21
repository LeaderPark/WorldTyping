// spec: docs/01 §10.1(S4 노선/세부 선택), WT-M2-05 산출물 — 제목만 렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function TrackSelectPage() {
  const { t } = useTranslation();
  return <h1 className="p-8 text-2xl font-bold">{t('route.select.title')}</h1>;
}
