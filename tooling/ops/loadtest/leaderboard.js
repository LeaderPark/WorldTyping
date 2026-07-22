// spec: docs/06 §10-#5(부하 테스트 (b) — 리더보드 읽기 1,000rps, KV 히트율>95%), docs/00 §1.4
//       (SLO 표 — LB 첫 페이지 p95<100ms), docs/06 §1.5(3계층 캐싱: KV top-100 / D1 keyset) +
//       WT-M6-05
//
// GET /api/v1/lb 부하. 90%는 커서·지역 없는 1페이지(§1.5 KV 히트 경로), 10%는 실제 cursor로
// 다음 페이지를 요청(§1.5 "커서/지역 페이지는 항상 D1 keyset" 경로 — KV를 우회시켜 D1 조회
// 비중도 함께 관측한다). setup()에서 board를 한 번 조회해 진짜 nextCursor를 얻어 그 값을 VU들이
// 공유한다(가짜 커서 하드코딩 금지 — 실 페이지네이션 응답을 그대로 재사용).
//
// board는 gen-fixtures.ts가 쓰는 것과 동일한 continent:CONTINENT|lang|desktop|all 보드다
// (lb-board.json). 이 보드는 submit.js 실행 자체가 채운다 — 완주 여부와 무관하게 verdict='valid'면
// lb_best에 반영되므로(runs.ts doBoard 게이트) 별도 "완주" 시드 스텝이 필요 없다(gen-fixtures.ts
// 상단 주석 참조: 즉시 제출 방식은 시간 봉투에 걸려 폐기했다). 대상 보드에 LB_PAGE_SIZE(50)를
// 넘는 유효 기록이 있어야 nextCursor가 null이 아니다 — SUBMIT_COUNT(기본 1,500) > 50이면 충분.
// 실행 순서: gen-fixtures.ts → submit.js(보드 시딩 겸 제출 부하) → leaderboard.js.
//
// 사용(로컬 스모크, 리드 조정 3항 — 1,000rps는 스펙값, 로컬 실행은 축소):
//   node --import tsx tooling/ops/loadtest/gen-fixtures.ts   # 보드 시드(submit 픽스처와 동시 발급)
//   k6 run tooling/ops/loadtest/leaderboard.js                # 기본 100rps/60s(로컬 스모크)
//   RPS=1000 DURATION=1m k6 run tooling/ops/loadtest/leaderboard.js  # staging에서 스펙값 그대로
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.WT_BASE || 'http://127.0.0.1:8787';
// 기본값은 "로컬 스모크"(리드 조정 3항: LB 100rps 1분) — staging 정식 실행은 RPS=1000로 override.
const RPS = Number(__ENV.RPS || 100);
const DURATION = __ENV.DURATION || '60s';
// k6 open()은 스크립트 자신의 위치 기준 상대경로다(cwd 기준 아님) — submit.js와 동일 사유.
// 또한 open()은 init 스테이지(모듈 최상위)에서만 호출 가능하다 — setup() 안에서 부르면
// "only available in the init stage" 예외가 난다. 그래서 여기 최상위에서 미리 읽어 둔다.
const BOARD_FILE = __ENV.BOARD_FILE || './.out/lb-board.json';
const BOARD_OVERRIDE = __ENV.BOARD || '';
const BOARD_FROM_FILE = BOARD_OVERRIDE ? null : JSON.parse(open(BOARD_FILE)).board;
// 커서 페이지 비중(§10-#5 "커서 페이지 혼합 10%") — 10건 중 1건.
const CURSOR_EVERY_N = 10;

export const options = {
  scenarios: {
    lb: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, Math.ceil(RPS / 2)),
      maxVUs: Math.max(50, RPS * 3),
    },
  },
  thresholds: {
    // docs/00 §1.4 "LB 첫 페이지 p95<100ms" — top(KV 히트 경로)에만 적용. cursor(D1 keyset)
    // 경로는 SLO 대상이 아니라 별도 태그로만 관측(§1.4의 대상은 "LB 첫 페이지"뿐).
    'http_req_duration{page:top}': ['p(95)<100'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const board = BOARD_OVERRIDE || BOARD_FROM_FILE;
  const res = http.get(`${BASE}/api/v1/lb?board=${encodeURIComponent(board)}`, { tags: { page: 'top' } });
  let cursor = null;
  let total = 0;
  try {
    const body = res.json();
    cursor = body.nextCursor ?? null;
    total = body.total ?? 0;
  } catch {
    /* 아래 검증에서 드러남 */
  }
  if (res.status !== 200) {
    throw new Error(`setup: 보드 예열 실패 status=${res.status} board=${board} — gen-fixtures.ts를 먼저 실행했는가?`);
  }
  console.log(`[leaderboard.js] board=${board} total=${total} cursor=${cursor ? '있음' : '없음(entries<=50)'}`);
  return { board, cursor };
}

export default function (data) {
  const isCursorPage = data.cursor !== null && exec.scenario.iterationInTest % CURSOR_EVERY_N === CURSOR_EVERY_N - 1;
  let url = `${BASE}/api/v1/lb?board=${encodeURIComponent(data.board)}`;
  const tag = isCursorPage ? 'cursor' : 'top';
  if (isCursorPage) url += `&cursor=${encodeURIComponent(data.cursor)}`;

  const res = http.get(url, { tags: { page: tag } });

  check(res, {
    'status 200': (r) => r.status === 200,
    'entries 배열': (r) => {
      try {
        return Array.isArray(r.json('entries'));
      } catch {
        return false;
      }
    },
  });
}
