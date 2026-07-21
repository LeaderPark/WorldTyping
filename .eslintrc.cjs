// spec: docs/00 §6 (의존 방향 규칙), docs/03 §9(경계 규칙), WT-M0-01
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2022,
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint", "import"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: {
    es2022: true,
    node: true,
    browser: true,
  },
  ignorePatterns: [
    "**/dist/**",
    "**/node_modules/**",
    "**/*.d.ts",
    "apps/web/public/**",
    ".wrangler/**",
  ],
  rules: {
    // 의도적으로 안 쓰는 파라미터(콜백 시그니처 고정 등)는 `_` 접두사로 허용 표시.
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    // packages/* → apps|workers 참조 금지 (docs/00 §6 의존 방향 규칙)
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          {
            target: "./packages",
            from: ["./apps", "./workers"],
            message: "packages/*는 apps/workers를 참조할 수 없다 (docs/00 §6 의존 방향 규칙).",
          },
          {
            // engine ← apps/web만 (workers/api는 engine을 참조할 수 없다)
            target: "./workers",
            from: "./packages/engine",
            message: "packages/engine은 apps/web에서만 참조 가능하다 (docs/00 §6).",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // packages/shared, packages/engine 내 react|react-dom import 금지 (§0.4 절대 금지 4)
      files: ["packages/shared/**/*.{ts,tsx}", "packages/engine/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "react",
                message: "packages/shared, packages/engine은 React에 의존할 수 없다.",
              },
              {
                name: "react-dom",
                message: "packages/shared, packages/engine은 React DOM에 의존할 수 없다.",
              },
            ],
          },
        ],
      },
    },
    {
      // apps/web/src/features/* 상호 직접 참조 금지 (경유: stores/lib)
      files: ["apps/web/src/features/**/*.{ts,tsx}"],
      rules: {
        "import/no-restricted-paths": [
          "error",
          {
            zones: [
              {
                target: "./apps/web/src/features/typing",
                from: "./apps/web/src/features",
                except: ["./typing"],
              },
              {
                target: "./apps/web/src/features/map",
                from: "./apps/web/src/features",
                except: ["./map"],
              },
              {
                target: "./apps/web/src/features/hud",
                from: "./apps/web/src/features",
                except: ["./hud"],
              },
              {
                target: "./apps/web/src/features/result",
                from: "./apps/web/src/features",
                except: ["./result"],
              },
              {
                target: "./apps/web/src/features/multiplayer",
                from: "./apps/web/src/features",
                except: ["./multiplayer"],
              },
              {
                target: "./apps/web/src/features/leaderboard",
                from: "./apps/web/src/features",
                except: ["./leaderboard"],
              },
              {
                target: "./apps/web/src/features/passport",
                from: "./apps/web/src/features",
                except: ["./passport"],
              },
            ],
          },
        ],
      },
    },
  ],
};
