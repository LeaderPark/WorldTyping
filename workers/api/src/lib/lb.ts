// spec: docs/06 §1.1(board_key 4차원)·§1.2(랭킹 키)·§1.3(튜플 비교 UPSERT 전문)·§1.4(keyset 조회·
//       rank-of-me COUNT)·§1.5(KV top-100 캐시 + cron), docs/00 §11-D9(06 canonical)·§11-D15(v1
//       period=daily/weekly/alltime, s:는 seasons 행이 있을 때만)·§11-D24(1분 dirty + 단일 KV lb:)
//
// 리더보드 UPSERT·조회·캐시의 단일 원천. 라우트(routes/lb.ts)·제출 경로(routes/runs.ts)·크론
// (cron/lb-refresher.ts)이 전부 이 모듈의 SQL/헬퍼를 공유해 "어떤 경로로 조회해도 동일 순위"
// 불변식(§1.2)을 코드 한 곳에서 보장한다. 정렬 컬럼·방향은 §1.2 랭킹 키 하나뿐이며, 모든
// 순위 SQL에 "// ranking key: docs/06 §1.2" 주석을 단다.
//
// 활성 유저 필터: 조회·순위·total 전부 `u.status='active'`로 통일한다. §1.4-②의 total 예시는
// JOIN 없는 `COUNT(*)`지만, rank는 active로 필터하므로 total도 동일 필터를 써야 percentile
// (rank/total)이 일관된다(교차 경로 동일 순위 불변식 우선 — 최종 보고 escalations 참조).
// shadowban 유저는 애초에 lb_best에 UPSERT되지 않으므로(§3.5) 실무 차이는 거의 없다.
import { KV_KEYS } from "./kv-keys";
import { kstDate, kstIsoWeek } from "./kst";

/** API 한 페이지 크기(§1.4-① LIMIT 51 = 50 + hasNext 판별 1). */
export const LB_PAGE_SIZE = 50;
/** KV 캐시에 담는 상위 N(§1.5). */
export const LB_CACHE_TOP_N = 100;
/** 제출 핸들러가 남기는 dirty 마킹 TTL(§1.5 — 180s). */
export const DIRTY_TTL_SEC = 180;

/** 싱글 모드 12종(§1.1 modeKey). daily/multi는 period 규칙이 달라 별도 취급. */
export const SINGLE_MODE_KEYS: readonly string[] = [
  "continent:asia",
  "continent:europe",
  "continent:africa",
  "continent:north-america",
  "continent:south-america",
  "continent:oceania",
  "tier:1",
  "tier:2",
  "tier:3",
  "tier:4",
  "tier:5",
  "worldtour",
] as const;

const LANGS = ["ko", "en"] as const;
const PLATFORMS = ["desktop", "mobile"] as const;

/** §1.2 랭킹 키 튜플. keyset 커서·rank-of-me 비교의 단일 단위. */
export interface RankTuple {
  score: number;
  elapsedMs: number;
  accMilli: number;
  achievedAt: number;
}

/** 조회 응답 1행(렌더 필드 denormalized — 닉네임/커버 포함, §1.5). */
export interface LbEntry {
  rank: number;
  userId: string;
  nickname: string;
  passportCover: string;
  score: number;
  elapsedMs: number;
  accMilli: number;
  achievedAt: number;
}

/** KV `lb:{board}` 값 스키마(§1.5). metadata에도 {builtAt,total}을 중복 저장. */
export interface LbCacheValue {
  entries: LbEntry[];
  total: number;
  builtAt: number;
}

interface LbRow {
  user_id: string;
  nickname: string;
  passport_cover: string;
  score: number;
  elapsed_ms: number;
  acc_milli: number;
  achieved_at: number;
}

// ───────────────────────── board_key 조립(§1.1) ─────────────────────────

/** `{modeKey}|{lang}|{platform}|{periodKey}` 직렬화(§1.1). */
export function buildBoardKey(modeKey: string, lang: string, platform: string, periodKey: string): string {
  return `${modeKey}|${lang}|${platform}|${periodKey}`;
}

