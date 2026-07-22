// spec: docs/04 §2.3-1(SessionReq/Res)·§5(신원/세션 모델)·§6.5(레이트리밋), docs/06 §4.1(bootstrap),
//       WT-M3-02 [구현 세부 지시] #4 — 토큰 발급→검증 왕복 / refresh / 잘못된 prevToken 무시 /
//       레이트리밋 초과 429 / GET /session/me(보호 라우트) 를 그대로 커버한다.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { derivePlayerId, signToken, verifyToken, SessionPayloadSchema } from "@wt/shared";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

async function postSession(body: unknown, ip?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/session", () => {
  it("bootstraps a brand-new device: issues a wt1 token that round-trips through verifyToken", async () => {
    const deviceId = crypto.randomUUID();
    const res = await postSession({ deviceId });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      token: string;
      playerId: string;
      nickname: string;
      expiresAt: string;
      geo: string;
    };

    expect(body.playerId).toHaveLength(12);
    // 기본 닉네임 접미사는 base58(playerId) 마지막 4자를 대문자화한 것 — 순수 hex는 아니다.
    expect(body.nickname).toMatch(/^GUEST_[0-9A-Z]{4}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // 테스트 fetch는 cf.country를 실어 보내지 않아(§11-D44) "XX" 폴백이 관측된다.
    expect(body.geo).toBe("XX");

    const verified = await verifyToken(body.token, env.SESSION_HMAC_SECRET, SessionPayloadSchema);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.pid).toBe(body.playerId);
    }

    // 결정적 파생: 같은 deviceId는 항상 같은 playerId(§11-D10 취지 그대로 재확인).
    expect(await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId)).toBe(body.playerId);
  });

  it("re-bootstrapping the same device does not change playerId/nickname", async () => {
    const deviceId = crypto.randomUUID();
    const first = (await (await postSession({ deviceId })).json()) as { playerId: string; nickname: string };
    const second = (await (await postSession({ deviceId })).json()) as { playerId: string; nickname: string };
    expect(second.playerId).toBe(first.playerId);
    expect(second.nickname).toBe(first.nickname);
  });

  it("rolling refresh: prevToken with < 7 days remaining is rotated to a fresh 30-day token", async () => {
    const deviceId = crypto.randomUUID();
    // 먼저 정상 부트스트랩해 D1에 유저 행을 만들어 둔다 — "신규 유저는 항상 재발급" 가드가
    // 리프레시 판정을 가리지 않게 하기 위함(실제 클라 흐름과 동일한 순서).
    await postSession({ deviceId });
    const pid = await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId);
    const now = Date.now();
    const nearExpiry = await signToken(
      { v: 1 as const, pid, iat: now - 23 * DAY_MS, exp: now + 6 * DAY_MS },
      env.SESSION_HMAC_SECRET,
    );

    const res = await postSession({ deviceId, prevToken: nearExpiry });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; playerId: string; expiresAt: string };

    expect(body.playerId).toBe(pid);
    expect(body.token).not.toBe(nearExpiry);
    // 새 토큰의 만료는 지금부터 다시 30일 — 원래 exp(now+6d)보다 뒤여야 한다.
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(now + 20 * DAY_MS);
  });

  it("does NOT rotate a prevToken that still has > 7 days remaining (returns it unchanged)", async () => {
    const deviceId = crypto.randomUUID();
    await postSession({ deviceId }); // bootstrap first — see rationale in the test above.
    const pid = await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId);
    const now = Date.now();
    const farExpiry = await signToken(
      { v: 1 as const, pid, iat: now, exp: now + 20 * DAY_MS },
      env.SESSION_HMAC_SECRET,
    );

    const res = await postSession({ deviceId, prevToken: farExpiry });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };

    expect(body.token).toBe(farExpiry);
    expect(body.expiresAt).toBe(new Date(now + 20 * DAY_MS).toISOString());
  });

  it("ignores a malformed/invalid prevToken and falls back to the deviceId re-issue path", async () => {
    const deviceId = crypto.randomUUID();
    const res = await postSession({ deviceId, prevToken: "not-a-real-token" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { token: string; playerId: string };
    expect(body.playerId).toBe(await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId));

    const verified = await verifyToken(body.token, env.SESSION_HMAC_SECRET, SessionPayloadSchema);
    expect(verified.ok).toBe(true);
  });

  it("ignores a well-formed prevToken signed for a different device (pid mismatch)", async () => {
    const deviceId = crypto.randomUUID();
    const otherPid = await derivePlayerId(env.SESSION_HMAC_SECRET, crypto.randomUUID());
    const now = Date.now();
    const foreignToken = await signToken(
      { v: 1 as const, pid: otherPid, iat: now, exp: now + 20 * DAY_MS },
      env.SESSION_HMAC_SECRET,
    );

    const res = await postSession({ deviceId, prevToken: foreignToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; playerId: string };
    expect(body.playerId).toBe(await derivePlayerId(env.SESSION_HMAC_SECRET, deviceId));
    expect(body.token).not.toBe(foreignToken);
  });

  it("rejects a body that fails zod .strict() validation", async () => {
    const res = await postSession({ deviceId: "not-a-uuid" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");

    const res2 = await postSession({ deviceId: crypto.randomUUID(), extra: "nope" });
    expect(res2.status).toBe(400);
  });

  it("returns 429 RATE_LIMITED with retryAfterSec once the fixed-window session limit (10/60s per IP) is exceeded", async () => {
    const ip = "203.0.113.42";
    const results: Response[] = [];
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 고정윈도 순서 보장을 위해 의도적으로 직렬 실행.
      results.push(await postSession({ deviceId: crypto.randomUUID() }, ip));
    }
    const statuses = results.map((r) => r.status);
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(statuses[10]).toBe(429);

    const body = (await results[10]!.json()) as { error: { code: string; retryAfterSec?: number } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfterSec).toBeGreaterThan(0);
  });

  // §11-D53: NEW_PID_ABUSE_MAX(20/h) 하드코딩 → config:anticheat KV 핫스왑(newPidAbuseMaxPerHour).
  it("D53: config:anticheat KV의 newPidAbuseMaxPerHour를 낮추면 그 즉시 더 적은 신규 pid로 IP_BLOCKED가 발화한다", async () => {
    const ip = "203.0.113.99";
    await env.KV.put(
      KV_KEYS.configAnticheat,
      JSON.stringify({
        minMsPerKeystroke: 35,
        cpmHardCapKo: 1100,
        cpmHardCapEn: 1000,
        cpmSoftCapKo: 950,
        cpmSoftCapEn: 900,
        rhythmCvThreshold: 0.12,
        rhythmSpreadMsThreshold: 25,
        burstMaxThreshold: 3,
        growthJumpFactor: 0.6,
        growthMinSample: 5,
        accComboCpmThreshold: 800,
        timeEnvelopeGraceMs: 3000,
        sumMsToleranceLowFactor: 0.99,
        sumMsToleranceHighFactor: 1.01,
        sumMsToleranceFlatMs: 500,
        scoreMismatchTolerance: 1,
        rejectedShadowbanThreshold: 3,
        multi: { reactionFloorMs: 250, maxKps: { ko: 14, en: 18 } },
        newPidAbuseMaxPerHour: 2, // 기본 20 → 2로 핫스왑
      }),
    );
    try {
      // 세션 자체 레이트리밋(10/60s)에 걸리지 않도록 한도(2) 근처에서만 확인한다.
      const r1 = await postSession({ deviceId: crypto.randomUUID() }, ip);
      const r2 = await postSession({ deviceId: crypto.randomUUID() }, ip);
      const r3 = await postSession({ deviceId: crypto.randomUUID() }, ip);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(403);
      const body3 = (await r3.json()) as { error: { code: string } };
      expect(body3.error.code).toBe("IP_BLOCKED");
    } finally {
      await env.KV.delete(KV_KEYS.configAnticheat); // 다른 테스트에 영향 없게 원복
    }
  });
});

describe("GET /api/v1/session/me (protected route - Bearer auth demonstration)", () => {
  it("401s with no Authorization header", async () => {
    const res = await SELF.fetch(`${BASE}/session/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TOKEN");
  });

  it("401s with a garbage bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/session/me`, {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("200s and echoes the caller's identity when a valid session token from POST /session is presented", async () => {
    const deviceId = crypto.randomUUID();
    const issued = (await (await postSession({ deviceId })).json()) as {
      token: string;
      playerId: string;
      nickname: string;
    };

    const res = await SELF.fetch(`${BASE}/session/me`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playerId: string; nickname: string; status: string; geo: string };
    expect(body.playerId).toBe(issued.playerId);
    expect(body.nickname).toBe(issued.nickname);
    expect(body.status).toBe("active");
    expect(body.geo).toBe("XX"); // §11-D44 — 미확보 지역은 항상 "XX"
  });
});
