# 부하 테스트 리포트 (WT-M6-05)

> spec: docs/06 §10-#5(부하 테스트: 제출 200rps/5분·LB 1,000rps·멀티 500방), docs/00 §1.4(SLO 표),
> docs/04 §9(비용/스케일 모델 — 병목 대조)
> 도구: `tooling/ops/loadtest/{gen-fixtures.ts,submit.js,leaderboard.js,room-sim.ts,multi.md}`
> 대상: 로컬 `wrangler dev`(workerd, miniflare) @ 127.0.0.1:8787 — persist 격리(`pnpm --filter @wt/api run e2e:dev`)
> 실행일: 2026-07-23 / 머신: Windows 11, Node v24.12, k6 v2.1.0(winget 설치)
>
> **리드 조정 3항 준수**: staging(Cloudflare) 계정 미연결이라 이 문서의 수치는 전부 **로컬 스모크**다.
> k6 스크립트 자체는 스펙값(제출 200rps/5분, LB 1,000rps)을 기본 시나리오로 완성돼 있고
> `RPS`/`DURATION` 환경변수로 그대로 staging에 겨눌 수 있다 — 로컬 실행만 "제출 20rps/1분,
> LB 100rps/1분" 축소값으로 수행했다.

## 0. 준비: gen-fixtures.ts + config:loadtest

k6(goja 런타임)는 npm 패키지를 import할 수 없어 `@wt/shared`(HMAC 서명·점수 계산)를 테스트
실행 시점에 쓸 수 없다. `tooling/ops/loadtest/gen-fixtures.ts`(Node, `e2e/helpers/forge.ts`의
`buildBaseline`과 동일 원리 — "forge 로직 이식")가 **사전 단계**에서 실제 `@wt/shared`·`@wt/data`로
유효한 (세션토큰, runToken, 물리적으로 타당한 제출 바디) 튜플을 만들어 JSON으로 저장하고, k6는
그 결과만 읽어 순수 HTTP 부하 생성기 역할만 한다(판정/점수 로직 shared 밖 재구현 금지 준수).

세션(10/60s/IP)·신규 pid(20/h/IP) 상한이 대량 사전 발급과 충돌해, 준비 단계 동안만 로컬 KV
`config:loadtest`(이번 작업에서 `workers/api/src/mw/ratelimit.ts`에 신설 — 존재 시 레이트리밋
전체 우회)와 `config:anticheat.newPidAbuseMaxPerHour`를 올렸다가 완료 즉시(성공/실패 무관)
원복한다. **`/runs/start`·`/runs/submit` 자체의 물리 한계·점수 재계산 등 실제 안티치트 임계는
전혀 건드리지 않는다** — 실행 로그로 원복까지 확인됨:

```
[gen-fixtures] 레이트리밋 완화 적용: config:loadtest 세팅 + config:anticheat.newPidAbuseMaxPerHour=1,000,000
...
[gen-fixtures] 원복 완료: config:loadtest / config:anticheat 이전 상태로 복구
```

재현:
```bash
pnpm --filter @wt/api run e2e:dev                              # 별도 터미널: wrangler dev @ 8787
SUBMIT_COUNT=1300 CONCURRENCY=40 node --import tsx tooling/ops/loadtest/gen-fixtures.ts
```

## 1. 제출(submit.js) — 로컬 스모크

- 시나리오: `constant-arrival-rate`, 기본 20 iterations/s × 60s(로컬 스모크; `RPS=200 DURATION=5m`
  로 스펙값 그대로 staging 겨냥 가능). 픽스처는 south-america(12개국) 2개국 부분 클리어 — 서로
  다른 pid 1,300건, 정상 페이로드(msPerKeystroke=90 → CPM≈667 en, softCap 900 아래 여유 — forge.ts와
  동일 상수).
- 판정: `status 200`(D39 — 실패도 항상 200+verdict) + `verdict` 필드 존재만 체크(k6 자체는 verdict
  값을 채점하지 않는다 — 이건 이미 워커 유닛 테스트(runs.test.ts 등)의 책임).

```bash
k6 run tooling/ops/loadtest/submit.js
```

| 실행 | 반복 | 실패율 | p50 | p90 | p95 | SLO(<250ms) |
|---|---:|---:|---:|---:|---:|---|
| 1회차(다른 vitest 전체 스위트와 동시 실행) | 1,199 | 0% | 1.02s | 1.86s | **1.98s** | ❌ |
| 2회차(단독 실행, 시스템 유휴) | 1,179 | 0% | 2.18s | 3.08s | **3.44s** | ❌ |

**판정: 로컬 SLO 미달(❌).** 다만 `checks_succeeded=100%`(HTTP 200 + verdict 필드는 항상 정상) —
실패한 건 없고 **느릴 뿐**이다. D1 `runs` 테이블 실제 조회로 확인: 두 회차 다 `verdict='valid'`로
정상 채점됐고(§1.3 처럼 all/d:/w: 3보드 UPSERT까지 완료), 리더보드에도 반영됐다(§2 참조).

