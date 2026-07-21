// spec: docs/03 §7.1(브레이크포인트), §8.1(테마 토큰) — WT-M0-01 선언만, 토큰 확장은 이후 마일스톤
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
      // 폰트 자산 확보는 M5(세션 환경 어댑테이션, 리드 사전 승인) — 지금은 시스템 폰트 스택
      // 폴백만 지정한다. Pretendard Variable/JetBrains Mono 파일이 추가되면 이 이름 그대로
      // @font-face만 등록하면 되도록 이름을 먼저 고정해둔다(docs/03 §8.2).
      fontFamily: {
        sans: [
          "Pretendard Variable",
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
