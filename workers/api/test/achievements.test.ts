// spec: docs/01 §9.2(업적 24종)·§9.3(언락 트리)·§9.4(커버 12종), docs/06 §4.3(user_unlocks·서버
//       권위), docs/00 §11-D2·D44·D50, docs/07 WT-M5-03 [완료 조건]
//   — 대표 업적 8종 판정(경계 포함: photo_finish 1000ms, win_streak 끊김) + 멱등 지급.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  evaluateRunAchievements,
  evaluateMatchAchievements,
  isPhotoFinishWin,
  type RunAchievementServerValues,
} from "../src/lib/achievements";

const BASE = "http://local/api/v1";

let seq = 0;
function uid(): string {
  seq += 1;
  return `u${seq}_${crypto.randomUUID().slice(0, 8)}`;
}

async function insertUser(userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (user_id, device_hash, nickname, nickname_norm, geo, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULL, 'active', ?5, ?5)`,
  )
    .bind(userId, `dh-${userId}`, `N-${userId}`, `n-${userId}`, now)
    .run();
}

/** achievements.ts의 집계 쿼리(countDistinct 등)가 대상으로 삼는 runs 스냅샷을 직접 심는다 —
 * 실제 라우트(runs.ts)는 이 INSERT를 이미 커밋한 뒤에만 evaluateRunAchievements를 부른다는
 * 계약이라, 테스트도 동일 순서(insert → evaluate)를 지킨다. */
async function insertRun(
  userId: string,
  opts: { modeKey: string; completed: boolean; grade: string },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (
       run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
       countries_cleared, countries_skipped, max_combo, completed, grade, seed, session_id,
       verdict, verdict_reason, geo, detail_json, created_at
     ) VALUES (?1,?2,?3,'en','desktop',100,100,200,900,1000,1,0,1,?4,?5,'seed',?1,'valid',NULL,NULL,'{}',?6)`,
  )
    .bind(crypto.randomUUID(), userId, opts.modeKey, opts.completed ? 1 : 0, opts.grade, now)
    .run();
}

async function insertMatch(matchId: string, finishedAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO matches (id, room_code, lang, mode, pool_param, seed, country_ids, data_version,
       started_at, finished_at, finish_reason, player_count, is_bot_match, rematch_of)
     VALUES (?1,'ABCD','en','race-mixed',NULL,'seed','[]','v1',?2,?3,'all-finished',2,0,NULL)`,
  )
    .bind(matchId, finishedAt - 1000, finishedAt)
    .run();
}

async function insertParticipant(
  matchId: string,
  playerId: string,
  opts: { rank: number; finished: boolean; errorKeystrokes?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO match_participants (match_id, player_id, nickname, is_guest, is_bot, rank, finished,
       countries_cleared, elapsed_ms, correct_keystrokes, error_keystrokes, cpm, acc, pi, disconnected,
       suspicion, avg_rtt_ms)
     VALUES (?1,?2,?3,0,0,?4,?5,10,60000,50,?6,200,0.9,150,0,NULL,NULL)`,
  )
    .bind(matchId, playerId, `N-${playerId}`, opts.rank, opts.finished ? 1 : 0, opts.errorKeystrokes ?? 0)
    .run();
}

const BASE_SERVER: RunAchievementServerValues = { completed: true, grade: "B", cpm: 200, maxCombo: 5 };

describe("achievements 상수", () => {
  it("24종이 고정 목록이고 id가 전부 유일하다", () => {
    expect(ACHIEVEMENTS).toHaveLength(24);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(24);
  });
});

