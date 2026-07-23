// spec: docs/06 §1.2(랭킹 키)·§1.3(튜플 비교 UPSERT·daily DO NOTHING)·§1.4(keyset·rank-of-me)·
//       §1.5(KV 캐시 + cron), docs/00 §11-D24 + WT-M3-04 [구현 세부 지시]·[완료 조건]
//   — 튜플 각 요소별 UPSERT 갱신/미갱신, keyset 2페이지 연속성(중복·누락 0), rank-of-me 전수 대조,
//     daily DO NOTHING, shadowban 미노출, KV 1페이지/D1 커서·지역, cron dirty/cold, 제출 인라인 순위.
/* eslint-disable no-await-in-loop -- 순차 시드/전수 대조가 목적(각 반복이 독립 D1 write). */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  boardKeysForRun,
  coldAlltimeBoardKeys,
  decodeCursor,
  encodeCursor,
  isValidBoardKey,
  queryPage,
  rankOfUser,
  readBoardCache,
  refreshBoardCache,
  upsertBestStmts,
  type RankTuple,
} from "../src/lib/lb";
import { runLbRefresher } from "../src/cron/lb-refresher";
import { KV_KEYS } from "../src/lib/kv-keys";
import { kstDate, kstIsoWeek } from "../src/lib/kst";
import { computeScore, requiredKeystrokes, type CountryId, type ScoreCountry } from "@wt/shared";
import { COUNTRIES } from "@wt/data";

const BASE = "http://local/api/v1";
const BY_ID = new Map(COUNTRIES.map((c) => [c.id, c] as const));

// ───────────────────────── 공용 헬퍼 ─────────────────────────

let seq = 0;
function uid(): string {
  seq += 1;
  return `u${seq}_${crypto.randomUUID().slice(0, 8)}`;
}
/** 검증을 거치지 않는 유닛용 임의 board_key(테스트 간 격리 — 각 테스트가 고유 보드 사용). */
function unitBoard(): string {
  return `unit-${crypto.randomUUID().slice(0, 12)}`;
}

async function insertUser(userId: string, opts?: { status?: string; geo?: string | null }): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, geo, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(userId, `dh-${userId}`, `N-${userId}`, `n-${userId}`, opts?.geo ?? null, opts?.status ?? "active", now)
    .run();
}

async function upsertOne(
  board: string,
  userId: string,
  runId: string,
  t: RankTuple,
  opts?: { geo?: string | null; isDaily?: boolean },
): Promise<void> {
  const stmts = upsertBestStmts(env.DB, {
    boardKeys: [board],
    userId,
    runId,
    score: t.score,
    elapsedMs: t.elapsedMs,
    accMilli: t.accMilli,
    achievedAt: t.achievedAt,
    geo: opts?.geo ?? null,
    isDaily: opts?.isDaily ?? false,
  });
  await env.DB.batch(stmts);
}

/** 유저 생성 + lb_best 등재를 한 번에(격리 보드에 시드). */
async function seedRow(
  board: string,
  runId: string,
  t: RankTuple,
  opts?: { status?: string; geo?: string | null },
): Promise<string> {
  const id = uid();
  await insertUser(id, { status: opts?.status, geo: opts?.geo });
  await upsertOne(board, id, runId, t, { geo: opts?.geo ?? null });
  return id;
}

async function bestRow(board: string, userId: string) {
  return env.DB.prepare(
    `SELECT run_id, score, elapsed_ms, acc_milli, achieved_at FROM lb_best WHERE board_key = ?1 AND user_id = ?2`,
  )
    .bind(board, userId)
    .first<{ run_id: string; score: number; elapsed_ms: number; acc_milli: number; achieved_at: number }>();
}

/** SQL 랭킹 키와 동일한 비교: a가 b보다 상위면 양수(score↓ elapsed↑ acc↓ achieved↑). */
function betterThan(a: RankTuple, b: RankTuple): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.elapsedMs !== b.elapsedMs) return b.elapsedMs - a.elapsedMs;
  if (a.accMilli !== b.accMilli) return a.accMilli - b.accMilli;
  return b.achievedAt - a.achievedAt;
}

// ───────────────────────── board_key / 커서 유닛 ─────────────────────────

