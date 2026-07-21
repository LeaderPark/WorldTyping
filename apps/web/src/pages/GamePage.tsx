// spec: docs/03 §4.1(router.tsx가 'play/:mode/:trackId'를 lazy import하는 필수 대상),
//       docs/01 §10.1(S5→S6→S7), WT-M2-05
//
// router.tsx 산출물(§4.1 전문)이 이 경로를 이미 참조하므로, 이 태스크의 산출물 목록에 명시되지
// 않았어도 라우터가 빌드되려면 이 파일이 존재해야 한다. 실제 S5(보딩패스)→S6(인게임)→S7(결과)
// FSM 배선은 WT-M2-06(선행 작업: WT-M2-02/03/04/05)의 산출물이다 — 여기서는 제목만 렌더하는
// 자리표시자.
import { useTranslation } from 'react-i18next';

export function GamePage() {
  const { t } = useTranslation();
  return <h1 className="p-8 text-2xl font-bold">{t('game.title')}</h1>;
}

export { GamePage as Component };