describe("evaluateRunAchievements — 싱글", () => {
  it("첫 완주(어떤 모드든)는 first_flight + 티어 언락 + 스탬프를 지급하고, 재호출은 멱등이다", async () => {
    const userId = uid();
    await insertUser(userId);
    await insertRun(userId, { modeKey: "tier:1", completed: true, grade: "B" });

    const input = {
      userId,
      modeKey: "tier:1",
      lang: "en" as const,
      server: BASE_SERVER,
      totalKeystrokes: 50,
      correctKeystrokes: 45,
      livesLost: 1,
      perCountry: [],
      isDailyFirstValid: false,
      now: Date.now(),
    };

    const granted = await evaluateRunAchievements(env.DB, input);
    expect(granted).toEqual(
      expect.arrayContaining(["ach:first_flight", "tier:1", "stamp:tier:1:B"]),
    );

    // 멱등: 동일 입력으로 재호출해도 이미 지급된 항목은 다시 나오지 않는다(PK 충돌 무시).
    const again = await evaluateRunAchievements(env.DB, input);
    expect(again).toEqual([]);
  });

  it("6대륙 완주(전부 S) → six_continents·grade_s_all·대륙별 커버·gold 커버까지 지급", async () => {
    const userId = uid();
    await insertUser(userId);
    const continents = ["asia", "europe", "africa", "north-america", "south-america", "oceania"];
    let lastGranted: string[] = [];
    for (const c of continents) {
      const modeKey = `continent:${c}`;
      // eslint-disable-next-line no-await-in-loop -- 대륙별 순차 완주 시뮬레이션(누적 집계 전제).
      await insertRun(userId, { modeKey, completed: true, grade: "S" });
      // eslint-disable-next-line no-await-in-loop
      lastGranted = await evaluateRunAchievements(env.DB, {
        userId,
        modeKey,
        lang: "en",
        server: { completed: true, grade: "S", cpm: 300, maxCombo: 10 },
        totalKeystrokes: 30,
        correctKeystrokes: 30,
        livesLost: 0,
        perCountry: [],
        isDailyFirstValid: false,
        now: Date.now(),
      });
    }
    expect(lastGranted).toEqual(
      expect.arrayContaining(["ach:six_continents", "ach:grade_s_all", "cover:gold", "cover:continent-oceania"]),
    );
  });

  it("세계일주 완주(오타 0) → around_the_world·hologram 커버·perfect_run·perfect_marathon 동시 지급", async () => {
    const userId = uid();
    await insertUser(userId);
    await insertRun(userId, { modeKey: "worldtour", completed: true, grade: "A" });

    const granted = await evaluateRunAchievements(env.DB, {
      userId,
      modeKey: "worldtour",
      lang: "en",
      server: { completed: true, grade: "A", cpm: 250, maxCombo: 20 },
      totalKeystrokes: 100,
      correctKeystrokes: 100,
      livesLost: 0,
      perCountry: [],
      isDailyFirstValid: false,
      now: Date.now(),
    });
    expect(granted).toEqual(
      expect.arrayContaining(["ach:around_the_world", "cover:hologram", "ach:perfect_run", "ach:perfect_marathon"]),
    );
  });

  it("T5 완주 + 무피해(livesLost=0) → tier5_clear·no_life_lost·tier:5 언락", async () => {
    const userId = uid();
    await insertUser(userId);
    await insertRun(userId, { modeKey: "tier:5", completed: true, grade: "A" });

    const granted = await evaluateRunAchievements(env.DB, {
      userId,
      modeKey: "tier:5",
      lang: "en",
      server: { completed: true, grade: "A", cpm: 300, maxCombo: 10 },
      totalKeystrokes: 80,
      correctKeystrokes: 70,
      livesLost: 0,
      perCountry: [],
      isDailyFirstValid: false,
      now: Date.now(),
    });
    expect(granted).toEqual(expect.arrayContaining(["ach:tier5_clear", "ach:no_life_lost", "tier:5"]));
  });

  it("라이프를 소진한 T5 완주는 no_life_lost를 지급하지 않는다", async () => {
    const userId = uid();
    await insertUser(userId);
    await insertRun(userId, { modeKey: "tier:5", completed: true, grade: "C" });

    const granted = await evaluateRunAchievements(env.DB, {
      userId,
      modeKey: "tier:5",
      lang: "en",
      server: { completed: true, grade: "C", cpm: 200, maxCombo: 3 },
      totalKeystrokes: 80,
      correctKeystrokes: 60,
      livesLost: 2,
      perCountry: [],
      isDailyFirstValid: false,
      now: Date.now(),
    });
    expect(granted).not.toContain("ach:no_life_lost");
    expect(granted).toContain("ach:tier5_clear");
  });
});

