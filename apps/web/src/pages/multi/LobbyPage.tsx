// spec: docs/01 §10.1(S9 멀티 로비), docs/03 §4.1(lazy route), WT-M2-05 산출물 — 제목만
//       렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function LobbyPage() {
  const { t } = useTranslation();
  return <h1 className="p-8 text-2xl font-bold">{t('menu.multi')}</h1>;
}

export { LobbyPage as Component };