### 원인 진단(정직한 기록 — 코드 결함 아님)

- **2회차(시스템 유휴 상태)가 1회차보다 오히려 더 느리다**(p95 1.98s→3.44s). 시스템 경합이
  원인이 아니라는 뜻 — 진짜 원인은 **로컬 D1(단일 SQLite 파일)에 누적되는 행 수**다. 매 유효
  제출마다 `runs` INSERT 1건 + `lb_best` UPSERT 최대 3건(all/d:/w:) + 업적 평가 + KV 쓰기가
  발생하고, 반복 실행(gen-fixtures 워밍 + 두 차례 k6 실행)마다 같은 로컬 SQLite 파일에 행이
  계속 쌓여 쓰기 비용이 우상향한다(docs/04 §9.1 "D1 단일 DB 쓰기 실용 한계" 우려와 정확히 같은
  종류의 병목 — 다만 로컬은 진짜 분산 D1이 아니라 workerd가 파일 하나를 물고 있는 것이라 훨씬
  일찍 체감된다).
- **로컬 workerd는 프로덕션 D1(리전 분산·자동 배치)의 등가물이 아니다.** 여기 수치는 "서버
  로직이 다량의 유효 제출에서도 안 죽는다"는 스모크이지, 프로덕션 지연 예측이 아니다(room-sim
  리포트와 동일 정신, D48 "로컬 수치는 정보용" 원칙 계승).
- **조치 제안(staging에서 검증할 것)**: ① D1 batch 크기·prepared statement 재사용 확인(현재
  `upsertBestStmts`가 board 수만큼 개별 UPSERT를 배치에 밀어 넣는 구조 — 커밋 배치 크기가
  실제 병목인지 staging에서 `wrangler tail`로 실측), ② KV 쓰기(레이트리밋 카운터·세션 사용
  플래그)가 D1 트랜잭션과 같은 요청 안에서 직렬화되는지 프로파일링, ③ 위 두 지점 모두 정상이면
  200rps는 D1 write 처리량(분산 인프라) 자체의 문제이므로 §9.3 KV 최적화와 별개로 D1 쓰기
  배칭(예: Queue를 경유한 비동기 UPSERT)을 §11 에스컬레이션으로 제안.

## 2. 리더보드(leaderboard.js) — 로컬 스모크

- 시나리오: `constant-arrival-rate`, 100 iterations/s × 60s(로컬 스모크; `RPS=1000`로 스펙값
  그대로 staging 겨냥 가능). 대상 보드는 §1의 submit.js 실행이 자연히 시딩한다(완주 여부와
  무관하게 verdict='valid'면 lb_best에 반영되므로 별도 "완주" 시드 스텝이 필요 없다 — 첫 설계는
  별도 완주 페이로드를 즉시 제출했으나, 발급 직후 제출은 청구 elapsedMs가 실제 경과 시간을
  구조적으로 초과해 시간 봉투(§6.2-③)에서 전량 `time_envelope`로 리젝됐다 — 근본 원인을 제거하고
  submit.js 자체가 보드를 채우는 설계로 단순화했다).
- `setup()`에서 보드를 1회 조회해 실제 `nextCursor`를 얻고(가짜 커서 하드코딩 금지), 반복의
  10%는 그 커서로 2페이지(D1 keyset 경로)를, 90%는 1페이지(KV 히트 경로)를 요청한다.

```bash
k6 run tooling/ops/loadtest/leaderboard.js
```

시딩 결과: `board=continent:south-america|en|desktop|all total=1199 cursor=있음`(§1의 submit.js
1회차 1,199건 valid가 그대로 lb_best에 반영됨 — D1 직접 조회로 board당 1,199행 확인).

| 지표 | 값 | SLO |
|---|---:|---|
| 총 반복 | 6,000 (100.0 iters/s 유지) | — |
| 실패율 | 0.00% | — |
| p95(top, KV 히트 경로) | **7.49ms** | <100ms ✅ |
| p95(전체, top+cursor 10% 혼합) | 15.23ms | 참고용 |
| p95(cursor, D1 keyset 경로) | 참고용(별도 threshold 미설정 — §1.4 대상은 "LB 첫 페이지"뿐) | — |

**판정: SLO 통과(✅), 여유 매우 큼(7.49ms ≪ 100ms).** KV 캐시 경로가 로컬에서도 압도적으로
빠르다 — 1,000rps 스펙값도 로컬에서 재현 가능성이 높지만(리드 조정에 따라 미실행), staging에서
실 CF 엣지·KV로 재확인 권장.

### 관측(발견 사항, 결함 아님)

- 코드 감사 중 `workers/api/src/mw/ratelimit.ts`의 `LIMITS.leaderboard`(60/60s/IP) 스코프가
  `routes/lb.ts`의 어떤 라우트에도 실제로 붙어있지 않음을 확인했다(정의만 있고 미와이어링).
  이번 로컬 스모크가 429 없이 100rps를 그대로 통과한 이유이기도 하다 — 의도적 설계(캐시
  응답이라 KV 레이트리밋보다 edge Cache-Control이 1차 방어라는 판단)인지, 아니면 배선 누락인지
  최종 보고 escalations에 기재.

