// spec: docs/01 §9.2(업적 24종)·§9.3(언락 트리)·§9.4(커버 12종), docs/06 §4.3(user_unlocks 스키마·
//       서버 권위 판정), docs/00 §11-D2(세계일주=50개국)·§11-D9·§11-D38(user_id=pid) + WT-M5-03
//
// user_unlocks(achievement/cover/stamp/tier)의 유일한 판정기. 클라의 "달성" 신호는 절대 신뢰하지
// 않는다 — 여기 들어오는 입력은 전부 서버가 이미 검증·재계산한 값이다(싱글: runs.ts의
// verifyRun() 결과, 멀티: MatchRoom의 결과 확정 후 ResultRow). 지급은 INSERT OR IGNORE로 멱등
// (PK 충돌 무시, 재시도·재계산 안전).
//
// [24종 확정 목록 — 구현 결정] docs/01 §9.2 표는 15개 id만 예시로 제시하고 나머지 칸은 "같은
// 카테고리 결로 보완"하도록 위임한다(docs/07 WT-M5-03 구현 세부 지시 1). 아래 9개는 이 구현이
// 채운 필러이며 최종 보고 escalations에 그대로 보고한다: first_daily, combo_master,
// world_tour_s, perfect_marathon, tier_all_clear, win_streak_10, multi_veteran, flawless_race,
// night_owl. 나머지 15개(first_flight~alias_master)는 문서 예시 그대로.
//
// [unlock_id 표기 규약] docs/06 §4.3 DDL 주석의 리터럴 예시를 그대로 따른다 — unlock_type 컬럼과
// 별개로 unlock_id 자체에도 종류 프리픽스를 중복 기재한다: 'ach:{id}' / 'cover:{coverId}' /
// 'stamp:{modeKey}:{grade}' / 'tier:{n}'.
import type { CountryId } from "@wt/shared";
import { normalizeKo, normalizeEn } from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import type { UnlockType } from "../db/types";

const COUNTRY_BY_ID: ReadonlyMap<CountryId, (typeof COUNTRIES)[number]> = new Map(
  COUNTRIES.map((c) => [c.id, c]),
);

/** 코드 상수로 고정한 24종 업적(테스트가 이 목록 길이=24를 고정 검증한다). */
export const ACHIEVEMENTS = [
  { id: "first_flight", category: "completion" },
  { id: "six_continents", category: "completion" },
  { id: "around_the_world", category: "completion" },
  { id: "first_daily", category: "completion" },
  { id: "perfect_run", category: "skill" },
  { id: "speed_demon_500", category: "skill" },
  { id: "grade_s_all", category: "skill" },
  { id: "combo_master", category: "skill" },
  { id: "world_tour_s", category: "skill" },
  { id: "perfect_marathon", category: "skill" },
  { id: "tier5_clear", category: "survival" },
  { id: "no_life_lost", category: "survival" },
  { id: "tier_all_clear", category: "survival" },
  { id: "first_win", category: "multiplayer" },
  { id: "win_streak_5", category: "multiplayer" },
  { id: "win_streak_10", category: "multiplayer" },
  { id: "photo_finish", category: "multiplayer" },
  { id: "multi_veteran", category: "multiplayer" },
  { id: "flawless_race", category: "multiplayer" },
  { id: "daily_7", category: "consistency" },
  { id: "daily_30", category: "consistency" },
  { id: "daily_100", category: "consistency" },
  { id: "alias_master", category: "easter-egg" },
  { id: "night_owl", category: "easter-egg" },
] as const;

export type AchievementId = (typeof ACHIEVEMENTS)[number]["id"];

/** 커버 12종(docs/01 §9.4). 시즌 한정 1종은 v1 미지급 예약 — 여기 목록에 넣지 않는다(그랜트 대상
 *  11종만). 'basic-green'은 가입 시 기본 지급(users.passport_cover 디폴트)이라 unlock 테이블에
 *  올리지 않는다(별도 그랜트 불필요). */
export const GRANTABLE_COVERS = [
  "continent-asia",
  "continent-europe",
  "continent-africa",
  "continent-north-america",
  "continent-south-america",
  "continent-oceania",
  "gold",
  "hologram",
  "streak-30",
  "streak-100",
] as const;

