// spec: docs/03 §4.1(라우터 전문), docs/01 §10.1(화면 목록 S1~S13), WT-M2-05
//
// S5(보딩패스)→S6(인게임)→S7(결과)은 라우트 전환이 아니라 GamePage 내부 세션 FSM phase 분기
// (docs/01 §10.1 "동일 라우트 상태 전환"). S12 설정은 AppShell의 전역 오버레이(`?modal=settings`).

import type { RouteObject } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RootErrorBoundary } from './RootErrorBoundary';
import { bootLoader } from './bootLoader';
import { HomePage } from '../pages/HomePage';
import { ModeSelectPage } from '../pages/ModeSelectPage';
import { TrackSelectPage } from '../pages/TrackSelectPage';
import { PrivacyPage } from '../pages/PrivacyPage';
import { TermsPage } from '../pages/TermsPage';
import { SupportPage } from '../pages/SupportPage';
import { CreditsPage } from '../pages/CreditsPage';
import { DailyPage } from '../pages/DailyPage';
import { NotFoundPage } from '../pages/NotFoundPage';

/**
 * GamePage/RankPage/멀티/PassportPage는 lazy(§4.1 원문) — 각 모듈은 React Router v6.4+ lazy
 * 계약에 맞춰 `Component`를 named export한다(해당 페이지 파일 하단 참조).
 */
export const routeChildren: RouteObject[] = [
  { index: true, element: <HomePage /> }, // S1(+S2 오버레이)
  { path: 'play', element: <ModeSelectPage /> }, // S3
  // WT-CH-08(docs/09 §8.1, §11-D90): chase는 TrackSelect 없이 직행(시드가 홈을 정한다) — trackId
  // 세그먼트가 없는 이 정적 경로가 아래 동적 'play/:mode'보다 항상 우선 매칭된다(react-router
  // 정적>동적 우선순위, 상단 주석·NotFoundPage catch-all과 동일 원리 — 배열 순서 무관). GamePage
  // 모듈이 pathname으로 chase를 감지해 features/chase/ChaseGameRoot로 위임한다(별도 lazy 청크).
  { path: 'play/chase', lazy: () => import('../pages/GamePage') },
  { path: 'play/:mode', element: <TrackSelectPage /> }, // S4
  { path: 'play/:mode/:trackId', lazy: () => import('../pages/GamePage') }, // S5→S6→S7
  { path: 'rank', lazy: () => import('../pages/RankPage') }, // S8
  { path: 'multi', lazy: () => import('../pages/multi/LobbyPage') }, // S9
  { path: 'multi/:roomCode', lazy: () => import('../pages/multi/RoomPage') }, // S10→S11
  { path: 'passport', lazy: () => import('../pages/PassportPage') }, // S13
  { path: 'privacy', element: <PrivacyPage /> },
  // WT-AUTH-06: docs/00 §11-D68-⑨ 법적 페이지 신설 — 표준 초안 + "법률 자문 아님" 고지.
  { path: 'terms', element: <TermsPage /> },
  { path: 'support', element: <SupportPage /> },
  { path: 'credits', element: <CreditsPage /> }, // WT-M6-06: docs/06 §10-8 라이선스 고지
  // WT-M6-06: docs/06 §10-2 SEO 체크리스트가 전제하는 "/daily" 랜딩(실제 플레이 진입은 여전히
  // play/daily/:trackId, router.tsx 상단 세션 조정 주석 + DailyPage 파일 상단 주석 참조).
  { path: 'daily', element: <DailyPage /> },
  // catch-all(WT-M6-06, docs/06 §10-4 "404 항로 이탈 콘셉트") — react-router는 순서가 아니라
  // 정적>동적>splat 매칭 우선순위로 라우팅하므로 배열 어디에 있어도 다른 라우트를 가리지 않는다.
  { path: '*', element: <NotFoundPage /> },
];

/**
 * DEV 전용 진단 라우트. 프로덕션 빌드 제외 — main.tsx가 import.meta.env.DEV일 때만 children에
 * 합류시킨다(routeChildren/ rootRoute.children 참조 동일성은 그대로 유지 → router-config.test 불변).
 * lazy 모듈이라 프로덕션 청크 그래프에 들어가지 않는다(dev 페이지는 coverage/번들에서 제외).
 */
export const devRouteChildren: RouteObject[] = [
  { path: 'dev/typing', lazy: () => import('../pages/dev/TypingDevPage') },
];

/**
 * 루트 라우트 정의만 export하고 createBrowserRouter(...) 호출 자체는 하지 않는다 — 그 호출은
 * router.initialize()를 즉시(모듈 평가 시점에) 실행해 실제 브라우저 history/데이터 라우터
 * 부팅을 트리거하므로, 이 파일을 import하는 순간 부작용이 발생하면 (a) 테스트에서 이 모듈을
 * import하기만 해도 브라우저 환경을 요구하게 되고 (b) 실제 라우터 싱글턴은 앱에 정확히 1개만
 * 있어야 한다(§4.1). 그래서 인스턴스화는 진입점인 main.tsx가 전담한다 — router.tsx는 순수
 * 데이터만 노출해 렌더 없이도 구조를 검증할 수 있게 한다(app/router-config.test.ts).
 */
export const rootRoute: RouteObject = {
  path: '/',
  element: <AppShell />,
  errorElement: <RootErrorBoundary />,
  loader: bootLoader, // countries.json + manifest + 설정 하이드레이션(§8.2)
  children: routeChildren,
};