describe("boardKeysForRun (§1.1 periods · daily 예외)", () => {
  const now = Date.parse("2026-07-21T03:00:00Z"); // 12:00 KST

  it("daily 모드는 all 보드 하나만", () => {
    expect(boardKeysForRun({ modeKey: "daily:2026-07-21", lang: "ko", platform: "desktop", now })).toEqual([
      "daily:2026-07-21|ko|desktop|all",
    ]);
  });

  it("비-daily는 all + d: + w: (시즌 없음)", () => {
    expect(boardKeysForRun({ modeKey: "worldtour", lang: "en", platform: "mobile", now })).toEqual([
      "worldtour|en|mobile|all",
      `worldtour|en|mobile|d:${kstDate(now)}`,
      `worldtour|en|mobile|w:${kstIsoWeek(now)}`,
    ]);
  });

  it("활성 시즌이 있으면 s: 보드가 추가된다(§11-D15)", () => {
    const keys = boardKeysForRun({
      modeKey: "tier:3",
      lang: "ko",
      platform: "desktop",
      now,
      activeSeasonPeriod: "s:2026q3",
    });
    expect(keys).toHaveLength(4);
    expect(keys).toContain("tier:3|ko|desktop|s:2026q3");
  });
});

describe("isValidBoardKey", () => {
  it("정상 보드 키 허용", () => {
    expect(isValidBoardKey("continent:europe|ko|desktop|w:2026-W30")).toBe(true);
    expect(isValidBoardKey("tier:3|en|mobile|all")).toBe(true);
    expect(isValidBoardKey("daily:2026-07-21|ko|desktop|all")).toBe(true);
    expect(isValidBoardKey("worldtour|en|desktop|d:2026-07-21")).toBe(true);
  });
  it("형식 위반 거부", () => {
    expect(isValidBoardKey("garbage")).toBe(false);
    expect(isValidBoardKey("worldtour|fr|desktop|all")).toBe(false); // lang
    expect(isValidBoardKey("tier:9|en|desktop|all")).toBe(false); // tier 범위
    expect(isValidBoardKey("daily:2026-07-21|ko|desktop|d:2026-07-21")).toBe(false); // daily는 all만
    expect(isValidBoardKey("worldtour|en|tablet|all")).toBe(false); // platform
  });
});

describe("cursor 코덱(base64url JSON)", () => {
  it("라운드트립 보존", () => {
    const t: RankTuple = { score: 450, elapsedMs: 12345, accMilli: 987, achievedAt: 1_700_000_000_000 };
    expect(decodeCursor(encodeCursor(t))).toEqual(t);
  });
  it("변조/불완전 커서는 null", () => {
    expect(decodeCursor("@@@not-base64@@@")).toBeNull();
    expect(decodeCursor(btoa('{"s":1}'))).toBeNull(); // 필드 누락
    expect(decodeCursor(btoa("not json"))).toBeNull();
  });
});

// ───────────────────────── UPSERT 튜플 비교(§1.3) ─────────────────────────

