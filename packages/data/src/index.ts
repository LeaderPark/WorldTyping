// spec: docs/00 §6 (packages/data — 콘텐츠 데이터, 빌드타임에 shared 의존), WT-M0-01
//
// M0 스캐폴드 플레이스홀더. overrides/*.json, content/routes.ts, src/generated/countries.ts
// (build:data 산출물)는 WT-M1-05/06에서 채운다. 산출물은 손편집 금지.

export const DATA_PACKAGE_NAME = "@wt/data" as const;
