// spec: docs/03 §8.4(PWA/오프라인), WT-M5-01. vite-plugin-pwa의 가상 모듈 타입 선언 — 이 파일이
// 없으면 AppShell.tsx의 `import { useRegisterSW } from 'virtual:pwa-register/react'`가
// typecheck에서 "모듈을 찾을 수 없음"으로 실패한다(가상 모듈이라 실제 파일이 없다).
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />
