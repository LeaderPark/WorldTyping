// spec: docs/00 §6, docs/03 §5 (packages/engine — 프레임워크 독립 게임 엔진), WT-M0-01
//
// M0 스캐폴드 플레이스홀더. session.ts/input-controller.ts/accountant.ts/rules 등은
// WT-M2-01~03에서 채운다. React/DOM import 금지(input-controller.ts만 DOM 타입 허용 예정,
// eslint import/no-restricted-paths + no-restricted-imports로 강제).

export const ENGINE_PACKAGE_NAME = "@wt/engine" as const;
