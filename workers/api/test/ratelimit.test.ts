// spec: docs/04 §6.5(레이트리밋 KV 고정윈도 — LIMITS 표), docs/06 §10-#5(부하 테스트),
//       docs/00 §11-D53(안티치트 임계 핫스왑 원칙 계승) + WT-M6-05
//
// mw/ratelimit.ts의 두 계약을 검증한다: ① 정상 상태에서는 scope별 max를 넘으면 429, ② KV
// `config:loadtest` 플래그가 존재하는 동안은 스코프 무관 전체 우회(부하 테스트 전용 완화,
// staging에서 signSessionToken 직접 서명이 불가능해 이 경로가 유일한 완화 수단이다).
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { KV_KEYS } from "../src/lib/kv-keys";

const BASE = "http://local/api/v1";

function bootstrap(): Promise<Response> {
  return SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
}

describe("mw/ratelimit — config:loadtest 우회", () => {
  beforeEach(async () => {
    // 각 케이스가 이전 케이스의 rl:session 윈도 카운터에 영향받지 않도록 정리.
    await env.KV.delete(KV_KEYS.configLoadtest);
  });

  it("평시: session 스코프는 10회/60s를 넘으면 429(RATE_LIMITED)", async () => {
    // 동일 IP(테스트 환경은 CF-Connecting-IP 헤더가 없어 'unknown' 서브젝트로 고정)로 10회는
    // 통과, 11번째는 429여야 한다.
    for (let i = 0; i < 10; i++) {
      const res = await bootstrap();
      expect(res.status).toBe(200);
    }
    const eleventh = await bootstrap();
    expect(eleventh.status).toBe(429);
    const body = (await eleventh.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  it("config:loadtest 존재 시: 동일 IP로 10회 초과해도 계속 200(전체 우회)", async () => {
    await env.KV.put(KV_KEYS.configLoadtest, String(Date.now() + 2 * 60 * 60 * 1000));

    for (let i = 0; i < 15; i++) {
      const res = await bootstrap();
      expect(res.status).toBe(200);
    }
  });

  it("config:loadtest 삭제(원복) 후에는 다시 정상 레이트리밋이 적용된다", async () => {
    // 신규 pid 어뷰징 상한(기본 20/h, D53)에 이 케이스가 걸리지 않도록 총 발급 수를 예산 안에
    // 맞춘다: 우회 구간 9회(전부 새 유저 — 카운터 9) + 원복 후 11회 중 처음 10회만 새 유저로
    // 카운터에 반영(count 9→19)되고, 11번째는 세션 스코프 제너릭 한도(10/60s)에 걸려 그 미들웨어
    // 단계에서 바로 429가 나 핸들러(신규 pid 카운터 증가 지점)에 도달하지 않는다 — 그래서 이
    // 시나리오 전체가 20/h 문턱을 절대 건드리지 않는다(IP_BLOCKED로 오염돼 429 관측이 불가능해지는
    // 사고 방지).
    await env.KV.put(KV_KEYS.configLoadtest, "1");
    for (let i = 0; i < 9; i++) {
      const res = await bootstrap();
      expect(res.status).toBe(200);
    }
    await env.KV.delete(KV_KEYS.configLoadtest);

    // 우회 동안은 config:loadtest 분기가 rl:session 카운터 자체를 건드리지 않고 조기 반환하므로,
    // 원복 직후 제너릭 세션 한도(10/60s)는 0부터 다시 시작한다 — 10회는 통과, 11번째가 429.
    for (let i = 0; i < 10; i++) {
      const res = await bootstrap();
      expect(res.status).toBe(200);
    }
    const eleventh = await bootstrap();
    expect(eleventh.status).toBe(429);
  });
});

describe("mw/ratelimit — leaderboard 스코프 배선(GET /lb, GET /lb/me) — WT-M6-05 수정", () => {
  // 두 라우트 모두 같은 scope('leaderboard', 60/60s/IP)를 쓴다 — subject는 IP 해시라 인증
  // 여부와 무관하게 카운터를 공유한다(§04 §6.5). 이 스위트가 쓰는 IP는 다른 테스트(lb.test.ts
  // 등)와 격리(isolatedStorage=true 기본값 — 매 it()이 독립 스토리지)돼 영향받지 않는다.
  const VALID_BOARD = "tier:1|en|desktop|all";

  function getLb(): Promise<Response> {
    return SELF.fetch(`${BASE}/lb?board=${encodeURIComponent(VALID_BOARD)}`);
  }

  async function bootstrapAuth(): Promise<string> {
    const res = await bootstrap();
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  function getLbMe(token: string): Promise<Response> {
    return SELF.fetch(`${BASE}/lb/me?board=${encodeURIComponent(VALID_BOARD)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  beforeEach(async () => {
    await env.KV.delete(KV_KEYS.configLoadtest);
  });

  it("평시: leaderboard 스코프는 60회/60s를 넘으면 61번째 요청이 429(RATE_LIMITED)", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await getLb();
      expect(res.status).toBe(200);
    }
    const sixtyFirst = await getLb();
    expect(sixtyFirst.status).toBe(429);
    const body = (await sixtyFirst.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  it("GET /lb와 GET /lb/me는 동일 scope를 공유 — /lb에서 소진된 카운터가 /lb/me도 429로 막는다", async () => {
    const token = await bootstrapAuth();
    for (let i = 0; i < 60; i++) {
      const res = await getLb();
      expect(res.status).toBe(200);
    }
    const me = await getLbMe(token);
    expect(me.status).toBe(429);
  });

  it("config:loadtest 존재 시: leaderboard 스코프도 60회 초과해 계속 200(전체 우회)", async () => {
    await env.KV.put(KV_KEYS.configLoadtest, String(Date.now() + 2 * 60 * 60 * 1000));
    const token = await bootstrapAuth();

    for (let i = 0; i < 65; i++) {
      const res = await getLb();
      expect(res.status).toBe(200);
    }
    const me = await getLbMe(token);
    expect(me.status).toBe(200);
  });
});
