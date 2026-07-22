// spec: docs/01 §10.1(S13 프로필/여권), docs/03 §4.1(lazy route), WT-M2-05 산출물 — 제목만
//       렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function PassportPage() {
  const { t } = useTranslation();
  return (
    <h1 className="p-8 text-2xl font-bold" tabIndex={-1}>
      {t('menu.passport')}
    </h1>
  );
}

export { PassportPage as Component };