/** all-time 보드 키(제출 응답 rank 인라인·콜드 리프레시의 기준 보드). */
export function allBoardKey(modeKey: string, lang: string, platform: string): string {
  return buildBoardKey(modeKey, lang, platform, "all");
}

export interface BoardKeysInput {
  modeKey: string;
  lang: string;
  platform: string;
  now: number;
  /** seasons 테이블의 활성 시즌 periodKey('s:...'). 없으면 s: 보드 미생성(§11-D15). */
  activeSeasonPeriod?: string | null;
}

/**
 * 이 run이 갱신해야 할 board_key 목록(§1.3 write 경로). daily는 날짜가 이미 modeKey에 있어
 * periodKey='all' 하나뿐(§1.1 예외). 그 외 싱글은 all + 오늘(d:) + 이번 주(w:) + 활성 시즌(s:).
 */
export function boardKeysForRun(input: BoardKeysInput): string[] {
  const { modeKey, lang, platform, now } = input;
  if (modeKey.startsWith("daily:")) {
    return [buildBoardKey(modeKey, lang, platform, "all")];
  }
  const periods = ["all", `d:${kstDate(now)}`, `w:${kstIsoWeek(now)}`];
  if (input.activeSeasonPeriod) periods.push(input.activeSeasonPeriod);
  return periods.map((p) => buildBoardKey(modeKey, lang, platform, p));
}

/** 콜드(alltime) 보드 전량 — 더티 여부와 무관하게 10분 주기 리프레시(§1.5-③ 닉네임 반영). */
export function coldAlltimeBoardKeys(): string[] {
  const out: string[] = [];
  for (const modeKey of SINGLE_MODE_KEYS) {
    for (const lang of LANGS) {
      for (const platform of PLATFORMS) {
        out.push(buildBoardKey(modeKey, lang, platform, "all"));
      }
    }
  }
  return out;
}

/**
 * board_key 형식 검증(§1.1). 임의 문자열이 KV 백필/조회로 흘러들어 키 공간을 오염시키는 걸
 * 막는다. 4파트(modeKey|lang|platform|periodKey) + 각 파트 화이트리스트 패턴.
 */
const MODEKEY_RE =
  /^(continent:(asia|europe|africa|north-america|south-america|oceania)|tier:[1-5]|worldtour|multi|daily:\d{4}-\d{2}-\d{2})$/;
const PERIOD_RE = /^(all|d:\d{4}-\d{2}-\d{2}|w:\d{4}-W\d{2}|s:[a-z0-9:-]{1,32})$/;

export function isValidBoardKey(boardKey: string): boolean {
  const parts = boardKey.split("|");
  if (parts.length !== 4) return false;
  // length===4 검증 후이므로 기본값은 실제로 트리거되지 않음(noUncheckedIndexedAccess 대응).
  const [modeKey = "", lang = "", platform = "", period = ""] = parts;
  if (!MODEKEY_RE.test(modeKey)) return false;
  if (lang !== "ko" && lang !== "en") return false;
  if (platform !== "desktop" && platform !== "mobile") return false;
  if (!PERIOD_RE.test(period)) return false;
  // daily 보드는 period='all'만 유효(§1.1 예외).
  if (modeKey.startsWith("daily:") && period !== "all") return false;
  return true;
}

// ───────────────────────── UPSERT(§1.3 튜플 비교 전문) ─────────────────────────

export interface UpsertBestArgs {
  boardKeys: string[];
  userId: string;
  runId: string;
  score: number;
  elapsedMs: number;
  accMilli: number;
  achievedAt: number;
  geo: string | null;
  /** daily 보드는 "첫 정식 기록 1개"라 ON CONFLICT DO NOTHING(§2.3). */
  isDaily: boolean;
}

/**
 * lb_best 배치 UPSERT 문 생성(§1.3). 제출 핸들러가 runs INSERT와 같은 db.batch()에 넣어
 * 단일 트랜잭션으로 반영한다. 비-daily는 튜플 비교 WHERE로 "더 좋은 기록일 때만" 갱신,
 * daily는 DO NOTHING.
 */
