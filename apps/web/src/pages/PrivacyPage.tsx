// spec: docs/01 §10.1(개인정보처리방침), WT-M2-05 산출물 — 제목만 렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function PrivacyPage() {
  const { t } = useTranslation();
  return (
    <h1 className="p-8 text-2xl font-bold" tabIndex={-1}>
      {t('settings.privacy')}
    </h1>
  );
}