describe("isPhotoFinishWin — 1000ms 경계(§5.1-4와 동일 규칙)", () => {
  it("정확히 1000ms 격차는 photo finish(이내 포함)", () => {
    expect(isPhotoFinishWin(10_000, 11_000)).toBe(true);
  });
  it("1001ms 격차는 photo finish 아님", () => {
    expect(isPhotoFinishWin(10_000, 11_001)).toBe(false);
  });
});

describe("evaluateMatchAchievements — 멀티", () => {
  it("photoFinishWin=true인 우승자에게만 photo_finish를 지급한다", async () => {
    const winner = uid();
    const loser = uid();
    await insertUser(winner);
    await insertUser(loser);
    const now = Date.now();

    const grantedWin = await evaluateMatchAchievements(
      env.DB,
      [{ userId: winner, rank: 1, finished: true, errorKeystrokes: 0, photoFinishWin: true }],
      now,
    );
    expect(grantedWin[winner]).toEqual(expect.arrayContaining(["ach:first_win", "ach:photo_finish", "ach:flawless_race"]));

    const grantedNoPhoto = await evaluateMatchAchievements(
      env.DB,
      [{ userId: loser, rank: 1, finished: true, errorKeystrokes: 3, photoFinishWin: false }],
      now,
    );
    expect(grantedNoPhoto[loser]).not.toContain("ach:photo_finish");
    expect(grantedNoPhoto[loser]).not.toContain("ach:flawless_race"); // 오타 有
  });

  it("5연승은 win_streak_5를 지급하고, 4연승(끊김 포함 5경기)은 지급하지 않는다(경계)", async () => {
    const streakUser = uid();
    const brokenUser = uid();
    await insertUser(streakUser);
    await insertUser(brokenUser);

    // streakUser: 5경기 전부 우승(가장 최근 것이 지금 평가 대상 매치라는 전제 — 이미 커밋됨).
    for (let i = 0; i < 5; i++) {
      const matchId = crypto.randomUUID();
      // eslint-disable-next-line no-await-in-loop
      await insertMatch(matchId, 1000 + i);
      // eslint-disable-next-line no-await-in-loop
      await insertParticipant(matchId, streakUser, { rank: 1, finished: true });
    }
    const grantedStreak = await evaluateMatchAchievements(
      env.DB,
      [{ userId: streakUser, rank: 1, finished: true, errorKeystrokes: 0, photoFinishWin: false }],
      Date.now(),
    );
    expect(grantedStreak[streakUser]).toContain("ach:win_streak_5");

    // brokenUser: t1 승, t2 승, t3 패(연승 끊김), t4 승, t5 승 → 가장 최근부터 거슬러 오르면 2연승.
    const results: Array<{ rank: number }> = [{ rank: 1 }, { rank: 1 }, { rank: 2 }, { rank: 1 }, { rank: 1 }];
    for (let i = 0; i < results.length; i++) {
      const matchId = crypto.randomUUID();
      // eslint-disable-next-line no-await-in-loop
      await insertMatch(matchId, 2000 + i);
      // eslint-disable-next-line no-await-in-loop
      await insertParticipant(matchId, brokenUser, { rank: results[i]!.rank, finished: true });
    }
    const grantedBroken = await evaluateMatchAchievements(
      env.DB,
      [{ userId: brokenUser, rank: 1, finished: true, errorKeystrokes: 0, photoFinishWin: false }],
      Date.now(),
    );
    expect(grantedBroken[brokenUser]).not.toContain("ach:win_streak_5");
  });

  it("지급은 멱등이다 — 동일 우승 결과를 두 번 평가해도 두 번째는 빈 배열", async () => {
    const userId = uid();
    await insertUser(userId);
    const input = [{ userId, rank: 1, finished: true, errorKeystrokes: 0, photoFinishWin: false }] as const;
    const first = await evaluateMatchAchievements(env.DB, input, Date.now());
    expect(first[userId]).toContain("ach:first_win");
    const second = await evaluateMatchAchievements(env.DB, input, Date.now());
    expect(second[userId]).toEqual([]);
  });
});

