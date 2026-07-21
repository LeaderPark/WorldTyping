// spec: docs/00 §6 (packages/moderation), docs/06 §4.2, docs/04 §10.2, WT-M1-07
//
// 배럴 export. 닉네임 형식(NICK_RE)·정규화와 비속어/예약어 필터(닉네임+채팅 공용)를 노출한다.

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