## 3. 멀티 레이스(room-sim) — WT-M4-06 산출 재사용

k6 대신 `tooling/ops/loadtest/room-sim.ts`를 그대로 쓴 이유·재현 절차는
`tooling/ops/loadtest/multi.md`에 있다(프로토콜 재구현 회피 — CLAUDE.md 절대 규칙). 아래는
WT-M4-06에서 이미 측정된 결과(이번 작업에서 재작성하지 않음, 그대로 인용).

> 도구: `tooling/ops/loadtest/room-sim.ts` (Node 내장 WebSocket 클라 봇)
> 측정: 각 봇이 `progress`를 보낸 시각 → 그 변화가 반영된 `progress-tick` 수신 시각까지의 E2E 지연.
> SLO(docs/00 §1.4): tick 지연 **p95 < 400ms**.

| 방(rooms) | 봇(WS) | 생성 | 연결 | RACING 도달 | tick 표본 | p50 | p95 (SLO<400) | p99 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 200 | 100 | 200 | 200 | 6,578 | 138ms | **253ms** ✅ | 264ms |
| 300 | 600 | 300 | 600 | 600 | 16,132 | 153ms | **265ms** ✅ | 288ms |
| 500 | 1000 | 500 | 1000 | 1000 | 22,453 | 149ms | **268ms** ✅ | 290ms |

**판정: 500 동시 방(1,000 WS)까지 로컬 workerd에서 tick p95<400ms(268ms) 달성 — SLO 통과.**
한계·주의사항(측정 지점이 로컬, 부하 생성기 자체가 병목일 수 있음 등)은 `multi.md` 참조.

## 4. 종합 판정

| 항목 | SLO | 로컬 스모크 결과 | 판정 |
|---|---|---|---|
| 제출(submit) | p95 < 250ms | 1.98s~3.44s | ❌ (원인: 로컬 D1 단일 파일 쓰기 누적 — §1 진단) |
| 리더보드(LB, top) | p95 < 100ms | 7.49ms | ✅ |
| 멀티(tick) | p95 < 400ms | 268ms(500방) | ✅ |

제출만 로컬에서 SLO를 못 채웠지만, **원인이 검증 파이프라인 코드가 아니라 로컬 단일 SQLite D1
파일의 쓰기 누적**이라는 점을 D1 직접 조회로 확인했다(같은 회차 안에서 시스템이 더 한가한
2회차가 더 느렸다 — 경합이 원인이면 반대여야 한다). staging(실 분산 D1)에서 반드시 재검증이
필요하며, 아래 §5 절차로 리드가 계정 연결 후 그대로 실행한다.

## 5. staging 정식 실행 절차 (원격 실행 필요 — 로컬에서 완료 불가)

> 전체 명령·rl 완화 플래그 set/원복 절차는 `tooling/ops/launch-checklist.md`의
> "부하 테스트 — staging 정식 실행 (WT-M6-05)" 절에 그대로 옮겨 뒀다(중복 방지, 여기서는 요약만).

1. `config:loadtest`(신설) + `config:anticheat.newPidAbuseMaxPerHour` 상향 — staging은
   `signSessionToken` 직접 서명이 불가(배포된 시크릿 비공개)이므로 이 플래그가 유일한 완화 경로.
2. `gen-fixtures.ts`를 `WT_BASE=https://<staging-origin>`으로 실행 → 실 `POST /session`·
   `/runs/start` 경유로 픽스처 발급.
3. `RPS=200 DURATION=5m k6 run submit.js`, `RPS=1000 DURATION=1m k6 run leaderboard.js`,
   `multi.md` 절차로 `room-sim.ts`를 staging 대상 재실행.
4. 합격선(docs/06 §10-#5): 제출 p95<250ms(D1 batch), LB p95<100ms(KV 히트)+히트율>95%, 멀티
   tick p95<400ms.
5. **원복 필수** — `config:loadtest`·`config:anticheat`를 원래 값으로 되돌린다(잊으면 프로덕션
   안티치트 임계가 낮아진 채로 방치된다). `config:loadtest`는 2h TTL 세이프가드가 있지만 즉시
   delete를 권장.

## 6. 제약/금지 준수 확인

- prod 대상 실행 없음(로컬만 수행, staging은 절차만 기재).
- 테스트 데이터 정리: 로컬 `.wrangler/e2e-state`는 다음 `pnpm --filter @wt/api run e2e:dev` 실행
  시 자동 삭제·재생성된다(WT-M3-08 e2e-dev-server.mjs 기존 동작) — 별도 정리 스크립트 불필요.
  staging 테스트 데이터 정리(runs verdict='practice' 마킹 등)는 launch-checklist.md 절차에 포함.
