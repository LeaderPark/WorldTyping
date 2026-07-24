// spec: docs/04 §6.1(생명주기)·§6.2·§2.3-4/5, docs/06 §3.1(rejected=200)·§2.3(데일리 1일 1회·스트릭)·
//       §3.5(섀도우밴), docs/00 §11-D5·D16·D21·D38 + WT-M3-03 [완료 조건]
//       — /runs/start→submit 왕복, 정상=valid+runs 기록, 리플레이(KV), 데일리 규칙, rejected=200, 섀도우밴.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { computeScore, requiredKeystrokes, type CountryId, type ScoreCountry } from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import { kstDate } from "../src/lib/kst";
import type { RunRow, UserRow } from "../src/db/types";

const BASE = "http://local/api/v1";
const BY_ID = new Map(COUNTRIES.map((c) => [c.id, c] as const));

interface StartRes {
  runToken: string;
  runId: string;
  serverStartTs: number;
  countryIds: string[];
  seed: string;
}
interface SubmitRes {
  verdict: "valid" | "flagged" | "practice" | "rejected";
  score: number;
  cpm: number;
  completed: boolean;
  rank: number | null;
  shareText: string | null;
}
interface PerCountry {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
  inputUsed: string;
}

// WT-AUTH-02(§11-D68-①): 랭킹 등재(verdict='valid')는 계정(Google 로그인) 세션 전용이 됐다. 게스트
// 제출은 practice/'guest'로 강등되므로, valid/flagged/스트릭을 기대하는 정상 경로 스위트는 계정
// 세션으로 부트스트랩한다. 계정 세션은 dev 심(/auth/dev)으로만 발급 가능하다(§11-D68-⑩). /auth/dev는
// 레이트리밋이 없어(auth RL은 /auth/google 전용) 케이스마다 고유 sub로 호출해도 안전하다.
async function bootstrap(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sub: "runs-acct-" + crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

/** 게스트(비계정) 세션. 게스트 게이팅(강등)·브리지 테스트 전용(§11-D68-①④). */
async function bootstrapGuest(): Promise<{ token: string; pid: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, pid: body.playerId };
}

