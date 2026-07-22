// spec: WT-M3-08 후속 핫픽스 — E4 잔여 실패의 실제 근본 원인 수정.
//
// [실측 근거] 리드 감사가 지적한 대로 "즉시 2연속 pnpm e2e" 중 E4가 90s 타임아웃으로 실패하는
// 사례를 이 세션에서 그대로 재현했다(1회차 그린 / 2회차 레드). 실패한 실행의 Playwright 트레이스
// (test-results/.../trace.zip 의 0-trace.network)를 직접 까보면:
//   POST /api/v1/session   -> 429 Too Many Requests
//   POST /api/v1/runs/start -> 401 Unauthorized (세션 실패로 토큰이 없어서)
// 가 그대로 찍혀 있다. 즉 persist-dir 밀폐화(교차 실행 오염)와는 무관하고, **한 번의 pnpm e2e
// 실행 안에서** workers/api/src/mw/ratelimit.ts의 LIMITS.session({per:'ip', window:60, max:10})
// 고정 60초 윈도 상한을 이 스위트 자신의 세션 부트스트랩 호출량이 넘겨버리는 것이 원인이다.
//
// 이 스위트가 한 번 실행되는 동안 POST /session을 유발하는 지점은:
//   - cheat-suite.spec.ts: 시나리오 8개 × bootstrapSession() 각 1회 = 8
//   - e1-first-visit: page.goto('/') → bootLoader 자동 부트스트랩 = 1
//   - e2-ime-precision: enterGame() 3회(E2a/E2b/E2c) = 3
//   - e3-miss-skip: enterGame() 1회 = 1
//   - e4-survival: gotoBoarding() 1회 = 1
//   합계 14회 — 이 호출들이 실제로 실행되는 짧은 시간(수십 초) 안에 몰리면 서버의 60초 윈도당
//   10회 상한에 근접·초과한다. 스위트를 몇 초 차이로 반복 실행할 때마다 이 14회가 60초 윈도
//   경계와 우연히 어떻게 겹치느냐로 통과/실패가 갈렸다 — 이번 세션의 "1회차 그린, 2회차 레드"가
//   그 증거다.
//
// [수정 방향] 서버의 레이트리밋 자체를 완화하는 것은 작업 지시로 금지(안티치트/서버 검증 로직
// 불변, 인프라만 수정 가능). 대신 E2E 스스로 이 상한을 절대 넘기지 않도록 자기 페이싱한다 —
// 실제 트래픽이었어도 지켜야 했을 제약이므로 서버 정책과 충돌하지 않는, 유일하게 인프라
// 영역(e2e/) 안에서 가능한 수정이다. 서버와 동일한 60초 "고정 윈도"(now를 60000ms 배수로 내림)
// 를 그대로 재현해, 그 윈도 안에서 이미 SAFE_LIMIT_PER_WINDOW회를 예약했으면 다음 윈도 경계까지
// 대기한다.
//
// playwright.config.ts가 `workers: 1`(완전 직렬)이라 이 모듈의 싱글턴 카운터가 스위트 전체
// (모든 스펙 파일 — 같은 워커 프로세스에서 순서대로 실행됨)에 걸쳐 정확히 누적된다. 세션을
// 유발하는 모든 경로(helpers/game.ts의 gotoBoarding, helpers/forge.ts의 bootstrapSession,
// e1 스펙의 최초 page.goto('/'))가 이 모듈 하나를 통해 슬롯을 예약한다.
const WINDOW_MS = 60_000;
// 서버 상한(10)보다 여유 있게 낮춰, "예약 시점"과 "브라우저/서버가 실제로 POST /session을
// 주고받는 시점" 사이의 수십~수백ms 스큐를 흡수한다.
const SAFE_LIMIT_PER_WINDOW = 7;

let windowStart = 0;
let countInWindow = 0;
let totalReserved = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 세션 부트스트랩(혹은 세션 부트스트랩을 유발하는 페이지 로드)을 일으키기 **직전**에 반드시
 * `await`할 것. 서버의 `session` 스코프 60초 고정 윈도 안에서 SAFE_LIMIT_PER_WINDOW번째 이하
 * 예약이 되도록, 이미 한도에 닿았으면 다음 윈도 경계까지 대기한 뒤에만 반환한다.
 */
export async function reserveSessionSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const curWindow = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    if (curWindow !== windowStart) {
      windowStart = curWindow;
      countInWindow = 0;
    }
    if (countInWindow < SAFE_LIMIT_PER_WINDOW) {
      countInWindow += 1;
      totalReserved += 1;
      return;
    }
    const waitMs = windowStart + WINDOW_MS - now + 50;
    await sleep(Math.max(waitMs, 50));
  }
}

/** notes 보고용 — 이번 워커 프로세스(= 이번 pnpm e2e 1회 실행 전체, workers:1이라 단일 프로세스)
 *  안에서 예약된 세션 부트스트랩 총량. */
export function totalSessionSlotsReserved(): number {
  return totalReserved;
}
