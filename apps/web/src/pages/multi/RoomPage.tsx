// spec: docs/01 §10.1(S10→S11 방/레이스), docs/03 §4.1(lazy route), WT-M2-05 산출물 — 제목만
//       렌더하는 스텁.
import { useTranslation } from 'react-i18next';

export function RoomPage() {
  const { t } = useTranslation();
  return <h1 className="p-8 text-2xl font-bold">{t('room.title')}</h1>;
}

export { RoomPage as Component };
