// spec: docs/04 §6.5(레이트리밋 KV 고정윈도 — LIMITS 표 전문) + WT-M3-02
//
// KV 고정윈도(관대한 1차 방어). KV는 결과적 일관성이라 경계 오차를 허용한다 — 정밀 한도는
// 각 쓰기 엔드포인트의 D1/DO 검증(runToken 재사용 방지 등, docs/06 §3)이 담당한다.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { getClientIp, hashIp } from "../lib/ip-hash";

interface LimitRule {
  per: "ip" | "pid";
  window: number; // seconds
  max: number;
}

/** docs/04 §6.5 LIMITS 표 그대로. 키(scope 문자열)를 바꾸지 말 것 — rl:{scope}:... 로 그대로 쓰인다. */
export const LIMITS = {
  session: { per: "ip", window: 60, max: 10 },
  // POST /auth/google — Google ID-token 검증 → 계정 세션 발급(WT-AUTH-01, docs/04 §2.2-#17).
  // 비인증 라우트(토큰 발급 전)라 IP 기준. 정상 로그인은 IP당 극소수라 10/60s로 충분하다.
  auth: { per: "ip", window: 60, max: 10 },
  "runs/start": { per: "pid", window: 60, max: 10 },
  "runs/submit": { per: "pid", window: 60, max: 10 },
  nickname: { per: "pid", window: 3600, max: 5 },
  "rooms(create)": { per: "pid", window: 60, max: 5 },
  leaderboard: { per: "ip", window: 60, max: 60 },
  // 클라 배칭 텔레메트리(§5.2 "10개/5초" 배치 주기 — WT-M6-03). 배치 1건이 아니라 요청 자체를
  // 제한한다(최대 10개/5초 배칭이면 분당 12회 남짓이 정상 상한, 여유를 둬 IP당 60/분).
  t: { per: "ip", window: 60, max: 60 },
} as const satisfies Record<string, LimitRule>;

export type RateLimitScope = keyof typeof LIMITS;

// Cloudflare Rate Limiting binding(RL) 훅 자리: 콜로 로컬·저지연 이중 방어(docs/04 §6.5 말미).
// v1 초반은 아래 KV 고정윈도만으로 충분 — 트래픽이 임계에 닿으면 여기서 `c.env.RL?.limit(...)`를
// 먼저 호출해 KV 쓰기 자체를 줄이는 형태로 확장한다(env.ts의 RL 바인딩은 이미 자리만 존재).

// [WT-OPT-01, §11-D60] config:loadtest는 요청마다(모든 스코프에서) 매번 KV get을 도는데, 부하
// 테스트 시간·환경에 한정된 완화 플래그라 평시에는 사실상 항상 부재값을 반복 조회하는 낭비다.
// 모듈 스코프로 TTL 5초만 메모한다 — 우회 플래그를 켜고 끄는 시점에 최대 5초의 반영 지연이
// 생기지만, 이 플래그 자체가 "부하 테스트 동안만 수동 세팅"하는 운영 절차 전용이라 5초 지연은
// 무해하다(요청 자체가 초당 수십~수백 건인 부하 테스트 상황을 가정).
const LOADTEST_MEMO_TTL_MS = 5000;
let loadtestMemo: { value: boolean; expiresAt: number } | null = null;

async function isLoadtestActive(kv: KVNamespace): Promise<boolean> {
  const now = Date.now();
  if (loadtestMemo && loadtestMemo.expiresAt > now) return loadtestMemo.value;
  const value = (await kv.get(KV_KEYS.configLoadtest)) !== null;
  loadtestMemo = { value, expiresAt: now + LOADTEST_MEMO_TTL_MS };
  return value;
}

/**
 * 테스트 전용: config:loadtest 모듈 메모를 초기화해 다음 호출이 KV를 강제로 재조회하게 한다.
 * 프로덕션 코드 경로에서는 절대 호출되지 않는다 — vitest-pool-workers가 singleWorker로
 * 전체 실행 동안 모듈 상태를 공유하기 때문에(스토리지만 테스트 단위로 격리), 테스트가 KV의
 * config:loadtest를 직접 put/delete한 직후 "TTL이 지난 것"을 시뮬레이션하려면 이 리셋이 필요하다.
 */
export function __resetLoadtestMemoForTests(): void {
  loadtestMemo = null;
}

/**
 * scope에 해당하는 KV 고정윈도 미들웨어. per:'pid'는 requireAuth 이후에 붙여야
 * `c.get('pid')`가 채워져 있다 — 아직 pid가 없으면(비인증 라우트에 pid 스코프를 잘못 붙인 경우)
 * 방어적으로 'anon' 서브젝트로 묶는다(버그를 숨기지 않도록 별도 감지는 상위 라우트 리뷰 소관).
 *
 * [WT-M6-05] KV `config:loadtest`가 존재하는 동안은 스코프 무관 전체 우회한다. staging k6
 * 부하 테스트(docs/06 §10-#5)에서 세션/runToken 사전 워밍이 `session`(10/60s/IP) 상한과
 * 충돌하는 문제 대응 — 로컬은 signSessionToken 직접 서명으로 우회 가능(rooms-sim 선례)하지만
 * staging은 배포된 비밀값에 접근할 수 없어 이 방법이 불가하다. 켜져 있는 동안은 서버가
 * 자신의 안티치트 임계를 스스로 낮추는 것이므로 **부하 테스트 시간·환경에 한정**해야 한다
 * (tooling/ops/loadtest-report.md의 set/원복 절차 참조 — 절대 prod에 남겨두지 말 것).
 */
export function rateLimit(
  scope: RateLimitScope,
): MiddlewareHandler<{ Bindings: Env; Variables: { pid?: string } }> {
  const rule = LIMITS[scope];

  return async (c, next) => {
    const kv = c.env.KV;
    // 로컬 개발 등 KV 미바인딩 시 관대하게 skip(health.ts와 동일한 톤 — WT-M0-02 패턴 계승).
    if (!kv) {
      await next();
      return;
    }

    if (await isLoadtestActive(kv)) {
      await next();
      return;
    }

    const subject = rule.per === "pid" ? (c.get("pid") ?? "anon") : await hashIp(getClientIp(c));
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / rule.window) * rule.window;
    const key = KV_KEYS.rateLimit(scope, subject, windowStart);

    const raw = await kv.get(key);
    const count = raw ? Number(raw) : 0;

    if (count >= rule.max) {
      const retryAfterSec = Math.max(windowStart + rule.window - nowSec, 1);
      throw new ApiHttpError(429, "RATE_LIMITED", `Rate limit exceeded for scope '${scope}'`, retryAfterSec);
    }

    // TTL은 윈도보다 살짝 여유(+5s)를 둬 경계 근처 조회가 만료로 사라지는 것을 방지.
    await kv.put(key, String(count + 1), { expirationTtl: rule.window + 5 });
    await next();
  };
}
