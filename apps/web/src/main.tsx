// spec: docs/00 §6 (apps/web/src/main.tsx), docs/03 §4.1(router)·§8.1(providers), WT-M2-05
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { AppProviders } from "./app/providers";
import { devRouteChildren, rootRoute } from "./app/router";
import { consumeAuthRedirect } from "./features/auth/authcode-boot";
// tokens.css: 색 토큰(대륙/등급/지도 상태색) + 지도 레이어 스타일(WT-M2-04). globals.css보다 먼저
// 로드해 CSS 변수를 선언한다(globals.css의 --wt-prompt-* 폴백은 그대로 유지).
import "./styles/tokens.css";
import "./styles/globals.css";

// [WT-AUTH-REDIRECT] GIS ux_mode:'redirect' 착지 처리. authcode/authError 쿼리가 없으면 즉시
// no-op이다. **createBrowserRouter보다 먼저** 호출한다 — 이 함수의 동기 구간이 자격증명성 쿼리를
// history.replaceState로 제거하므로, 라우터가 애초에 깨끗한 URL을 초기 location으로 잡는다.
// 코드 교환(네트워크)은 그 뒤 비동기로 이어지고 성공 시 auth 스토어가 갱신된다 — 부팅을 막지
// 않으므로 await하지 않는다.
void consumeAuthRedirect();

// 실제 브라우저 히스토리에 연결된 라우터 싱글턴은 여기서만 만든다(router.tsx는 순수 route
// 정의만 export — 이유는 그 파일 주석 참조). DEV에서만 /dev/* 진단 라우트를 합류시킨다 —
// rootRoute 객체 자체는 건드리지 않아 router-config.test의 참조 동일성 계약이 유지된다.
// (RouteObject는 index/non-index 판별 유니온이라 스프레드 결과에 명시 캐스트가 필요하다.)
const augmentedRoot: RouteObject = import.meta.env.DEV
  ? ({ ...rootRoute, children: [...(rootRoute.children ?? []), ...devRouteChildren] } as RouteObject)
  : rootRoute;
const router = createBrowserRouter([augmentedRoot]);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element not found");
}

// D48(docs/00 §11-D48, WT-M5-01d): index.html의 정적 크리티컬 셸(D47)과 React 첫 커밋이
// 같은 프레임에 몰리면 브라우저가 둘을 하나의 페인트로 합쳐 정적 셸이 "독립 페인트"로 기록되지
// 않는다(실측: 로컬 Lighthouse가 2490/2640ms 바이모달로 갈렸다 — 레이스 재현). rAF 콜백은 다음
// 페인트 직전에 실행되므로, 마운트를 한 프레임 미루면 그 사이 브라우저가 이미 그려둔 정적 셸을
// 별도 프레임으로 커밋할 기회가 생긴다. D47의 "React 마운트 시 자연 대체"는 유지하되 그 교체
// 타이밍만 미루는 것 — 정적 셸의 마크업·게이트 배선 스크립트(index.html)는 변경 없음.
//
// 실측(WT-M5-01d): 단일 rAF는 5/5 실행이 전부 2640ms로 개선 없음 — D48 문구대로 double-rAF로
// 승격했고, 이후 10회 실행에서 1860~2640ms 분포(중앙값은 개선되었으나 2640ms 재발 4/10)로
// 바이모달이 완전히는 해소되지 않았다. D48이 이 잔여 가능성을 명시적으로 예견해 트레이스 근거
// 보고를 지시했으므로 그 경로를 따른다(최종 보고 escalations) — 그럼에도 double-rAF를
// single-rAF/무지연 대비 개선이라 유지한다.
//
// bootLoader(라우터 루트 loader)는 createBrowserRouter(...) 호출 시점에 이미 시작되므로(위),
// 이 지연은 데이터 페치를 늦추지 않는다 — 늦춰지는 건 React의 첫 DOM 커밋뿐이다. 정적 셸의
// 언어 게이트 클릭 배선도 index.html 자체 스크립트가 처리하므로(hasChosenLanguage 상태를
// React 마운트 전에 이미 localStorage에 기록) rAF 지연 창 안에 클릭이 들어와도 React가 나중에
// 마운트되며 그 상태를 그대로 읽어 이중 게이트 없이 일관되게 이어받는다.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    createRoot(rootEl).render(
      <StrictMode>
        <AppProviders>
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>,
    );
  });
});