function startRun(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/runs/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function submitRun(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/runs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** countryIds의 앞 clearCount개를 정타로 클리어한 제출 페이로드 + 정답 clientScore를 만든다(lang='en'). */
function buildSubmit(
  countryIds: string[],
  clearCount: number,
  msPerKeystroke: number,
): { result: unknown; clientScore: number; perCountry: PerCountry[] } {
  const cleared = countryIds.slice(0, clearCount);
  const perCountry: PerCountry[] = cleared.map((id) => {
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
  // 서버가 쓰는 전체 세트 기준으로 clientScore를 재현(⑨ score_mismatch 방지).
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
  return { result, clientScore: expected.finalScore, perCountry };
}

const HUMAN_DIGEST = { n: 15, mean: 150, stdev: 60, p10: 80, p50: 140, p90: 300, burstMax: 1 };

describe("POST /runs/start", () => {
  it("401 without a session bearer token", async () => {
    const res = await startRun("garbage", { mode: "worldtour", lang: "en", platform: "desktop" });
    expect(res.status).toBe(401);
  });

  it("issues a signed runToken + full worldtour set", async () => {
    const { token } = await bootstrap();
    const res = await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StartRes;
    expect(body.runToken).toMatch(/^wt1\./);
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.countryIds.length).toBe(50); // ROUTE_WORLD_TOUR
    expect(body.countryIds[0]).toBe("KR");
    expect(body.serverStartTs).toBeGreaterThan(0);
  });

  it("rejects an invalid body (tier mode without tier)", async () => {
    const { token } = await bootstrap();
    const res = await startRun(token, { mode: "tier", lang: "en", platform: "desktop" });
    expect(res.status).toBe(400);
  });
});

describe("POST /runs/submit — 정상 경로", () => {
  it("valid 제출이 runs에 verdict='valid'로 기록되고 서버 재계산 값이 저장된다", async () => {
    const { token, pid } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80); // 앞 2개국 클리어, cpm=750

    const res = await submitRun(token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitRes;
    expect(body.verdict).toBe("valid");
    expect(body.cpm).toBe(750);
    expect(body.score).toBe(built.clientScore);
    expect(body.shareText).toBeNull(); // daily 전용 필드(WT-M5-04) — worldtour는 항상 null.

    const row = await env.DB.prepare("SELECT * FROM runs WHERE run_id = ?1").bind(started.runId).first<RunRow>();
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(pid);
    expect(row!.verdict).toBe("valid");
    expect(row!.mode_key).toBe("worldtour");
    expect(row!.score).toBe(built.clientScore);
    expect(row!.completed).toBe(0); // 부분 클리어(중도 종료)
    expect(row!.detail_json).toContain("perCountry");
  });

  it("점수 위조 제출은 flagged로 기록되고 저장 점수는 서버 재계산 값(클라 위조값 아님)", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    const res = await submitRun(token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore + 999999, // 위조
      inputDigest: HUMAN_DIGEST,
    });
    const body = (await res.json()) as SubmitRes;
    expect(body.verdict).toBe("flagged");
    expect(body.score).toBe(built.clientScore); // 서버 값

    const row = await env.DB.prepare("SELECT score, verdict, verdict_reason FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<Pick<RunRow, "score" | "verdict" | "verdict_reason">>();
    expect(row!.verdict).toBe("flagged");
    expect(row!.verdict_reason).toContain("score_mismatch");
    expect(row!.score).toBe(built.clientScore);
  });
});

describe("POST /runs/submit — 시즌 쿼리 제거(§11-D15·D60)", () => {
  it("valid 제출 경로에서 seasons 테이블을 조회하지 않는다(activeSeasonPeriod 호출을 상수 null로 고정)", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    const prepareSpy = vi.spyOn(env.DB, "prepare");
    const res = await submitRun(token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SubmitRes).verdict).toBe("valid");

    const sqlCalls = prepareSpy.mock.calls.map((args) => String(args[0]));
    expect(sqlCalls.some((sql) => /\bseasons\b/i.test(sql))).toBe(false);
    prepareSpy.mockRestore();
  });
});

describe("POST /runs/submit — 티어(서버 시드 세트 재현)", () => {
  it("tier start의 세트를 submit이 동일하게 재현하고(setHash 일치) valid로 기록", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "tier", lang: "en", platform: "desktop", tier: 3 })).json()) as StartRes;
    expect(started.countryIds.length).toBe(20); // TIER_SET_SIZE
    const built = buildSubmit(started.countryIds, 2, 80);
    const res = await submitRun(token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    // start와 submit의 세트가 시드로 동일 재현되지 않으면 set_mismatch가 났을 것.
    expect(((await res.json()) as SubmitRes).verdict).toBe("valid");
    const row = await env.DB.prepare("SELECT mode_key, verdict FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<Pick<RunRow, "mode_key" | "verdict">>();
    expect(row!.mode_key).toBe("tier:3");
    expect(row!.verdict).toBe("valid");
  });
});

describe("POST /runs/submit — 리플레이(토큰 재사용)", () => {
  it("같은 runToken 재제출은 rejected(HTTP 200)이며 새 runs 행을 만들지 않는다", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);
    const payload = {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    };

    const first = (await (await submitRun(token, payload)).json()) as SubmitRes;
    expect(first.verdict).toBe("valid");

    const second = await submitRun(token, payload);
    expect(second.status).toBe(200); // 4xx 신호 금지
    expect(((await second.json()) as SubmitRes).verdict).toBe("rejected");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1); // 리플레이는 재삽입되지 않음
  });
});

