// spec: docs/00 §6 (packages/moderation), docs/06 §4.2, docs/04 §10.2, WT-M1-07, WT-M3-05
//
// 배럴 export. 닉네임 형식(NICK_RE)·정규화와 비속어/예약어 필터(닉네임+채팅 공용)를 노출한다.
//
// 주의(WT-M3-05): 이 배럴은 './filter'를 재-export하므로 node:fs를 top-level에서 실행한다
// (Node 전용). Workers 번들(workers/api)은 이 배럴이 아니라 './engine'을 직접 import해
// createFilter(...)에 빌드타임 스냅샷을 주입한다 — filter.ts 파일 상단 주석 참조.

export { NICK_RE, normalizeNickname } from './nickname';
export {
  buildMatchChannels,
  evaluateText,
  isNicknameAllowed,
  filterChat,
  type MatchChannels,
  type FilterResult,
  type ChatFilterResult,
} from './filter';
export { createFilter, type FilterEngine, type WordLists } from './engine';
