// spec: docs/00 §6 (packages/shared — 클라·서버 공유 단일 원천), WT-M0-01
//
// M0 스캐폴드 단계 플레이스홀더. 실제 country-matcher/scoring/protocol/auth 구현은
// WT-M1-01~04에서 채운다. 의존성 0, React/DOM import 금지(eslint로 강제).

export const SHARED_PACKAGE_NAME = "@wt/shared" as const;
