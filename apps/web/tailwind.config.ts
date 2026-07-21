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
    extend: {},
  },
  plugins: [],
} satisfies Config;