export function upsertBestStmts(db: D1Database, a: UpsertBestArgs): D1PreparedStatement[] {
  const conflict = a.isDaily
    ? "ON CONFLICT (board_key, user_id) DO NOTHING"
    : // ranking key: docs/06 §1.2 — excluded(신규)가 기존보다 사전식으로 더 좋을 때만 갱신.
      `ON CONFLICT (board_key, user_id) DO UPDATE SET
         run_id=excluded.run_id, score=excluded.score, elapsed_ms=excluded.elapsed_ms,
         acc_milli=excluded.acc_milli, achieved_at=excluded.achieved_at, geo=excluded.geo
       WHERE (excluded.score, -excluded.elapsed_ms, excluded.acc_milli, -excluded.achieved_at)
           > (lb_best.score, -lb_best.elapsed_ms, lb_best.acc_milli, -lb_best.achieved_at)`;
  const sql = `INSERT INTO lb_best (board_key, user_id, run_id, score, elapsed_ms, acc_milli, achieved_at, geo)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ${conflict}`;
  return a.boardKeys.map((bk) =>
    db
      .prepare(sql)
      .bind(bk, a.userId, a.runId, a.score, a.elapsedMs, a.accMilli, a.achievedAt, a.geo),
  );
}

// ───────────────────────── cursor 코덱(base64url JSON) ─────────────────────────

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** 커서 = 마지막 행의 랭킹 키 튜플(§1.4-①). base64url(JSON). */
export function encodeCursor(t: RankTuple): string {
  return b64urlEncode(JSON.stringify({ s: t.score, e: t.elapsedMs, a: t.accMilli, t: t.achievedAt }));
}

