// spec: docs/00 §5(빌드=Vite^5), docs/03 §1.1, §8.3(코드 스플리팅)·§8.4(PWA/오프라인)·
// §8.5(성능 예산), WT-M0-01, WT-M5-01. /api 프록시는 WT-M3-06 세션 환경 어댑테이션("vite dev
// /api 프록시 허용") — 로컬 개발 시 `wrangler dev`(기본 8787)를 별도로 띄워두면 vite dev(5173)
// 에서도 실 API를 그대로 호출할 수 있다. 프로덕션 등가 검증(E2E)은 이 프록시 없이 `wrangler dev`
// 단일 오리진으로 빌드 산출물을 직접 서빙한다(e2e/playwright.config.ts).
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";

// §8.3 매뉴얼 청크 규약. node_modules 판별은 문자열 매칭이 아니라 실경계(path separator)로
// 구분해 예컨대 "react-flip-move" 같은 무관 패키지가 "react" 매칭에 잘못 걸리지 않게 한다.
const VENDOR_REACT = /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/;
const VENDOR_MOTION = /[\\/]node_modules[\\/](framer-motion)[\\/]/;
// docs §8.3: "d3-geo+topojson(game과 홈 히어로가 공유 → 별도 청크)". d3-geo의 전이 의존(d3-array
// 등)까지 함께 묶어 vendor-react/기본 청크에 흩어지지 않게 한다.
const VENDOR_GEO =
  /[\\/]node_modules[\\/](d3-geo|d3-array|d3-interpolate|topojson-client|topojson-server)[\\/]/;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // §8.4: "새 SW 대기 시 토스트 … 인게임 중에는 유예" — 자동 갱신이 아니라 사용자 확인 후
      // updateServiceWorker()를 호출하는 수동 흐름(AppShell.tsx의 SW 업데이트 토스트).
      registerType: "prompt",
      // dev 서버에서는 SW를 등록하지 않는다 — 로컬 개발 중 캐시 간섭 방지(프로덕션 빌드만 대상,
      // D37 "E2E=프로덕션 등가"와 동일 취지).
      devOptions: { enabled: false },
      // countries.json 등은 이미 manifest.json의 SHA-256 해시로 쿼리 버스팅되므로(§8.2) 별도
      // 파일명 해시는 없다 — workbox의 기본 globPatterns(js/css/html/svg/png/ico 등)에 잡히지
      // 않는 json/woff2/wav 확장자를 precache 대상에 추가로 포함시킨다.
      includeAssets: ["data/*.json", "fonts/*.woff2", "sounds/*"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        // registerType:'prompt'라 skipWaiting은 명시적으로 false 유지(사용자가 토스트에서
        // 새로고침을 눌러야 새 SW가 활성화 — AppShell.tsx SW 업데이트 토스트). 반면
        // clientsClaim은 true — "최초 설치" 시점에는 대기 중인 구버전이 없어 즉시 활성화된
        // SW가 지금 이 탭까지 제어해야 바로 다음 새로고침(오프라인 재진입 포함)부터 정상
        // 동작한다(clientsClaim:false 기본값이면 최초 설치 탭은 다음 "완전히 새로운" 내비게이션
        // 까지 SW 제어 밖에 남아, 그 사이 오프라인 전환 시 브라우저 자체 오프라인 오류 페이지가
        // 뜬다 — verify-pwa-offline.mjs 실측으로 확인).
        skipWaiting: false,
        clientsClaim: true,
        // 앱 셸 라우트(전부 client-side 라우팅) 오프라인 진입 시 index.html로 폴백.
        navigateFallback: "/index.html",
        // /api/*, /ws/*, /r/*, /og/*는 SPA 폴백 대상이 아니다(docs/00 §9 gotcha 6 참조 — 이
        // 경로들은 Worker가 우선 처리한다. SW가 이 경로의 실패 fetch를 index.html로 삼키면
        // 오류가 조용히 삼켜진다).
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//, /^\/r\//, /^\/og\//],
        runtimeCaching: [
          // 리더보드 조회(GET /api/v1/lb, /lb/me)는 아래 catch-all(/api/*=NetworkOnly)보다
          // 먼저 매칭돼야 한다(workbox는 배열 순서상 첫 매치를 채택) — §8.4 "리더보드는
          // NetworkFirst(timeout 3s → 캐시 폴백 + 뱃지)".
          {
            urlPattern: ({ url, request }) =>
              request.method === "GET" && /\/api\/v1\/lb(\/|$)/.test(url.pathname),
            handler: "NetworkFirst",
            options: {
              cacheName: "wt-lb",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 16, maxAgeSeconds: 3600 },
            },
          },
          // 나머지 API 전부(세션/제출/데일리/신고 등) — 절대 캐시하지 않는다(멀티/랭킹 쓰기
          // 캐시 금지 제약, docs/03 §8.4 원문 그대로).
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          // 국가 데이터: manifest.json 해시를 쿼리 키로 쓰므로 불변 캐시 취급이 안전(§8.2).
          {
            urlPattern: ({ url }) => /\/data\/countries(-110m)?\.json$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "wt-countries-data",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: false,
    }),
    // rollup-plugin-visualizer: build 시 항상 리포트 산출(브라우저 자동 오픈은 CI/헤드리스 환경
    // 오작동 방지를 위해 끈다) — PR 첨부용 산출물은 dist/stats.html.
    visualizer({
      filename: fileURLToPath(new URL("./dist/stats.html", import.meta.url)),
      gzipSize: true,
      brotliSize: false,
      open: false,
      template: "treemap",
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 실제 진입 청크(main.tsx 그래프)만 이 이름을 받는다 — size-limit(tooling/ci/size-limit.json)
        // 이 이 패턴으로 "entry" 예산(<170KB gzip, §8.5)을 측정한다.
        entryFileNames: "assets/entry-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks(id) {
          if (VENDOR_REACT.test(id)) return "vendor-react";
          if (VENDOR_MOTION.test(id)) return "vendor-motion";
          if (VENDOR_GEO.test(id)) return "vendor-geo";
          // lazy 라우트(§8.3: game/multi/rank/passport)는 router.tsx의 동적 import 경계가 이미
          // 청크를 분리한다 — 여기서는 그 청크들에 결정적 이름만 부여해 size-limit의 "lazy 청크
          // 제외" 글롭(tooling/ci/size-limit.json)이 안정적으로 매치되게 한다.
          if (id.includes("/src/pages/GamePage/")) return "game";
          if (id.includes("/src/pages/multi/")) return "multi";
          if (id.includes("/src/pages/RankPage/")) return "rank";
          if (id.includes("/src/pages/PassportPage")) return "passport";
          return undefined;
        },
      },
    },
  },
});
