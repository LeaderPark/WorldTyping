// spec: docs/00 §6 (apps/web/src/main.tsx), docs/03 §4.1(router)·§8.1(providers), WT-M2-05
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppProviders } from "./app/providers";
import { rootRoute } from "./app/router";
import "./styles/globals.css";

// 실제 브라우저 히스토리에 연결된 라우터 싱글턴은 여기서만 만든다(router.tsx는 순수 route
// 정의만 export — 이유는 그 파일 주석 참조).
const router = createBrowserRouter([rootRoute]);

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