describe("lb_best UPSERT — 튜플 각 요소별 갱신/미갱신(§1.2)", () => {
  it("score 동점 + elapsed 빠름 → 갱신", async () => {
    const board = unitBoard();
    const id = await seedRow(board, "r1", { score: 100, elapsedMs: 5000, accMilli: 900, achievedAt: 1000 });
    await upsertOne(board, id, "r2", { score: 100, elapsedMs: 4000, accMilli: 900, achievedAt: 2000 });
    const row = await bestRow(board, id);
    expect(row!.run_id).toBe("r2");
    expect(row!.elapsed_ms).toBe(4000);
  });

  it("모든 요소 동일 + achieved_at 늦음 → 미갱신", async () => {
    const board = unitBoard();
    const id = await seedRow(board, "r1", { score: 100, elapsedMs: 5000, accMilli: 900, achievedAt: 1000 });
    await upsertOne(board, id, "r2", { score: 100, elapsedMs: 5000, accMilli: 900, achievedAt: 2000 });
    const row = await bestRow(board, id);
    expect(row!.run_id).toBe("r1"); // 먼저 달성한 기록 유지
  });

  it("score 더 낮음 → 미갱신", async () => {
    const board = unitBoard();
    const id = await seedRow(board, "hi", { score: 300, elapsedMs: 5000, accMilli: 900, achievedAt: 1000 });
    await upsertOne(board, id, "lo", { score: 200, elapsedMs: 1, accMilli: 1000, achievedAt: 1 });
    const row = await bestRow(board, id);
    expect(row!.run_id).toBe("hi");
    expect(row!.score).toBe(300);
  });

  it("acc 더 높음(score·elapsed 동점) → 갱신", async () => {
    const board = unitBoard();
    const id = await seedRow(board, "r1", { score: 100, elapsedMs: 5000, accMilli: 800, achievedAt: 1000 });
    await upsertOne(board, id, "r2", { score: 100, elapsedMs: 5000, accMilli: 950, achievedAt: 2000 });
    const row = await bestRow(board, id);
    expect(row!.run_id).toBe("r2");
    expect(row!.acc_milli).toBe(950);
  });

  it("daily 보드는 DO NOTHING — 더 좋은 기록도 첫 기록을 못 덮는다(§2.3)", async () => {
    const board = "daily:2026-07-21|ko|desktop|all";
    const id = uid();
    await insertUser(id);
    await upsertOne(board, id, "first", { score: 100, elapsedMs: 5000, accMilli: 900, achievedAt: 1000 }, { isDaily: true });
    await upsertOne(board, id, "better", { score: 999, elapsedMs: 1, accMilli: 1000, achievedAt: 2000 }, { isDaily: true });
    const row = await bestRow(board, id);
    expect(row!.run_id).toBe("first");
    expect(row!.score).toBe(100);
  });
});

// ───────────────────────── keyset · rank-of-me(§1.4) ─────────────────────────