interface Grant {
  type: UnlockType;
  id: string;
  meta?: Record<string, unknown>;
}

/** INSERT OR IGNORE 배치 실행 후 실제로 삽입된(=새로 획득한) unlock_id만 골라 반환한다. */
async function insertUnlocksIfNew(
  db: D1Database,
  userId: string,
  grants: readonly Grant[],
  now: number,
): Promise<string[]> {
  if (grants.length === 0) return [];
  const stmts = grants.map((g) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO user_unlocks (user_id, unlock_type, unlock_id, meta_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(userId, g.type, g.id, g.meta ? JSON.stringify(g.meta) : null, now),
  );
  const results = await db.batch(stmts);
  const granted: string[] = [];
  results.forEach((r, i) => {
    if ((r.meta?.changes ?? 0) > 0) granted.push(grants[i]!.id);
  });
  return granted;
}

// ───────────────────────── 싱글 런 판정 ─────────────────────────

export interface RunAchievementServerValues {
  completed: boolean;
  grade: string;
  cpm: number;
  maxCombo: number;
}

export interface RunAchievementPerCountry {
  code: CountryId;
  skipped: boolean;
  inputUsed: string;
}

export interface SingleRunAchievementInput {
  userId: string;
  /** 'continent:{continent}' | 'tier:{1..5}' | 'worldtour' | 'daily:{dateKst}' */
  modeKey: string;
  lang: "ko" | "en";
  server: RunAchievementServerValues;
  totalKeystrokes: number;
  correctKeystrokes: number;
  livesLost: number;
  perCountry: readonly RunAchievementPerCountry[];
  /** runs.ts가 이미 판정한 "이 날짜 첫 정식 데일리 제출" 플래그 — 재계산하지 않고 그대로 재사용. */
  isDailyFirstValid: boolean;
  now: number;
}

/** 별칭(별명) 입력으로 클리어한 국가 수(이스터에그 alias_master, 단판 기준 — 구현 결정 참조). */
function countAliasClears(perCountry: readonly RunAchievementPerCountry[], lang: "ko" | "en"): number {
  let n = 0;
  for (const p of perCountry) {
    if (p.skipped) continue;
    const country = COUNTRY_BY_ID.get(p.code);
    if (!country) continue;
    const canonical = lang === "ko" ? country.nameKo : country.nameEn;
    const normInput = lang === "ko" ? normalizeKo(p.inputUsed) : normalizeEn(p.inputUsed);
    const normCanonical = lang === "ko" ? normalizeKo(canonical) : normalizeEn(canonical);
    if (normInput !== normCanonical) n += 1;
  }
  return n;
}

/** epoch ms → KST 시(0~23). 자정~새벽 1시 이스터에그(night_owl) 판정 전용 — kst.ts의 날짜 산술과
 *  동일 원칙(UTC+9 오프셋 산술, 로컬 타임존 의존 금지)만 시(hour) 단위로 축약해 여기 인라인한다. */
function kstHour(nowMs: number): number {
  return new Date(nowMs + 9 * 60 * 60 * 1000).getUTCHours();
}

/**
 * 싱글 런 제출 후(runs.ts — verdict='valid' 확정, runs INSERT가 이미 커밋된 뒤) 호출한다.
 * mode_key/grade/completed 등 집계 쿼리는 이 함수 호출 시점에 이미 이번 판이 runs 테이블에
 * 반영돼 있다는 전제(호출부 책임)로 짠다 — "과거 기록 + 이번 판" 조합을 매번 손으로 더할 필요가
 * 없어진다.
 */
export async function evaluateRunAchievements(
  db: D1Database,
  input: SingleRunAchievementInput,
): Promise<string[]> {
  const { userId, modeKey, server, now } = input;
  const grants: Grant[] = [];

  if (server.completed) {
    grants.push({ type: "achievement", id: "ach:first_flight" });

    // 스탬프는 고정 12노선(대륙 6 + 티어 5 + 세계일주 1)만 발급 — 데일리/멀티는 대상 밖(구현 결정,
    // 최종 보고 escalations 참조. 무한정 누적되는 stamp 로우를 막기 위함).
    if (modeKey.startsWith("continent:") || modeKey.startsWith("tier:") || modeKey === "worldtour") {
      grants.push({ type: "stamp", id: `stamp:${modeKey}:${server.grade}`, meta: { completedAt: now } });
    }

    if (modeKey.startsWith("continent:")) {
      const n = await countDistinct(db, userId, "continent:%", { completedOnly: true });
      if (n >= 6) grants.push({ type: "achievement", id: "ach:six_continents" });

      const continentName = modeKey.slice("continent:".length);
      grants.push({ type: "cover", id: `cover:continent-${continentName}` });

      const sN = await countDistinct(db, userId, "continent:%", { completedOnly: true, grade: "S" });
      if (sN >= 6) {
        grants.push({ type: "achievement", id: "ach:grade_s_all" });
        grants.push({ type: "cover", id: "cover:gold" });
      }
    }

    if (modeKey.startsWith("tier:")) {
      const tierNo = modeKey.slice("tier:".length);
      grants.push({ type: "tier", id: `tier:${tierNo}` });
      if (modeKey === "tier:5") grants.push({ type: "achievement", id: "ach:tier5_clear" });
      if (input.livesLost === 0) grants.push({ type: "achievement", id: "ach:no_life_lost" });

      const tN = await countDistinct(db, userId, "tier:%", { completedOnly: true });
      if (tN >= 5) grants.push({ type: "achievement", id: "ach:tier_all_clear" });
    }

    if (modeKey === "worldtour") {
      grants.push({ type: "achievement", id: "ach:around_the_world" });
      grants.push({ type: "cover", id: "cover:hologram" });
      if (server.grade === "S") grants.push({ type: "achievement", id: "ach:world_tour_s" });
      if (input.totalKeystrokes === input.correctKeystrokes) {
        grants.push({ type: "achievement", id: "ach:perfect_marathon" });
      }
    }

    if (input.totalKeystrokes === input.correctKeystrokes) {
      grants.push({ type: "achievement", id: "ach:perfect_run" });
    }

    if (input.isDailyFirstValid) {
      grants.push({ type: "achievement", id: "ach:first_daily" });
    }

    if (kstHour(now) < 1) {
      grants.push({ type: "achievement", id: "ach:night_owl" });
    }
  }

  // 완주 여부와 무관한 순간 성능 지표(실력 카테고리 — docs 예시가 "완주"를 명시하지 않음).
  if (server.cpm >= 500) grants.push({ type: "achievement", id: "ach:speed_demon_500" });
  if (server.maxCombo >= 50) grants.push({ type: "achievement", id: "ach:combo_master" });

  const aliasClears = countAliasClears(input.perCountry, input.lang);
  if (aliasClears >= 20) grants.push({ type: "achievement", id: "ach:alias_master" });

  const newlyGranted = await insertUnlocksIfNew(db, userId, grants, now);

  // 데일리 스트릭 업적/커버(꾸준함) — streak_daily는 같은 요청의 앞선 db.batch(streakStmt)가 이미
  // 커밋한 뒤라 이 시점의 SELECT가 최신값이다(runs.ts 호출 순서 계약).
  if (input.isDailyFirstValid) {
    const row = await db
      .prepare(`SELECT streak_daily FROM users WHERE user_id = ?1`)
      .bind(userId)
      .first<{ streak_daily: number }>();
    const streak = row?.streak_daily ?? 0;
    const streakGrants: Grant[] = [];
    if (streak >= 7) streakGrants.push({ type: "achievement", id: "ach:daily_7" });
    if (streak >= 30) {
      streakGrants.push({ type: "achievement", id: "ach:daily_30" });
      streakGrants.push({ type: "cover", id: "cover:streak-30" });
    }
    if (streak >= 100) {
      streakGrants.push({ type: "achievement", id: "ach:daily_100" });
      streakGrants.push({ type: "cover", id: "cover:streak-100" });
    }
    newlyGranted.push(...(await insertUnlocksIfNew(db, userId, streakGrants, now)));
  }

  return newlyGranted;
}

interface CountOpts {
  completedOnly?: boolean;
  grade?: string;
}

async function countDistinct(
  db: D1Database,
  userId: string,
  modeKeyLike: string,
  opts: CountOpts,
): Promise<number> {
  const conditions = ["user_id = ?1", "verdict = 'valid'", "mode_key LIKE ?2"];
  const binds: unknown[] = [userId, modeKeyLike];
  if (opts.completedOnly) conditions.push("completed = 1");
  if (opts.grade) {
    conditions.push(`grade = ?${binds.length + 1}`);
    binds.push(opts.grade);
  }
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT mode_key) AS n FROM runs WHERE ${conditions.join(" AND ")}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ───────────────────────── 멀티 판정(MatchRoom persistResults 성공 후) ─────────────────────────

/** 우승자-준우승자 격차 판정(§5.1-4 broadcastPlayerFinished의 photoFinish 규칙과 동일 1000ms
 *  임계 — "이내"이므로 정확히 1000ms도 포함). MatchRoom과 테스트가 공유하는 순수 함수. */
export function isPhotoFinishWin(winnerElapsedMs: number, runnerUpElapsedMs: number): boolean {
  return runnerUpElapsedMs - winnerElapsedMs <= 1000;
}

export interface MatchAchievementInput {
  userId: string;
  rank: number;
  finished: boolean;
  errorKeystrokes: number;
  /** 이번 매치에서 우승자가 2위와 1000ms 이내로 격차 승리했는지(호출부가 계산 — §5.1 photoFinish
   *  판정과 동일 규칙). 우승자(rank===1)에게만 의미 있다. */
  photoFinishWin: boolean;
}

/**
 * 실제 계정(비게스트) 참가자만 호출 대상이다 — 게스트 playerId는 users 테이블 FK가 없어 여기
 * 넘기면 INSERT가 깨진다(호출부 MatchRoom이 isGuest===false만 필터링해 넘겨야 한다).
 */
export async function evaluateMatchAchievements(
  db: D1Database,
  players: readonly MatchAchievementInput[],
  now: number,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const p of players) {
    const grants: Grant[] = [];
    if (p.finished && p.rank === 1) {
      grants.push({ type: "achievement", id: "ach:first_win" });
      if (p.errorKeystrokes === 0) grants.push({ type: "achievement", id: "ach:flawless_race" });
      if (p.photoFinishWin) grants.push({ type: "achievement", id: "ach:photo_finish" });

      const streak = await currentWinStreak(db, p.userId);
      if (streak >= 5) grants.push({ type: "achievement", id: "ach:win_streak_5" });
      if (streak >= 10) grants.push({ type: "achievement", id: "ach:win_streak_10" });
    }

    const veteranCount = await db
      .prepare(`SELECT COUNT(*) AS n FROM match_participants WHERE player_id = ?1 AND finished = 1`)
      .bind(p.userId)
      .first<{ n: number }>();
    if ((veteranCount?.n ?? 0) >= 10) grants.push({ type: "achievement", id: "ach:multi_veteran" });

    out[p.userId] = await insertUnlocksIfNew(db, p.userId, grants, now);
  }
  return out;
}

/**
 * 가장 최근 매치부터 거슬러 올라가며 연속 1위(finished=1 && rank=1) 횟수를 센다(win_streak_5/10
 * 경계 판정 — 연승이 끊긴 시점에서 멈춘다). 이번 매치 자체도 match_participants에 이미 커밋된
 * 뒤 호출된다는 전제(호출부 계약, evaluateRunAchievements와 동일 원칙).
 */
async function currentWinStreak(db: D1Database, userId: string): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT mp.rank AS rank, mp.finished AS finished
         FROM match_participants mp
         JOIN matches m ON m.id = mp.match_id
        WHERE mp.player_id = ?1
        ORDER BY m.finished_at DESC
        LIMIT 20`,
    )
    .bind(userId)
    .all<{ rank: number; finished: 0 | 1 }>();
  let streak = 0;
  for (const row of results) {
    if (row.finished === 1 && row.rank === 1) streak += 1;
    else break;
  }
  return streak;
}
