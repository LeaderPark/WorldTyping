// spec: docs/03 §7.3("키보드 온리: … 라우트 전환 시 <h1 tabIndex={-1}>로 포커스 이동"), WT-M5-02
//
// 각 페이지는 그 화면의 h1에 tabIndex={-1}을 부여해둔다(포커스 가능하되 Tab 순회에는 끼지
// 않음). 이 훅은 pathname이 바뀔 때마다 현재 문서의 첫 h1을 찾아 포커스한다 — 스크린리더
// 사용자가 라우트가 바뀐 것을 알아채고, 그 화면의 제목부터 다시 읽어 내려갈 수 있게 한다.
// 라우트 전환 없이 같은 화면 안에서 phase만 바뀌는 경우(GamePage의 S5→S6→S7)는 pathname이
// 그대로라 이 훅이 관여하지 않는다 — 그 경우는 각 화면이 자체적으로 다룰 몫이다(GameView는
// 인게임 중 h1이 없다 — §10.1 "동일 라우트 상태 전환" 참조).
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export function useRouteFocus(): void {
  const { pathname } = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    // 최초 마운트(첫 페인트)는 포커스를 가로채지 않는다 — 사용자가 아직 아무 데도 포커스를
    // 두지 않았을 수 있고, 첫 로드 시점의 자동 포커스 강탈은 오히려 방해가 된다(§7.3의
    // 의도는 "전환 시" 낭독이지 초기 로드 스틸링이 아니다).
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('h1');
    heading?.focus();
  }, [pathname]);
}
