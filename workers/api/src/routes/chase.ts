// spec: docs/09 §9.1(런 시작 — 시드 발급, 랭킹 세트 서버 salt 원칙 승계)·§9.4(constantsVersion),
//       docs/00 §11-D90(경로 /api/v1/chase/start)·D91(결정성·서버 salt)·D93·D94, docs/00 §11-D68
//       (제출 게이팅 — 플레이는 비로그인 허용) + WT-CH-09
//
// POST /chase/start — 골드 러너(chase) 런 시작. 로그인 불필요: requireAuth는 계정·게스트 세션
// 어느 쪽이든 통과시킨다(세션 자체는 필수, D68 제출 게이팅은 /runs/submit의 chase 분기 소관).
// seed는 서버 crypto.getRandomValues 32bit(클라 사전 계산 불가 — 티어/데일리와 동일 원칙, §11-D21).
// runToken은 기존 runs/start(routes/runs.ts) 발급 문법을 그대로 재사용한다.
import { Hono } from "hono";
import { z } from "zod";
import { signRunToken, CHASE_CONSTANTS_VERSION } from "@wt/shared";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";
import { uuidv7 } from "../lib/uuid";
import { KV_KEYS } from "../lib/kv-keys";
import { kstDate } from "../lib/kst";
import { logWarn } from "../lib/log";
import { trackGameStart } from "../lib/telemetry";
import { bumpDailyCounter } from "./runs";

const ChaseStartReqSchema = z
  .object({
    lang: z.enum(["ko", "en"]),
    platform: z.enum(["desktop", "mobile"]),
  })
  .strict();

interface ChaseStartRes {
  runToken: string;
  seed: number;
  constantsVersion: number;
}

export const chase = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

chase.post("/chase/start", requireAuth, rateLimit("chase/start"), async (c) => {
  const pid = c.get("pid");
  const parsed = ChaseStartReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError(400, "INVALID_BODY", "chase/start 요청 형식이 올바르지 않습니다.");
  }
  const { lang, platform } = parsed.data;

  const now = Date.now();
  const rid = uuidv7(now);
  const seed = randomSeed32();
  const version = CHASE_CONSTANTS_VERSION;

  const runToken = await signRunToken(
    c.env.RUN_HMAC_SECRET,
    {
      rid,
      pid,
      mode: "chase",
      // modeKey는 항상 고정 문자열('chase') — 대륙/티어처럼 세분 없음(apps/web api-client.ts
      // modeKeyFor와 동일 값, docs/09 §9.3 lb:chase:* 축).
      modeKey: "chase",
      lang,
      platform,
      // chase엔 "세트"(countryIds 순서) 개념이 없다 — 기존 RunTokenPayload(auth/token.ts, workers/api
      // 밖이라 무수정) 스키마의 setHash 슬롯을 발급 시점 constantsVersion 마커로 재사용해, 별도
      // 페이로드 필드 신설 없이 제출 시 "발급 시점 버전" 재계산 근거로 삼는다(§9.4,
      // lib/chase-config.ts resolveChaseConstantsCandidates가 이 마커를 파싱).
      setHash: `chase:v${version}`,
      seed: String(seed),
    },
    now,
  );

  const body: ChaseStartRes = { runToken, seed, constantsVersion: version };

  // game_start(docs/06 §5.2) + 일별 시작 카운터 — 응답을 막지 않는다(routes/runs.ts와 동일 패턴).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await trackGameStart(c.env, pid, { modeKey: "chase", lang, platform });
        if (c.env.KV) {
          await bumpDailyCounter(c.env.KV, KV_KEYS.telStarts(kstDate(now)));
        }
      } catch (err) {
        logWarn("chase_start_telemetry_failed", { message: err instanceof Error ? err.message : String(err) });
      }
    })(),
  );

  return c.json(body);
});

/**
 * 32bit 부호 없는 시드 1개(§9.1 — 서버 생성, 클라 사전 계산 불가).
 * @param randomBytes 테스트 주입용 seam(기본 crypto.getRandomValues, lib/share-id.ts와 동일 패턴).
 */
function randomSeed32(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): number {
  const b = randomBytes(4);
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}

function defaultRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}