describe("keyset 페이지네이션(§1.4-①)", () => {
  it("2페이지 연속성 — 경계 중복/누락 0, 랭크 1..60 연속", async () => {
    const board = unitBoard();
    for (let i = 0; i < 60; i += 1) {
      // score 내림차순으로 완전 정렬(동점 없음).
      await seedRow(board, `rk${i}`, { score: 1000 - i * 3, elapsedMs: 1000 + i, accMilli: 900, achievedAt: i + 1 });
    }
    const p1 = await queryPage(env.DB, board);
    expect(p1.entries).toHaveLength(50);
    expect(p1.total).toBe(60);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await queryPage(env.DB, board, { after: decodeCursor(p1.nextCursor!) });
    expect(p2.entries).toHaveLength(10);
    expect(p2.nextCursor).toBeNull();

    const all = [...p1.entries, ...p2.entries];
    expect(new Set(all.map((e) => e.userId)).size).toBe(60); // 중복·누락 0
    expect(all.map((e) => e.rank)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });
});

describe("rank-of-me(§1.4-②) 전수 대조", () => {
  it("무작위 50행 삽입 후 모든 유저의 rank-of-me가 top-N 순서와 일치", async () => {
    const board = unitBoard();
    let s = 987654321 >>> 0;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    const rows: { id: string; t: RankTuple }[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t: RankTuple = {
        score: Math.floor(rnd() * 500),
        elapsedMs: Math.floor(rnd() * 20000) + 1,
        accMilli: Math.floor(rnd() * 1000),
        achievedAt: Math.floor(rnd() * 1_000_000) + 1,
      };
      const id = await seedRow(board, `r${i}`, t);
      rows.push({ id, t });
    }

    // 기대 순서: 랭킹 키 내림차순. (풀 튜플이라 사실상 동점 없음)
    const sorted = [...rows].sort((a, b) => betterThan(b.t, a.t));

    // top-N 조회 순서가 기대 순서와 동일하고 랭크가 1..50.
    const page = await queryPage(env.DB, board);
    expect(page.entries).toHaveLength(50);
    expect(page.entries.map((e) => e.userId)).toEqual(sorted.map((r) => r.id));
    expect(page.entries.map((e) => e.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // 각 유저의 rank-of-me == (자기보다 상위 수)+1, 모든 경로 동일.
    for (const r of rows) {
      const better = rows.filter((o) => betterThan(o.t, r.t) > 0).length;
      const res = await rankOfUser(env.DB, board, r.id);
      expect(res.rank).toBe(better + 1);
      expect(res.total).toBe(50);
      expect(res.onBoard).toBe(true);
    }
  });
});

describe("shadowban 미노출(§3.5)", () => {
  it("shadowbanned 유저는 top-N·rank·total에서 제외", async () => {
    const board = unitBoard();
    const active = await seedRow(board, "ra", { score: 100, elapsedMs: 1000, accMilli: 900, achievedAt: 1 });
    // '더 좋은' 점수지만 shadowbanned → 노출 안 됨.
    const shadow = uid();
    await insertUser(shadow, { status: "shadowbanned" });
    await upsertOne(board, shadow, "rs", { score: 999, elapsedMs: 1, accMilli: 1000, achievedAt: 1 });

    const page = await queryPage(env.DB, board);
    expect(page.entries.map((e) => e.userId)).toEqual([active]);
    expect(page.total).toBe(1);

    const me = await rankOfUser(env.DB, board, active);
    expect(me.rank).toBe(1);
    expect(me.total).toBe(1);
  });
});

// ───────────────────────── GET /lb · /lb/me 라우트(§1.4·§1.5) ─────────────────────────

interface PageRes {
  entries: { rank: number; userId: string; score: number }[];
  nextCursor: string | null;
  total: number;
}
interface MeRes {
  rank: number | null;
  total: number;
  percentile: number | null;
  onBoard: boolean;
}

async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

describe("GET /api/v1/lb", () => {
  it("1페이지=KV 백필/서빙, 2페이지=D1 커서 — 연속성 유지", async () => {
    const board = "continent:asia|en|desktop|d:2052-05-05"; // 유효·고유
    for (let i = 0; i < 60; i += 1) {
      await seedRow(board, `rr${i}`, { score: 2000 - i, elapsedMs: 500, accMilli: 800, achievedAt: i + 1 });
    }
    await env.KV.delete(KV_KEYS.lb(board));

    const r1 = await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(board)}`);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as PageRes;
    expect(b1.entries).toHaveLength(50);
    expect(b1.total).toBe(60);
    expect(b1.nextCursor).toBeTruthy();
    // KV miss → D1 폴백 + 백필(§1.5) 확인.
    expect(await readBoardCache(env.KV, board)).not.toBeNull();

    // 두 번째 호출은 KV 히트(동일 1페이지).
    const r1b = (await (await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(board)}`)).json()) as PageRes;
    expect(r1b.entries[0]!.userId).toBe(b1.entries[0]!.userId);

    const r2 = await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(board)}&cursor=${encodeURIComponent(b1.nextCursor!)}`);
    const b2 = (await r2.json()) as PageRes;
    expect(b2.entries).toHaveLength(10);
    const all = [...b1.entries, ...b2.entries];
    expect(new Set(all.map((e) => e.userId)).size).toBe(60);
    expect(all.map((e) => e.rank)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("geo 필터는 D1에서 해당 지역만 반환", async () => {
    const board = "worldtour|ko|mobile|d:2053-06-06";
    const kr = uid();
    await insertUser(kr, { geo: "KR" });
    await upsertOne(board, kr, "gk", { score: 100, elapsedMs: 1000, accMilli: 900, achievedAt: 1 }, { geo: "KR" });
    const us = uid();
    await insertUser(us, { geo: "US" });
    await upsertOne(board, us, "gu", { score: 200, elapsedMs: 900, accMilli: 900, achievedAt: 2 }, { geo: "US" });

    const b = (await (await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(board)}&geo=KR`)).json()) as PageRes;
    expect(b.entries.map((e) => e.userId)).toEqual([kr]);
    expect(b.total).toBe(1);
  });

  it("board 누락/형식 위반/커서·geo 위반 → 400", async () => {
    expect((await SELF.fetch(`${BASE}/lb`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/lb?board=garbage`)).status).toBe(400);
    const ok = "tier:2|en|desktop|all";
    expect((await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(ok)}&cursor=@@@`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(ok)}&geo=usa`)).status).toBe(400);
  });
});

describe("GET /api/v1/lb/me", () => {
  it("인증 없으면 401", async () => {
    const board = "tier:2|en|desktop|d:2054-07-07";
    expect((await SELF.fetch(`${BASE}/lb/me?board=${encodeURIComponent(board)}`)).status).toBe(401);
  });

  it("내 순위/총원/백분위(§1.4-②)", async () => {
    const { token, pid } = await bootstrap();
    const board = "tier:2|en|desktop|d:2054-07-07";
    await upsertOne(board, pid, "me1", { score: 300, elapsedMs: 1000, accMilli: 900, achievedAt: 5 });
    for (let i = 0; i < 3; i += 1) {
      await seedRow(board, `o${i}`, { score: 400 + i, elapsedMs: 900, accMilli: 900, achievedAt: i + 1 });
    }
    const b = (await (
      await SELF.fetch(`${BASE}/lb/me?board=${encodeURIComponent(board)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as MeRes;
    expect(b.rank).toBe(4); // 상위 3명 + 1
    expect(b.total).toBe(4);
    expect(b.onBoard).toBe(true);
    expect(b.percentile).toBeCloseTo(1); // 4/4
  });

  it("보드에 없는 유저는 onBoard=false·rank=null", async () => {
    const { token } = await bootstrap();
    const board = "tier:5|en|desktop|d:2055-08-08";
    const b = (await (
      await SELF.fetch(`${BASE}/lb/me?board=${encodeURIComponent(board)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as MeRes;
    expect(b.onBoard).toBe(false);
    expect(b.rank).toBeNull();
  });
});

// ───────────────────────── cron lb-refresher(§1.5) ─────────────────────────

describe("cron/lb-refresher", () => {
  it("dirty 보드만 top-100 재조회해 lb: 키 생성하고 dirty 키를 삭제", async () => {
    const board = "worldtour|en|desktop|d:2051-03-03";
    const id = await seedRow(board, "c1", { score: 300, elapsedMs: 1000, accMilli: 900, achievedAt: 100 });
    await env.KV.delete(KV_KEYS.lb(board));
    await env.KV.put(KV_KEYS.dirty(board), "1");
    // sentinel(§11-D60·WT-OPT-01): 실제 제출 경로는 dirty 마킹과 항상 함께 남기므로, 여기서도
    // 직접 재현해야 이번 분이 게이트를 통과한다(minute 3은 콜드가 아니라 sentinel 없인 즉시 반환).
    await env.KV.put(KV_KEYS.dirtySentinel, "1");

    await runLbRefresher(env, Date.parse("2026-07-21T00:03:00Z")); // minute 3 → 콜드 아님

    const cached = await readBoardCache(env.KV, board);
    expect(cached).not.toBeNull();
    expect(cached!.total).toBe(1);
    expect(cached!.entries.map((e) => e.userId)).toContain(id);
    expect(cached!.entries[0]!.rank).toBe(1);
    expect(await env.KV.get(KV_KEYS.dirty(board))).toBeNull(); // 처리 후 삭제
  });

  it("minute%10===0이면 콜드 alltime 보드도 리프레시(dirty 없이도)", async () => {
    const board = "tier:1|ko|desktop|all"; // coldAlltimeBoardKeys 포함
    expect(coldAlltimeBoardKeys()).toContain(board);
    const id = await seedRow(board, "cold1", { score: 500, elapsedMs: 800, accMilli: 950, achievedAt: 10 });
    await env.KV.delete(KV_KEYS.lb(board));
    // dirty 마킹 없음 — 콜드 분기로만 갱신되어야 함.

    await runLbRefresher(env, Date.parse("2026-07-21T00:10:00Z")); // minute 10 → 콜드

    const cached = await readBoardCache(env.KV, board);
    expect(cached).not.toBeNull();
    expect(cached!.entries.map((e) => e.userId)).toContain(id);
  });
});

// ───────── sentinel 게이트 · 콜드 프리필터(§11-D60·WT-OPT-01) ─────────

describe("cron/lb-refresher — sentinel 게이트(§11-D60)", () => {
  it("무-dirty·비-콜드 분: sentinel이 없으면 KV op가 정확히 1회(get)뿐이고 즉시 반환한다", async () => {
    await env.KV.delete(KV_KEYS.dirtySentinel);
    const getSpy = vi.spyOn(env.KV, "get");
    const putSpy = vi.spyOn(env.KV, "put");
    const deleteSpy = vi.spyOn(env.KV, "delete");
    const listSpy = vi.spyOn(env.KV, "list");

    await runLbRefresher(env, Date.parse("2026-07-21T00:03:00Z")); // minute 3 → 콜드 아님

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(KV_KEYS.dirtySentinel);
    expect(putSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();

    getSpy.mockRestore();
    putSpy.mockRestore();
    deleteSpy.mockRestore();
    listSpy.mockRestore();
  });

  it("sentinel이 있으면 dirty 목록을 list하기 전에 삭제하고, 그 보드를 정상 처리한다", async () => {
    const board = "worldtour|en|desktop|d:2051-04-04";
    const id = await seedRow(board, "s1", { score: 200, elapsedMs: 900, accMilli: 900, achievedAt: 5 });
    await env.KV.delete(KV_KEYS.lb(board));
    await env.KV.put(KV_KEYS.dirty(board), "1");
    await env.KV.put(KV_KEYS.dirtySentinel, "1");

    await runLbRefresher(env, Date.parse("2026-07-21T00:04:00Z")); // 콜드 아님, sentinel만으로 게이트 통과

    expect(await env.KV.get(KV_KEYS.dirtySentinel)).toBeNull(); // 처리 중 삭제됨
    const cached = await readBoardCache(env.KV, board);
    expect(cached?.entries.map((e) => e.userId)).toContain(id);
    expect(await env.KV.get(KV_KEYS.dirty(board))).toBeNull(); // dirty 키도 처리 후 삭제
  });

  it("콜드 분: lb_best에 행이 없는 alltime 보드는 프리필터로 제외돼 캐시가 생성되지 않는다", async () => {
    const emptyBoard = coldAlltimeBoardKeys().find((bk) => bk.startsWith("tier:4|"))!;
    await env.KV.delete(KV_KEYS.lb(emptyBoard));
    await env.KV.delete(KV_KEYS.dirtySentinel);

    await runLbRefresher(env, Date.parse("2026-07-21T00:20:00Z")); // minute 20 → 콜드, 행 없음

    expect(await readBoardCache(env.KV, emptyBoard)).toBeNull();
  });

  it("콜드 분: 캐시는 있는데 현재 행이 0인 콜드 보드는 캐시가 삭제된다(전량 비활성화·닉변 아닌 완전 이탈 반영)", async () => {
    const board = coldAlltimeBoardKeys().find((bk) => bk.startsWith("tier:5|"))!;
    // D1에는 행이 없고 KV 캐시만 미리 심어(예전 활성 상태의 잔재) 있는 상태를 시뮬레이션.
    await env.KV.put(KV_KEYS.lb(board), JSON.stringify({ entries: [], total: 3, builtAt: Date.now() }));
    await env.KV.delete(KV_KEYS.dirtySentinel);

    await runLbRefresher(env, Date.parse("2026-07-21T00:30:00Z")); // 콜드

    expect(await env.KV.get(KV_KEYS.lb(board))).toBeNull();
  });
});

// ───────── refreshBoardCache 빈 보드 delete 조건(§11-D60) ─────────

describe("refreshBoardCache — 빈 보드 delete 조건(§11-D60·WT-OPT-01)", () => {
  it("total=0이고 캐시가 애초에 없으면 kv.delete를 호출하지 않는다", async () => {
    const board = unitBoard(); // lb_best에 행 없음 + KV 캐시 없음
    await env.KV.delete(KV_KEYS.lb(board));
    const deleteSpy = vi.spyOn(env.KV, "delete");

    const total = await refreshBoardCache(env.DB, env.KV, board);

    expect(total).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
  });

  it("total=0이지만 캐시가 존재하면 그 캐시를 delete한다", async () => {
    const board = unitBoard();
    await env.KV.put(KV_KEYS.lb(board), JSON.stringify({ entries: [], total: 5, builtAt: Date.now() }));

    const total = await refreshBoardCache(env.DB, env.KV, board);

    expect(total).toBe(0);
    expect(await env.KV.get(KV_KEYS.lb(board))).toBeNull();
  });

  it("total>0이면 정상적으로 top-N을 재조회해 캐시를 기록한다(회귀 방지)", async () => {
    const board = unitBoard();
    const id = await seedRow(board, "rbc1", { score: 700, elapsedMs: 500, accMilli: 900, achievedAt: 1 });
    await env.KV.delete(KV_KEYS.lb(board));

    const total = await refreshBoardCache(env.DB, env.KV, board);

    expect(total).toBe(1);
    const cached = await readBoardCache(env.KV, board);
    expect(cached?.entries.map((e) => e.userId)).toContain(id);
  });
});

// ───────────────────────── 제출 → 보드 인라인(§1.4-③) ─────────────────────────

/** worldtour 앞 clearCount개를 정타 클리어한 제출 페이로드 + 정답 clientScore(lang='en'). */
function buildSubmit(countryIds: string[], clearCount: number, msPerKeystroke: number) {
  const cleared = countryIds.slice(0, clearCount);
  const perCountry = cleared.map((id) => {
    const c = BY_ID.get(id as CountryId)!;
    const L = requiredKeystrokes(c, "en");
    return { code: id, ms: L * msPerKeystroke, keystrokes: L, errors: 0, skipped: false, inputUsed: c.nameEn };
  });
  const totalKeystrokes = perCountry.reduce((a, p) => a + p.keystrokes, 0);
  const elapsedMs = perCountry.reduce((a, p) => a + p.ms, 0);
  const result = {
    elapsedMs,
    totalKeystrokes,
    correctKeystrokes: totalKeystrokes,
    maxCombo: clearCount,
    countriesCleared: clearCount,
    countriesSkipped: 0,
    livesLost: 0,
    finished: false,
    perCountry,
  };
  const scoreCountries: ScoreCountry[] = countryIds.map((id) => {
    const c = BY_ID.get(id as CountryId)!;
    return { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  });
  const expected = computeScore(
    {
      totalKeystrokes,
      correctKeystrokes: totalKeystrokes,
      elapsedMs,
      maxCombo: clearCount,
      countriesCleared: clearCount,
      countriesSkipped: 0,
      perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
    },
    scoreCountries,
    "en",
  );
  return { result, clientScore: expected.finalScore };
}

interface SubmitRes {
  verdict: string;
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean | null;
}

describe("POST /runs/submit — 리더보드 인라인 반영(§1.3·§1.4-③)", () => {
  it("valid 제출이 all+d:+w: 3보드에 등재되고 응답에 rank/total/PB 인라인 + dirty 마킹", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (
      await SELF.fetch(`${BASE}/runs/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "worldtour", lang: "en", platform: "desktop" }),
      })
    ).json()) as { runToken: string; runId: string; countryIds: string[] };
    const built = buildSubmit(started.countryIds, 2, 80);

    const body = (await (
      await SELF.fetch(`${BASE}/runs/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          runToken: started.runToken,
          result: built.result,
          clientScore: built.clientScore,
          inputDigest: { n: 15, mean: 150, stdev: 60, p10: 80, p50: 140, p90: 300, burstMax: 1 },
        }),
      })
    ).json()) as SubmitRes;

    expect(body.verdict).toBe("valid");
    expect(body.isPersonalBest).toBe(true);
    expect(body.rank).not.toBeNull();
    expect(body.total).not.toBeNull();
    expect(body.rank!).toBeGreaterThanOrEqual(1);
    expect(body.rank!).toBeLessThanOrEqual(body.total!);

    // all + d: + w: = 3보드에 이 run이 등재.
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE user_id = ?1 AND run_id = ?2")
      .bind(pid, started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(3);

    // dirty 마킹(§1.5) + sentinel(§11-D60·WT-OPT-01) — 둘 다 같은 batch에서 함께 기록된다.
    expect(await env.KV.get(KV_KEYS.dirty("worldtour|en|desktop|all"))).toBe("1");
    expect(await env.KV.get(KV_KEYS.dirtySentinel)).toBe("1");
  });

  it("flagged 제출(점수 위조)은 보드 미등재 + rank/total/PB null", async () => {
    const { token } = await bootstrap();
    const started = (await (
      await SELF.fetch(`${BASE}/runs/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "worldtour", lang: "en", platform: "desktop" }),
      })
    ).json()) as { runToken: string; runId: string; countryIds: string[] };
    const built = buildSubmit(started.countryIds, 2, 80);

    const body = (await (
      await SELF.fetch(`${BASE}/runs/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          runToken: started.runToken,
          result: built.result,
          clientScore: built.clientScore + 999999, // 위조 → flagged
          inputDigest: { n: 15, mean: 150, stdev: 60, p10: 80, p50: 140, p90: 300, burstMax: 1 },
        }),
      })
    ).json()) as SubmitRes;

    expect(body.verdict).toBe("flagged");
    expect(body.rank).toBeNull();
    expect(body.total).toBeNull();
    expect(body.isPersonalBest).toBeNull();

    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE run_id = ?1")
      .bind(started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });
});