describe("POST /runs/submit — 위조 토큰 / 세트 불일치", () => {
  it("위조 runToken → HTTP 200 rejected(삽입 없음)", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);
    const res = await submitRun(token, {
      runToken: "wt1.forged.signature",
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SubmitRes).verdict).toBe("rejected");
  });

  it("세트 코드 위조 → rejected/'set_mismatch' 기록", async () => {
    const { token } = await bootstrap();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);
    const tampered = (built.result as { perCountry: PerCountry[] }).perCountry.map((p, i) =>
      i === 0 ? { ...p, code: "ZZ" } : p,
    );
    const res = await submitRun(token, {
      runToken: started.runToken,
      result: { ...(built.result as object), perCountry: tampered },
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(((await res.json()) as SubmitRes).verdict).toBe("rejected");
    const row = await env.DB.prepare("SELECT verdict, verdict_reason FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<Pick<RunRow, "verdict" | "verdict_reason">>();
    expect(row!.verdict).toBe("rejected");
    expect(row!.verdict_reason).toBe("set_mismatch");
  });
});

describe("POST /runs/submit — 섀도우밴(rejected 누적 3회)", () => {
  it("rejected 3회 누적 후 users.status='shadowbanned'", async () => {
    const { token, pid } = await bootstrap();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 순차 누적이 목적.
      const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
      const built = buildSubmit(started.countryIds, 2, 80);
      const tampered = (built.result as { perCountry: PerCountry[] }).perCountry.map((p, j) =>
        j === 0 ? { ...p, code: "ZZ" } : p,
      );
      // eslint-disable-next-line no-await-in-loop
      await submitRun(token, {
        runToken: started.runToken,
        result: { ...(built.result as object), perCountry: tampered },
        clientScore: built.clientScore,
        inputDigest: HUMAN_DIGEST,
      });
    }
    const user = await env.DB.prepare("SELECT status FROM users WHERE user_id=?1")
      .bind(pid)
      .first<Pick<UserRow, "status">>();
    expect(user!.status).toBe("shadowbanned");
  });
});

