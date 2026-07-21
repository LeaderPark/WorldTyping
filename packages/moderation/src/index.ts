// spec: docs/00 §6 (packages/moderation — badwords/filter, toJamoSeq 재사용), WT-M0-01
//
// M0 스캐폴드 플레이스홀더. badwords.{ko,en}.txt, allowwords.en.txt, filter.ts는
// 이후 마일스톤(닉네임 모더레이션 관련 태스크)에서 채운다.

export const MODERATION_PACKAGE_NAME = "@wt/moderation" as const;