/** 잘못된/변조된 커서는 null(라우트가 400으로 매핑). */
export function decodeCursor(raw: string): RankTuple | null {
  let obj: unknown;
  try {
    obj = JSON.parse(b64urlDecode(raw));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const nums = [o.s, o.e, o.a, o.t];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { score: o.s as number, elapsedMs: o.e as number, accMilli: o.a as number, achievedAt: o.t as number };
}

// ───────────────────────── D1 조회(§1.4) ─────────────────────────

function rowToEntry(r: LbRow, rank: number): LbEntry {
  return {
    rank,
    userId: r.user_id,
    nickname: r.nickname,
    passportCover: r.passport_cover,
    score: r.score,
    elapsedMs: r.elapsed_ms,
    accMilli: r.acc_milli,
    achievedAt: r.achieved_at,
  };
}

/** 활성 유저 기준 보드 총원(§1.4-② total, active 필터로 통일 — 파일 상단 주석 참조). */
export async function boardTotal(db: D1Database, boardKey: string, geo?: string | null): Promise<number> {
  const geoClause = geo ? "AND b.geo = ?2" : "";
  const stmt = db
    .prepare(
      `SELECT COUNT(*) AS n FROM lb_best b JOIN users u USING (user_id)
       WHERE b.board_key = ?1 AND u.status = 'active' ${geoClause}`,
    )
    .bind(...(geo ? [boardKey, geo] : [boardKey]));
  const row = await stmt.first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 튜플보다 사전식으로 "더 좋은" 행 수(§1.4-② rank = 이 값 + 1). */
export async function countBetter(
  db: D1Database,
  boardKey: string,
  t: RankTuple,
  geo?: string | null,
): Promise<number> {
  const geoClause = geo ? "AND b.geo = ?6" : "";
  // ranking key: docs/06 §1.2
  const sql = `SELECT COUNT(*) AS n FROM lb_best b JOIN users u USING (user_id)
     WHERE b.board_key = ?1 AND u.status = 'active'
       AND (b.score, -b.elapsed_ms, b.acc_milli, -b.achieved_at) > (?2, -?3, ?4, -?5)
       ${geoClause}`;
  const args: (string | number)[] = [boardKey, t.score, t.elapsedMs, t.accMilli, t.achievedAt];
  if (geo) args.push(geo);
  const row = await db.prepare(sql).bind(...args).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface RankResult {
  rank: number | null;
  total: number;
  /** rank/total(0~1). total=0이면 null. */
  percentile: number | null;
  onBoard: boolean;
}

/** rank-of-me(§1.4-②). 보드에 없는 유저는 rank=null·onBoard=false(total은 그대로 반환). */
export async function rankOfUser(
  db: D1Database,
  boardKey: string,
  userId: string,
  geo?: string | null,
): Promise<RankResult> {
  const mine = await db
    .prepare(
      `SELECT score, elapsed_ms, acc_milli, achieved_at, geo FROM lb_best WHERE board_key = ?1 AND user_id = ?2`,
    )
    .bind(boardKey, userId)
    .first<{ score: number; elapsed_ms: number; acc_milli: number; achieved_at: number; geo: string | null }>();
  const total = await boardTotal(db, boardKey, geo);
  if (!mine || (geo && mine.geo !== geo)) {
    return { rank: null, total, percentile: null, onBoard: false };
  }
  const better = await countBetter(
    db,
    boardKey,
    { score: mine.score, elapsedMs: mine.elapsed_ms, accMilli: mine.acc_milli, achievedAt: mine.achieved_at },
    geo,
  );
  const rank = better + 1;
  return { rank, total, percentile: total > 0 ? rank / total : null, onBoard: true };
}

export interface InlineRank {
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean;
}

/**
 * 제출 응답 인라인(§1.4-③). all 보드 기준 rank/total + 이 run이 개인 베스트가 됐는지.
 * UPSERT 배치 이후 호출한다(내 lb_best 행의 run_id가 이 run이면 갱신에 성공한 것 = PB).
 */
export async function inlineRankForRun(
  db: D1Database,
  boardKey: string,
  userId: string,
  runId: string,
): Promise<InlineRank> {
  const mine = await db
    .prepare(`SELECT run_id, score, elapsed_ms, acc_milli, achieved_at FROM lb_best WHERE board_key = ?1 AND user_id = ?2`)
    .bind(boardKey, userId)
    .first<{ run_id: string; score: number; elapsed_ms: number; acc_milli: number; achieved_at: number }>();
  if (!mine) return { rank: null, total: null, isPersonalBest: false };
  const better = await countBetter(db, boardKey, {
    score: mine.score,
    elapsedMs: mine.elapsed_ms,
    accMilli: mine.acc_milli,
    achievedAt: mine.achieved_at,
  });
  const total = await boardTotal(db, boardKey);
  return { rank: better + 1, total, isPersonalBest: mine.run_id === runId };
}

export interface PageResult {
  entries: LbEntry[];
  nextCursor: string | null;
  total: number;
}

/**
 * keyset 페이지(§1.4-①, OFFSET 금지). LIMIT PAGE_SIZE+1로 hasNext 판별, 첫 행의 rank를 COUNT로
 * 1회 계산 후 페이지 내 증분. 커서/지역 필터가 오면 항상 D1(§1.5 읽기 경로).
 */
export async function queryPage(
  db: D1Database,
  boardKey: string,
  opts: { after?: RankTuple | null; geo?: string | null } = {},
): Promise<PageResult> {
  const { after, geo } = opts;
  const clauses: string[] = ["b.board_key = ?1", "u.status = 'active'"];
  const args: (string | number)[] = [boardKey];
  if (geo) {
    args.push(geo);
    clauses.push(`b.geo = ?${args.length}`);
  }
  if (after) {
    const base = args.length;
    args.push(after.score, after.elapsedMs, after.accMilli, after.achievedAt);
    // ranking key: docs/06 §1.2 — 커서 튜플보다 사전식으로 "더 나쁜" 행만(다음 페이지).
    clauses.push(
      `(b.score, -b.elapsed_ms, b.acc_milli, -b.achieved_at) < (?${base + 1}, -?${base + 2}, ?${base + 3}, -?${base + 4})`,
    );
  }
  const limit = LB_PAGE_SIZE + 1;
  args.push(limit);
  // ranking key: docs/06 §1.2
  const sql = `SELECT b.user_id, u.nickname, u.passport_cover, b.score, b.elapsed_ms, b.acc_milli, b.achieved_at
     FROM lb_best b JOIN users u USING (user_id)
     WHERE ${clauses.join(" AND ")}
     ORDER BY b.score DESC, b.elapsed_ms ASC, b.acc_milli DESC, b.achieved_at ASC
     LIMIT ?${args.length}`;
  const res = await db.prepare(sql).bind(...args).all<LbRow>();
  const rows = res.results ?? [];
  const total = await boardTotal(db, boardKey, geo);
  const first = rows[0];
  if (!first) return { entries: [], nextCursor: null, total };

  const startRank =
    (await countBetter(
      db,
      boardKey,
      { score: first.score, elapsedMs: first.elapsed_ms, accMilli: first.acc_milli, achievedAt: first.achieved_at },
      geo,
    )) + 1;

  const hasNext = rows.length > LB_PAGE_SIZE;
  const page = rows.slice(0, LB_PAGE_SIZE);
  const entries = page.map((r, i) => rowToEntry(r, startRank + i));
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last
      ? encodeCursor({ score: last.score, elapsedMs: last.elapsed_ms, accMilli: last.acc_milli, achievedAt: last.achieved_at })
      : null;
  return { entries, nextCursor, total };
}

// ───────────────────────── KV 캐시(§1.5) ─────────────────────────

/** 방어적 파싱된 KV 캐시(형태가 다르면 null → 호출부가 D1 폴백). */
export async function readBoardCache(kv: KVNamespace, boardKey: string): Promise<LbCacheValue | null> {
  const raw = await kv.get(KV_KEYS.lb(boardKey));
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.entries) || typeof o.total !== "number" || typeof o.builtAt !== "number") return null;
  return o as unknown as LbCacheValue;
}

/**
 * 보드 top-100을 D1에서 재조회해 KV `lb:{board}`에 기록(§1.5). 활성 유저 0명이면 KV 키를
 * 삭제(비활성 유저의 stale 노출 방지) — 단, 캐시가 실제로 존재할 때만 지운다(§11-D60·WT-OPT-01).
 * 대다수 호출(늘 비어있는 보드의 cron 콜드 리프레시·GET /lb 미스 직후 백필)은 애초에 캐시가
 * 없는 상태라 무조건 delete를 날리면 크론 매분 + 미스 요청마다 의미 없는 KV 쓰기가 쌓인다.
 * 반환값은 total(콜드/더티 판정 로깅용).
 */
export async function refreshBoardCache(db: D1Database, kv: KVNamespace, boardKey: string): Promise<number> {
  const total = await boardTotal(db, boardKey);
  if (total === 0) {
    const cached = await kv.get(KV_KEYS.lb(boardKey));
    if (cached !== null) {
      await kv.delete(KV_KEYS.lb(boardKey));
    }
    return 0;
  }
  // ranking key: docs/06 §1.2
  const res = await db
    .prepare(
      `SELECT b.user_id, u.nickname, u.passport_cover, b.score, b.elapsed_ms, b.acc_milli, b.achieved_at
       FROM lb_best b JOIN users u USING (user_id)
       WHERE b.board_key = ?1 AND u.status = 'active'
       ORDER BY b.score DESC, b.elapsed_ms ASC, b.acc_milli DESC, b.achieved_at ASC
       LIMIT ?2`,
    )
    .bind(boardKey, LB_CACHE_TOP_N)
    .all<LbRow>();
  const rows = res.results ?? [];
  const entries = rows.map((r, i) => rowToEntry(r, i + 1));
  const builtAt = Date.now();
  const value: LbCacheValue = { entries, total, builtAt };
  await kv.put(KV_KEYS.lb(boardKey), JSON.stringify(value), { metadata: { builtAt, total } });
  return total;
}

/** seasons 테이블의 활성 시즌 periodKey('s:...') — v1은 행이 없어 항상 null(§11-D15). */
export async function activeSeasonPeriod(db: D1Database, now: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT season_id FROM seasons WHERE starts_at <= ?1 AND ends_at > ?1 ORDER BY starts_at DESC LIMIT 1`)
    .bind(now)
    .first<{ season_id: string }>();
  return row?.season_id ?? null;
}