// ───────────────────────── 완주 → 여권 스탬프 노출(실 HTTP 왕복) ─────────────────────────
// docs/07 WT-M5-03 완료 조건 "완주→여권 스탬프 노출 통합 확인"을 자동화한 종단 테스트.
//
// [설계 메모] 완주 판정(evaluateRunAchievements)은 위 describe 블록들이 이미 실 D1 스냅샷
// 기준으로 검증했다. 여기서는 그 결과가 실 HTTP GET /users/:id/passport 응답에 그대로
// 노출되는지를 왕복시켜 "완주 → 스탬프 노출" 파이프라인 전체(판정 + 저장 + 조회 라우트)를
// 잇는다. runs/submit을 실제로 왕복시키지 않는 이유: 대륙(최소 12개국)·티어(20개국) 전체
// 완주 제출은 요구 타수 합이 커서 CPM 하드캡(§11-D12, en 1000)을 지키려면 elapsedMs가
// 수 초 단위로 커지는데, 이는 서버 시간 봉투(§6.2-3, 실측 wall-clock + 3000ms grace)를
// 인위적 지연 없이는 통과할 수 없다 — 판정 유닛 테스트(위)로 이미 커버된 조건을 굳이 초 단위
// sleep으로 재현하는 대신, 이 테스트는 "저장된 unlock이 실 라우트로 정확히 노출되는가"만
// 검증한다(중복 없는 관심사 분리).
describe("완주 → 여권 스탬프 노출(종단, 실 라우트)", () => {
  it("서버가 지급한 unlock이 GET /users/:id/passport에 그대로 노출된다", async () => {
    const { pid } = await bootstrapUser();

    // achievements.ts가 실제로 만들었을 스냅샷(대륙 완주 1회)을 그대로 재현 — 위 describe의
    // "첫 완주" 테스트와 동일한 호출 계약(insert → evaluate).
    await insertRun(pid, { modeKey: "continent:asia", completed: true, grade: "B" });
    const granted = await evaluateRunAchievements(env.DB, {
      userId: pid,
      modeKey: "continent:asia",
      lang: "en",
      server: { completed: true, grade: "B", cpm: 300, maxCombo: 10 },
      totalKeystrokes: 200,
      correctKeystrokes: 190,
      livesLost: 0,
      perCountry: [],
      isDailyFirstValid: false,
      now: Date.now(),
    });
    expect(granted).toEqual(
      expect.arrayContaining(["ach:first_flight", "stamp:continent:asia:B", "cover:continent-asia"]),
    );

    const passportRes = await SELF.fetch(`${BASE}/users/${pid}/passport`);
    expect(passportRes.status).toBe(200);
    const passport = (await passportRes.json()) as {
      nickname: string;
      unlocks: Array<{ type: string; id: string }>;
    };
    expect(passport.unlocks.map((u) => u.id)).toEqual(expect.arrayContaining(granted));
    expect(passport.unlocks.some((u) => u.type === "stamp" && u.id === "stamp:continent:asia:B")).toBe(true);
    expect(passport.unlocks.some((u) => u.type === "achievement" && u.id === "ach:first_flight")).toBe(true);
    expect(passport.unlocks.some((u) => u.type === "cover" && u.id === "cover:continent-asia")).toBe(true);
  });
});

async function bootstrapUser(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}
