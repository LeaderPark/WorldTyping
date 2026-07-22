// spec: docs/06 §6.2(처리 항목 인벤토리)·§6.3(열람/삭제권 구현 전문 — "즉시 처리")·§6.5,
//       docs/04 §10.4(GDPR (a) 접근/삭제권), docs/00 §11-D38(user_id=pid — 재부트스트랩 시
//       "device_hash 매핑 해제"의 실질 의미), docs/07 WT-M6-01 [완료 조건]
//
// GET /users/me/export·DELETE /users/me + 삭제 후 같은 deviceId 재부트스트랩(§3 세션 조정
// "재부트스트랩 시 신규 유저 테스트 필수") 종단 검증.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { derivePlayerId } from "@wt/shared";
import { runLbRefresher } from "../src/cron/lb-refresher";
import { readBoardCache } from "../src/lib/lb";

const BASE = "http://local/api/v1";

interface BootstrapRes {
  token: string;
  playerId: string;
  nickname: string;
}

async function bootstrap(deviceId = crypto.randomUUID()): Promise<BootstrapRes & { deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  const body = (await res.json()) as BootstrapRes;
  return { ...body, deviceId };
}

function authed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
  });
}

async function insertRun(runId: string, userId: string, verdict = "valid"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (
       run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
       countries_cleared, countries_skipped, max_combo, completed, grade, seed, session_id,
       verdict, verdict_reason, geo, detail_json, created_at
     ) VALUES (?1, ?2, 'worldtour', 'en', 'desktop', 500, 400, 300, 950, 60000, 20, 1, 15, 1, 'A',
       NULL, ?1, ?3, NULL, 'KR', ?4, ?5)`,
  )
    .bind(runId, userId, verdict, JSON.stringify({ perCountry: [{ code: "KR", ms: 1000 }] }), now)
    .run();
}

async function insertUnlock(userId: string, unlockId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_unlocks (user_id, unlock_type, unlock_id, meta_json, created_at) VALUES (?1, 'achievement', ?2, NULL, ?3)`,
  )
    .bind(userId, unlockId, Date.now())
    .run();
}

async function insertLbBest(boardKey: string, userId: string, runId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lb_best (board_key, user_id, run_id, score, elapsed_ms, acc_milli, achieved_at, geo)
     VALUES (?1, ?2, ?3, 500, 60000, 950, ?4, 'KR')`,
  )
    .bind(boardKey, userId, runId, Date.now())
    .run();
}

describe("GET /api/v1/users/me/export", () => {
  it("401s without a session bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/users/me/export`);
    expect(res.status).toBe(401);
  });

  it("200s with user/runs/unlocks — runs are summaries only (no detail_json/perCountry leak)", async () => {
    const { token, playerId } = await bootstrap();
    await insertRun("run-export-1", playerId);
    await insertUnlock(playerId, "ach:first_flight");

    const res = await authed("/users/me/export", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(playerId);

    const body = (await res.json()) as {
      user: { userId: string; nickname: string; status: string };
      runs: Array<Record<string, unknown>>;
      unlocks: Array<{ id: string }>;
    };
    expect(body.user.userId).toBe(playerId);
    expect(body.user.status).toBe("active");
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ runId: "run-export-1", modeKey: "worldtour", score: 500 });
    // "요약"(§6.3) — 원시 perCountry/입력 페이로드(detail_json)는 export 필드에 없어야 한다.
    expect(body.runs[0]).not.toHaveProperty("detailJson");
    expect(body.runs[0]).not.toHaveProperty("perCountry");
    expect(body.unlocks).toEqual([{ type: "achievement", id: "ach:first_flight", meta: null, createdAt: expect.any(Number) }]);
  });
});

