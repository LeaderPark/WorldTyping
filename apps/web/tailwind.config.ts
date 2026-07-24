// spec: docs/03 §7.1(브레이크포인트), §8.1(테마 토큰), docs/00 §11-D57·D58 — WT-M0-01 선언 +
// WT-UI-01(라이트 기본 전환, tokens.css 시맨틱 토큰의 Tailwind var() 매핑, Pretendard 서브셋).
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    screens: {
      sm: "640px",
      lg: "1024px",
    },
    extend: {
      // tokens.css 시맨틱 토큰의 var() 매핑(WT-UI-01) — 유틸리티(bg-bg, text-text-muted 등)가
      // CSS 커스텀 프로퍼티를 그대로 참조하므로, [data-theme='dark']에 따라 값이 반전될 때
      // Tailwind dark: 변형 없이도 자동으로 테마에 맞는 색이 적용된다(토큰이 이미 테마를 안다).
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-sunken": "var(--surface-sunken)",
        "surface-console": "var(--surface-console)",
        text: "var(--text)",
        "text-muted": "var(--text-muted)",
        border: "var(--border)",
        accent: "var(--accent)",
        // WT-CH-05(docs/09 §8.7, 00 §11-D90~D97) — chase 디자인 토큰 6종 중 Tailwind 유틸리티로
        // 소비 가능한 색 5개(+AA 텍스트 파생 2개). --chase-danger-vignette는 rgb 트리플릿(alpha
        // 합성 전용, tokens.css .wt-chase__vignette 참조)이라 단일 색 유틸로 의미가 없어 제외한다.
        "chase-siren-red": "var(--chase-siren-red)",
        "chase-siren-red-text": "var(--chase-siren-red-text)",
        "chase-siren-blue": "var(--chase-siren-blue)",
        "chase-gold": "var(--chase-gold)",
        "chase-gold-text": "var(--chase-gold-text)",
        "chase-paper": "var(--chase-paper)",
        "chase-trail-police": "var(--chase-trail-police)",
      },
      borderRadius: {
        card: "var(--radius-card)",
        tile: "var(--radius-tile)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        float: "var(--shadow-float)",
      },
      // WT-UI-01(D58): Pretendard 서브셋(400/700) self-host — tooling/scripts/build-web-fonts.mjs
      // 산출물(apps/web/public/fonts/pretendard-subset-{400,700}.woff2), globals.css @font-face.
      // JetBrains Mono는 기존 그대로.
      fontFamily: {
        sans: [
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Malgun Gothic",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
