// spec: docs/01 §9.2(업적 24종 — 카테고리별 정의)·§9.3(언락 트리 — "콘텐츠는 잠그지 않는다",
//       숨김 업적 개념 없음)·§9.4(여권/스탬프), docs/06 §4.3(user_unlocks = 서버 권위),
//       docs/00 §11-D68(여권 = 로그인 전용) + WT-PASSPORT-DEV-1
//
// 여권 "업적 도감"의 **표시 전용** 카탈로그다. 판정은 전적으로 서버(workers/api/src/lib/
// achievements.ts)의 몫이고, 이 파일은 그 24개 id를 "항상 전부 그리기" 위한 순서·아이콘만 갖는다.
// 달성 여부의 진실은 GET /users/:id/passport의 unlocks(type==='achievement')뿐이다.
//
// [왜 서버 카탈로그를 import하지 않는가] workers/api는 apps/web의 tsconfig rootDir('src') 밖이고
// D1Database 등 Cloudflare 전역 타입에 의존한다 — 클라 번들/타입체크에 끌고 올 수 없다(커버 목록
// ALL_COVERS가 PassportPage에서 이미 같은 이유로 중복 정의돼 있다). 대신 id 집합 동일성을
// achievements-catalog.test.ts가 서버 소스를 파싱해 대조하며 잠근다 — 서버에 업적이 추가/삭제/
// 개명되면 그 테스트가 즉시 깨진다.
//
// [숨김 업적 없음] docs/01 §9.2·§9.3에 hidden/secret 개념이 없고 서버 카탈로그에도 대응 플래그가
// 없다. 따라서 24종 전부 공개형 — 미달성 상태에서도 이름과 달성 조건을 그대로 노출한다("뭘 하면
// 되는지 보이는" 도감).

/** docs/01 §9.2의 카테고리(서버 ACHIEVEMENTS[].category와 동일 문자열). */
export type AchievementCategory =
  | 'completion'
  | 'skill'
  | 'survival'
  | 'multiplayer'
  | 'consistency'
  | 'easter-egg';

export interface AchievementCatalogEntry {
  /** 서버 lib/achievements.ts의 id와 1:1(user_unlocks.unlock_id는 `ach:{id}` 형태). */
  readonly id: string;
  readonly category: AchievementCategory;
  /** 이모지 1자(이미지 에셋 금지 — entry JS 170KB gzip 예산, CLAUDE.md 성능 예산). */
  readonly icon: string;
}

/** user_unlocks.unlock_id의 업적 프리픽스(docs/06 §4.3 표기 규약 `ach:{id}`). */
export const ACHIEVEMENT_UNLOCK_PREFIX = 'ach:';

/**
 * 도감 표시 순서 = 서버 ACHIEVEMENTS 배열 순서(카테고리별로 이미 뭉쳐 있다). 순서를 바꾸면
 * 대조 테스트는 통과하지만 카테고리 묶음이 흐트러지므로 서버 순서를 그대로 따른다.
 */
export const ACHIEVEMENTS_CATALOG: readonly AchievementCatalogEntry[] = [
  { id: 'first_flight', category: 'completion', icon: '🛬' },
  { id: 'six_continents', category: 'completion', icon: '🌐' },
  { id: 'around_the_world', category: 'completion', icon: '✈️' },
  { id: 'first_daily', category: 'completion', icon: '🌅' },
  { id: 'perfect_run', category: 'skill', icon: '💎' },
  { id: 'speed_demon_500', category: 'skill', icon: '⚡' },
  { id: 'grade_s_all', category: 'skill', icon: '🏅' },
  { id: 'combo_master', category: 'skill', icon: '🔗' },
  { id: 'world_tour_s', category: 'skill', icon: '🌟' },
  { id: 'perfect_marathon', category: 'skill', icon: '🎯' },
  { id: 'tier5_clear', category: 'survival', icon: '🛂' },
  { id: 'no_life_lost', category: 'survival', icon: '🛡️' },
  { id: 'tier_all_clear', category: 'survival', icon: '🗂️' },
  { id: 'first_win', category: 'multiplayer', icon: '🥇' },
  { id: 'win_streak_5', category: 'multiplayer', icon: '🔥' },
  { id: 'win_streak_10', category: 'multiplayer', icon: '👑' },
  { id: 'photo_finish', category: 'multiplayer', icon: '📸' },
  { id: 'multi_veteran', category: 'multiplayer', icon: '⚔️' },
  { id: 'flawless_race', category: 'multiplayer', icon: '✨' },
  { id: 'daily_7', category: 'consistency', icon: '🗓️' },
  { id: 'daily_30', category: 'consistency', icon: '📆' },
  { id: 'daily_100', category: 'consistency', icon: '💯' },
  { id: 'alias_master', category: 'easter-egg', icon: '🧭' },
  { id: 'night_owl', category: 'easter-egg', icon: '🦉' },
];

/** 도감 총 개수(진행 카운트 "n/total"의 분모 — i18n 문자열에 24를 굳히지 않기 위한 단일 원천). */
export const ACHIEVEMENT_TOTAL = ACHIEVEMENTS_CATALOG.length;

/**
 * 업적 id → i18n 키. 카탈로그 id는 snake_case(`speed_demon_500`)지만 i18n 키 규약은
 * `영역.의미[.상세]` 3단계 + 세그먼트당 `[a-zA-Z][a-zA-Z0-9-]*`(밑줄 불가 — packages/i18n
 * src/keys.test.ts가 강제)라, 밑줄을 하이픈으로 바꾼 형태를 쓴다: `achv.speed-demon-500.name`.
 */
export function achievementI18nKey(id: string, part: 'name' | 'desc'): string {
  return `achv.${id.replace(/_/g, '-')}.${part}`;
}

/** PassportRes.unlocks에서 달성한 업적 id 집합을 뽑는다(`ach:` 프리픽스 제거). */
export function unlockedAchievementIds(
  unlocks: readonly { type: string; id: string }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const u of unlocks) {
    if (u.type !== 'achievement') continue;
    out.add(
      u.id.startsWith(ACHIEVEMENT_UNLOCK_PREFIX)
        ? u.id.slice(ACHIEVEMENT_UNLOCK_PREFIX.length)
        : u.id,
    );
  }
  return out;
}