describe("DELETE /api/v1/users/me", () => {
  it("401s without a session bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/users/me`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("anonymizes nickname, clears detail_json, removes lb_best/unlocks, sets status=deleted, and marks affected boards dirty", async () => {
    const { token, playerId } = await bootstrap();
    await insertRun("run-del-1", playerId);
    await insertUnlock(playerId, "ach:first_flight");
    const boardKey = "worldtour|en|desktop|all";
    await insertLbBest(boardKey, playerId, "run-del-1");

    const res = await authed("/users/me", token, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; deletedAt: number; cacheMaxDelaySec: number };
    expect(body.ok).toBe(true);
    expect(body.cacheMaxDelaySec).toBe(600);

    const userRow = await env.DB
      .prepare(`SELECT nickname, nickname_norm, device_hash, status FROM users WHERE user_id = ?1`)
      .bind(playerId)
      .first<{ nickname: string; nickname_norm: string; device_hash: string; status: string }>();
    expect(userRow?.nickname).toBe("탈퇴한 여행자");
    expect(userRow?.nickname_norm).toBe(`deleted:${playerId}`);
    expect(userRow?.device_hash).toBe(`deleted:${playerId}`);
    expect(userRow?.status).toBe("deleted");

    const runRow = await env.DB
      .prepare(`SELECT detail_json FROM runs WHERE run_id = 'run-del-1'`)
      .first<{ detail_json: string }>();
    expect(runRow?.detail_json).toBe("{}");

    const lbCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM lb_best WHERE user_id = ?1`)
      .bind(playerId)
      .first<{ n: number }>();
    expect(Number(lbCount?.n ?? -1)).toBe(0);

    const unlockCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM user_unlocks WHERE user_id = ?1`)
      .bind(playerId)
      .first<{ n: number }>();
    expect(Number(unlockCount?.n ?? -1)).toBe(0);

    // §1.5 dirty 마킹 — 삭제 전 이 유저가 올라 있던 보드는 즉시 dirty:{board}가 찍혀야
    // cron(*/1)이 다음 분에 top-100을 재조회해 리더보드에서 사라진다.
    const dirty = await env.KV.get(`dirty:${boardKey}`);
    expect(dirty).toBe("1");
  });

  it("integration: after delete, running the lb-refresher cron actually clears the board from the KV cache (§6.3 '최대 10분' 고지의 실제 파이프라인)", async () => {
    const { token, playerId } = await bootstrap();
    await insertRun("run-del-integ", playerId);
    const boardKey = "worldtour|en|desktop|all";
    await insertLbBest(boardKey, playerId, "run-del-integ");
    // 삭제 전 상태 확인용으로 캐시를 한 번 데워둔다(실제 운영에서도 top-100 캐시는 이미 이
    // 유저를 포함해 채워져 있었을 것 — refresher가 정말로 "소거"하는지 보려면 갱신 전 상태가
    // 있어야 한다). 이 보드는 아직 dirty 마킹이 없어(직접 SQL로 넣었으므로) minute%10===0인
    // "콜드 전량" 분기를 강제로 태워야 캐시가 채워진다(cron/lb-refresher.ts 참조) — 실행 시각의
    // 실제 분(minute)에 의존하면 테스트가 비결정적이 되므로 :00 경계로 고정한다.
    const coldTick = Date.now() - (Date.now() % (10 * 60 * 1000));
    await runLbRefresher(env, coldTick);
    const before = await readBoardCache(env.KV, boardKey);
    expect(before?.entries.some((e) => e.userId === playerId)).toBe(true);

    await authed("/users/me", token, { method: "DELETE" });
    // dirty 마킹 덕에 cron 한 번만 더 돌아도(현실에서는 매분) 캐시가 갱신된다 — "최대 10분"은
    // 문서상 상한일 뿐 실제로는 이 한 번의 refresher tick으로 충분함을 확인한다.
    await runLbRefresher(env, Date.now());

    const after = await readBoardCache(env.KV, boardKey);
    // 이 유저가 유일한 등재자였다면 refreshBoardCache가 총원 0으로 판단해 캐시 키 자체를
    // 지운다(lb.ts refreshBoardCache) — null이거나, 남아있어도 이 유저는 빠져 있어야 한다.
    expect(after === null || !after.entries.some((e) => e.userId === playerId)).toBe(true);
  });

  it("is idempotent: deleting an already-deleted account returns 200 ok without error", async () => {
    const { token } = await bootstrap();
    const first = await authed("/users/me", token, { method: "DELETE" });
    expect(first.status).toBe(200);
    const second = await authed("/users/me", token, { method: "DELETE" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { ok: true };
    expect(body.ok).toBe(true);
  });
});

describe("re-bootstrap after deletion (D38 재확인 — device_hash 매핑 해제의 실질 의미)", () => {
  it("re-bootstrapping the same deviceId after DELETE /users/me comes back as a fresh-looking user, not the anonymized ghost", async () => {
    const deviceId = crypto.randomUUID();
    const { token, playerId } = await bootstrap(deviceId);
    await authed("/users/me", token, { method: "DELETE" });

    // 삭제 직후 조회하면 익명화된 상태가 그대로 보인다(delete 자체는 즉시 반영 — 재확인).
    const meAfterDelete = await authed("/session/me", token);
    const deletedBody = (await meAfterDelete.json()) as { nickname: string; status: string };
    expect(deletedBody.status).toBe("deleted");
    expect(deletedBody.nickname).toBe("탈퇴한 여행자");

    // D38(user_id=pid 결정적 파생)이라 같은 deviceId는 항상 같은 playerId로 돌아온다 — "새
    // user_id 발급"은 애초에 불가능한 설계다. 대신 세션 부트스트랩이 이 행을 리셋해 돌려준다.
    const rebooted = (await (
      await SELF.fetch(`${BASE}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      })
    ).json()) as BootstrapRes;

    expect(rebooted.playerId).toBe(playerId);
    expect(await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId)).toBe(playerId);
    // 신규 유저와 동일한 형태의 기본 닉네임으로 리셋 — 탈퇴 흔적(익명화 닉네임)이 남지 않는다.
    expect(rebooted.nickname).toMatch(/^GUEST_[0-9A-Z]{4}$/);
    expect(rebooted.nickname).not.toBe("탈퇴한 여행자");

    const meAfterReboot = await authed("/session/me", rebooted.token);
    const rebootedBody = (await meAfterReboot.json()) as { nickname: string; status: string };
    expect(rebootedBody.status).toBe("active");
    expect(rebootedBody.nickname).toBe(rebooted.nickname);

    // 스트릭/커버도 신규 가입과 동일한 초기값으로 리셋됐는지 DB에서 직접 재확인.
    const row = await env.DB
      .prepare(`SELECT streak_daily, streak_updated, passport_cover, device_hash FROM users WHERE user_id = ?1`)
      .bind(playerId)
      .first<{ streak_daily: number; streak_updated: string | null; passport_cover: string; device_hash: string }>();
    expect(row?.streak_daily).toBe(0);
    expect(row?.streak_updated).toBeNull();
    expect(row?.passport_cover).toBe("basic-green");
    // device_hash가 삭제 센티널("deleted:{pid}")에서 실제 파생값으로 되돌아왔는지 — 이것이
    // 이 구현이 채택한 "매핑 해제" 의미다(unlink가 아니라 다음 부트스트랩에서의 리셋, me.ts
    // 상단 주석 참조).
    expect(row?.device_hash).not.toBe(`deleted:${playerId}`);
  });
});
