// spec: docs/00 §5(빌드=Vite^5), docs/03 §1.1, WT-M0-01. /api 프록시는 WT-M3-06 세션 환경
// 어댑테이션("vite dev /api 프록시 허용") — 로컬 개발 시 `wrangler dev`(기본 8787)를 별도로
// 띄워두면 vite dev(5173)에서도 실 API를 그대로 호출할 수 있다. 프로덕션 등가 검증(E2E)은
// 이 프록시 없이 `wrangler dev` 단일 오리진으로 빌드 산출물을 직접 서빙한다(e2e/playwright.config.ts).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
