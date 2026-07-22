// spec: docs/06 §10-#5(부하 테스트 (a) — 기록 제출 200rps 5분, D1 batch p95<250ms), docs/00 §1.4
//       (SLO 표 — 제출 p95<250ms), docs/04 §6.1~§6.2(제출 파이프라인) + WT-M6-05
//
// POST /api/v1/runs/submit 부하. 페이로드는 이 파일이 만드는 게 아니라 gen-fixtures.ts가 실제
// @wt/shared(HMAC 서명·점수 계산)로 미리 발급해 둔 (세션토큰, runToken, 물리적으로 타당한 제출
// 바디) 튜플을 읽기만 한다(k6=goja 런타임은 npm import 불가 — CLAUDE.md 판정/점수 로직 shared
// 밖 재구현 금지 원칙을 지키기 위해 사전 발급 스크립트 쪽에 그 책임을 둔 구조).
//
// 사용(로컬 스모크, 리드 조정 3항 — 200rps/5분은 스펙값, 로컬 실행은 축소):
//   pnpm --filter @wt/api run e2e:dev                          # 별도 터미널
//   node --import tsx tooling/ops/loadtest/gen-fixtures.ts       # 픽스처 사전 발급
//   k6 run tooling/ops/loadtest/submit.js                        # 기본 20rps/60s(로컬 스모크)
//   RPS=200 DURATION=5m k6 run tooling/ops/loadtest/submit.js     # staging에서 스펙값 그대로
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE = __ENV.WT_BASE || 'http://127.0.0.1:8787';
// 기본값은 "로컬 스모크"(리드 조정 3항: 제출 20rps 1분) — staging 정식 실행은 RPS=200 DURATION=5m로 override.
const RPS = Number(__ENV.RPS || 20);
const DURATION = __ENV.DURATION || '60s';
// k6 open()/-경로는 스크립트 파일 자신의 위치 기준 상대경로다(cwd 기준이 아님) — 저장소 루트에서
// 실행하든 이 디렉터리에서 실행하든 항상 같은 파일을 가리키도록 './.out/...'로 둔다.
const FIXTURE_PATH = __ENV.FIXTURE_PATH || './.out/submit-fixture.json';

// SharedArray는 VU 간 메모리를 공유해 1,500건 픽스처를 VU마다 복제하지 않는다.
const fixtures = new SharedArray('submit-fixtures', function () {
  const raw = JSON.parse(open(FIXTURE_PATH));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `submit-fixture.json이 비어있다 — 먼저 gen-fixtures.ts를 실행했는지 확인: ${FIXTURE_PATH}`,
    );
  }
  return raw;
});

export const options = {
  scenarios: {
    submit: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      // VU 수는 픽스처 개수와 무관하다(여러 VU가 SharedArray를 공유 인덱싱) — rps×응답시간
      // 기준으로만 산정한다. 픽스처 개수는 오직 "rps×duration 총 반복 수"를 넉넉히 덮어
      // wraparound(동일 runToken 재사용→replay)가 안 나게 하는 별개의 관심사다.
      preAllocatedVUs: Math.max(20, RPS * 2),
      maxVUs: Math.max(50, RPS * 4),
    },
  },
  thresholds: {
    // docs/00 §1.4 "제출 p95<250ms" 규범 게이트. 로컬 스모크는 단일 workerd·단일 D1 파일이라
    // staging(실 분산 인프라)과 값이 다를 수 있음 — 결과는 loadtest-report.md에 "로컬 스모크"로
    // 정직하게 구분 기록한다(D48과 동일 정신).
    http_req_duration: ['p(95)<250'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // iterationInTest는 전 VU에 걸친 단조 증가 카운터라 픽스처를 겹치지 않게 소비한다. 픽스처
  // 수(SUBMIT_COUNT)를 rps×duration보다 넉넉히(기본 1,500) 발급해 두면 wraparound가 일어나지
  // 않는다 — 혹시 wraparound가 나면 동일 runToken 재사용이라 서버가 verdict:'rejected'(replay)로
  // 응답한다(HTTP 200 유지, docs/06 §3.1 D39 — 실패해도 부하 자체는 계속된다).
  const idx = exec.scenario.iterationInTest % fixtures.length;
  const f = fixtures[idx];
  const { token, ...body } = f;

  const res = http.post(`${BASE}/api/v1/runs/submit`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    tags: { endpoint: 'submit' },
  });

  check(res, {
    'status 200(D39: 실패도 200+verdict)': (r) => r.status === 200,
    'verdict 필드 존재': (r) => {
      try {
        return typeof r.json('verdict') === 'string';
      } catch {
        return false;
      }
    },
  });
}
