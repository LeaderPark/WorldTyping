// spec: docs/00 §6, docs/03 §2·§5 (packages/engine — 프레임워크 독립 게임 엔진 배럴).
// WT-M2-01: 입력 컨트롤러 + 타수 계상기. session/rules 등은 WT-M2-02~03에서 추가.
// React/DOM import 금지(input-controller.ts만 DOM 타입 허용 — eslint no-restricted-imports).

export const ENGINE_PACKAGE_NAME = "@wt/engine" as const;

export { KeystrokeAccountant, type KeystrokeDelta } from "./accountant";
export { TypingInputController, type TypingEvent } from "./input-controller";