describe("POST /runs/submit — 데일리 1일 1회 + 스트릭", () => {
  it("첫 정식 제출=valid(스트릭 1), 재도전=practice/'daily_practice'", async () => {
    const { token, pid } = await bootstrap();
    const dateKst = kstDate();
    const dailyIds = ["KR", "JP", "US", "FR", "BR", "IN", "EG", "AU", "DE", "GB"];
    // WT-M3-05 cron 대신 테스트에서 daily_challenges를 직접 확정 저장(set-builder D1 폴백 경로).
    await env.DB.prepare(
      "INSERT OR REPLACE INTO daily_challenges (date_kst, daily_no, seed, country_ids, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(dateKst, Date.now(), "daily-seed-hex", JSON.stringify(dailyIds), Date.now())
      .run();

    // 1) 첫 제출 → valid + streak=1
    const s1 = (await (await startRun(token, { mode: "daily", lang: "en", platform: "desktop" })).json()) as StartRes;
    expect(s1.countryIds).toEqual(dailyIds);
    const b1 = buildSubmit(s1.countryIds, 2, 80);
    const r1 = (await (await submitRun(token, {
      runToken: s1.runToken,
      result: b1.result,
      clientScore: b1.clientScore,
      inputDigest: HUMAN_DIGEST,
    })).json()) as SubmitRes;
    expect(r1.verdict).toBe("valid");
    // §2.3 shareText: daily 모드에서만 채워지고(WT-M5-04), en 로케일 라벨·10칸 그리드(2완주+8미도달)·
    // "/daily" 폴백 링크(PUBLIC_ORIGIN 미설정)를 담는다.
    expect(r1.shareText).not.toBeNull();
    expect(r1.shareText).toContain("TypeTrip Daily #");
    expect(r1.shareText).toContain("🟩🟩🟥🟥🟥🟥🟥🟥🟥🟥  2/10 cleared");
    expect(r1.shareText).toContain(`⚡ ${r1.cpm}cpm`);
    expect(r1.shareText!.endsWith("/daily")).toBe(true);

    const afterFirst = await env.DB.prepare("SELECT streak_daily, streak_updated FROM users WHERE user_id=?1")
      .bind(pid)
      .first<Pick<UserRow, "streak_daily" | "streak_updated">>();
    expect(afterFirst!.streak_daily).toBe(1);
    expect(afterFirst!.streak_updated).toBe(dateKst);

    // 2) 재도전(새 토큰) → practice, 스트릭 불변
    const s2 = (await (await startRun(token, { mode: "daily", lang: "en", platform: "desktop" })).json()) as StartRes;
    const b2 = buildSubmit(s2.countryIds, 2, 80);
    const r2 = (await (await submitRun(token, {
      runToken: s2.runToken,
      result: b2.result,
      clientScore: b2.clientScore,
      inputDigest: HUMAN_DIGEST,
    })).json()) as SubmitRes;
    expect(r2.verdict).toBe("practice");
    // 재도전(practice 강등)도 daily 모드라 shareText는 계속 채워진다(§2.3 — "포맷 단일화 목적,
    // 클라 조작 여지 제거 목적이 아니다": 개인 공유용 텍스트일 뿐 등재 여부와 무관).
    expect(r2.shareText).not.toBeNull();
    expect(r2.shareText).toContain("TypeTrip Daily #");

    const afterSecond = await env.DB.prepare("SELECT streak_daily FROM users WHERE user_id=?1")
      .bind(pid)
      .first<Pick<UserRow, "streak_daily">>();
    expect(afterSecond!.streak_daily).toBe(1); // 재도전은 스트릭을 올리지 않음

    // runs에 practice 행이 남는지 확인
    const practiceRow = await env.DB.prepare(
      "SELECT verdict, verdict_reason FROM runs WHERE run_id=?1",
    )
      .bind(s2.runId)
      .first<Pick<RunRow, "verdict" | "verdict_reason">>();
    expect(practiceRow!.verdict).toBe("practice");
    expect(practiceRow!.verdict_reason).toBe("daily_practice");
  });
});

// ───────────────── WT-AUTH-02(§11-D68-①) 게스트 랭킹 게이팅 ─────────────────

describe("POST /runs/submit — 게스트(비계정) 강등", () => {
  it("게스트 clean 제출은 practice/'guest'로 강등, 원장엔 남지만 lb_best 미도달", async () => {
    const { token, pid } = await bootstrapGuest();
    const started = (await (await startRun(token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80); // 계정이면 valid가 될 clean 레시피

    const res = await submitRun(token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitRes;
    // §11-D68-①: 계정이었다면 valid였을 판이 게스트라 practice로 강등된다.
    expect(body.verdict).toBe("practice");
    expect(body.rank).toBeNull(); // 랭킹 인라인 없음(비등재)

    // 원장 INSERT는 유지(안티치트·데일리 alreadyPlayed 판정 근거) — verdict_reason='guest'.
    const row = await env.DB.prepare("SELECT user_id, verdict, verdict_reason FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<Pick<RunRow, "user_id" | "verdict" | "verdict_reason">>();
    expect(row!.user_id).toBe(pid);
    expect(row!.verdict).toBe("practice");
    expect(row!.verdict_reason).toBe("guest");

    // lb_best엔 도달하지 않는다(랭킹 미등재).
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE run_id=?1")
      .bind(started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });

  it("게스트 데일리 제출: practice/'guest' 강등 + 원장 INSERT 유지 + 스트릭 미증가(1일1회 판정 보존)", async () => {
    const { token, pid } = await bootstrapGuest();
    const dateKst = kstDate();
    const dailyIds = ["KR", "JP", "US", "FR", "BR", "IN", "EG", "AU", "DE", "GB"];
    await env.DB.prepare(
      "INSERT OR REPLACE INTO daily_challenges (date_kst, daily_no, seed, country_ids, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(dateKst, Date.now(), "daily-seed-guest", JSON.stringify(dailyIds), Date.now())
      .run();

    const s1 = (await (await startRun(token, { mode: "daily", lang: "en", platform: "desktop" })).json()) as StartRes;
    const b1 = buildSubmit(s1.countryIds, 2, 80);
    const r1 = (await (await submitRun(token, {
      runToken: s1.runToken,
      result: b1.result,
      clientScore: b1.clientScore,
      inputDigest: HUMAN_DIGEST,
    })).json()) as SubmitRes;
    // 게스트 강등이 데일리 valid 분기보다 앞서므로 reason은 'guest'(daily_practice 아님). 스트릭은
    // 계정 전용(첫 정식 제출)이라 게스트는 애초에 valid에 진입하지 않는다.
    expect(r1.verdict).toBe("practice");

    const row = await env.DB.prepare("SELECT verdict, verdict_reason, mode_key FROM runs WHERE run_id=?1")
      .bind(s1.runId)
      .first<Pick<RunRow, "verdict" | "verdict_reason" | "mode_key">>();
    expect(row!.verdict).toBe("practice");
    expect(row!.verdict_reason).toBe("guest");
    expect(row!.mode_key).toBe(`daily:${dateKst}`); // 원장에 데일리 판이 남아 alreadyPlayed 판정 근거 유지

    // 게스트 데일리는 스트릭을 올리지 않는다(1일1회 정식 판정은 계정만).
    const user = await env.DB.prepare("SELECT streak_daily FROM users WHERE user_id=?1")
      .bind(pid)
      .first<Pick<UserRow, "streak_daily">>();
    expect(user!.streak_daily).toBe(0);
  });
});

describe("POST /runs/submit — 게스트→계정 브리지(§11-D68-④)", () => {
  it("계정 세션 + 유효 guestToken(pid===runToken.pid) → 계정 pid로 valid 등재", async () => {
    const guest = await bootstrapGuest();
    const acct = await bootstrap();
    // 게스트로 판을 시작(runToken.pid = 게스트 pid).
    const started = (await (await startRun(guest.token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    // 계정 토큰으로 제출하며 guestToken을 함께 보내 두 신원 동시 보유를 증명.
    const res = await submitRun(acct.token, {
      runToken: started.runToken,
      guestToken: guest.token,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SubmitRes).verdict).toBe("valid"); // 계정 등재 — 강등 아님

    // 원장 user_id는 계정 pid(게스트 pid 아님).
    const row = await env.DB.prepare("SELECT user_id, verdict FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<Pick<RunRow, "user_id" | "verdict">>();
    expect(row!.user_id).toBe(acct.pid);
    expect(row!.user_id).not.toBe(guest.pid);
    expect(row!.verdict).toBe("valid");

    // 계정 pid로 lb_best 등재.
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM lb_best WHERE user_id=?1 AND run_id=?2")
      .bind(acct.pid, started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBeGreaterThan(0);
  });

  it("계정 세션 + guestToken 없음 → rejected(invalid_token), 원장 미기록", async () => {
    const guest = await bootstrapGuest();
    const acct = await bootstrap();
    const started = (await (await startRun(guest.token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    const res = await submitRun(acct.token, {
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SubmitRes).verdict).toBe("rejected");
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });

  it("계정 세션 + 다른 게스트의 guestToken(pid 불일치) → rejected", async () => {
    const guestA = await bootstrapGuest();
    const guestB = await bootstrapGuest();
    const acct = await bootstrap();
    const started = (await (await startRun(guestA.token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    const res = await submitRun(acct.token, {
      runToken: started.runToken,
      guestToken: guestB.token, // pid !== runToken.pid → 브리지 불성립
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(((await res.json()) as SubmitRes).verdict).toBe("rejected");
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id=?1")
      .bind(started.runId)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(0);
  });

  it("계정 세션 + 위조 guestToken(서명 무효) → rejected", async () => {
    const guest = await bootstrapGuest();
    const acct = await bootstrap();
    const started = (await (await startRun(guest.token, { mode: "worldtour", lang: "en", platform: "desktop" })).json()) as StartRes;
    const built = buildSubmit(started.countryIds, 2, 80);

    const res = await submitRun(acct.token, {
      runToken: started.runToken,
      guestToken: "wt1.forged.sig", // 서명 무효 → 브리지 불성립
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    });
    expect(((await res.json()) as SubmitRes).verdict).toBe("rejected");
  });
});
