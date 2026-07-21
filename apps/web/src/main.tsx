// spec: docs/00 §6 (apps/web/src/main.tsx), docs/03 §4.1(router)·§8.1(providers), WT-M2-05
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { AppProviders } from "./app/providers";
import { devRouteChildren, rootRoute } from "./app/router";
import "./styles/globals.css";

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

createRoot(rootEl).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
