# Cloudflare Notifications 수동 구성 체크리스트 (WT-M6-04)

> 원천: `docs/06-rankings-ops.md` §8.2(알림 표), `docs/04-backend-cloudflare.md` §8.2(핵심 알람 3종).
> Cloudflare Notifications는 대시보드에서만 구성 가능(Terraform/wrangler로 선언 불가) — 계정
> 연결 후 리드가 아래 항목을 순서대로 대시보드에서 클릭 구성한다. 로컬/코드로 대체 검증한
> 부분은 각 항목에 "로컬 등가 검증"으로 표기했다(`tooling/ops/runbook.md` §7 참조).

## 체크리스트

- [ ] **① 5xx 비율 > 1%/5min** (docs/04 §8.2 핵심 알람 1)
  - Cloudflare 대시보드 → Notifications → Workers → "Workers Error Rate Alert" 생성.
  - 대상: `typetrip-prod` Worker. 조건: 5xx 응답 비율 > 1%, 관측 창 5분.
  - 채널: Email + Slack webhook(Incoming Webhook URL을 대시보드에 직접 등록, `config:ops` KV의
    값과는 별개 — Cloudflare Notifications 자체 웹훅 등록 UI 사용).
  - 로컬 등가 검증: `apiErrorHandler`(`lib/api-error.ts`)가 미처리 예외마다
    `logError("unhandled_error", ...)` + `captureException`(Sentry)을 남긴다 —
    `workers/api/test/*.test.ts`의 에러 경로 테스트들이 이 로그 포맷 회귀를 방지한다.

- [ ] **② `run_rejected` 비율 > 10%/15min** (docs/04 §8.2 핵심 알람 2 — 클라 버그 신호)
  - Workers Logs 기반 커스텀 알림(로그 필드 쿼리) 또는 Analytics Engine 스케줄 쿼리로 구성.
    Cloudflare Notifications가 로그 필드 임계값 알림을 직접 지원하지 않으면, Grafana(AE SQL API
    연결, docs/04 §8.2) 알림 규칙으로 대체 구성.
  - 로컬 등가 검증: `workers/api/src/cron/retention.ts`의 `runAbuseSurgeCheck`(5분 Cron)가 이미
    flagged+rejected > 5%(표본 ≥ 20)를 자동 감지해 `config:ops`의 Slack webhook으로 알린다 —
    `workers/api/test/retention.test.ts` "runAbuseSurgeCheck" describe 블록이 이 로직을 커버한다.
    ②는 10%/15min이라는 별도 임계라 코드상 상수를 조정하려면 `ABUSE_SURGE_RATIO_THRESHOLD`/
    `ABUSE_SURGE_WINDOW_MS`(retention.ts)를 리드 승인 후 조정한다(현재는 §8.2 표 원문 "부정 급증"
    수치인 5%를 채택 — D 결정표 미확정 사안, 리드 확인 요망).

- [ ] **③ DO 예외 > 10건/5min** (docs/04 §8.2 핵심 알람 3 — MatchRoomDO)
  - Workers Logs에서 `evt` 필드가 `do_matchroom_fetch_unhandled`인 로그의 5분당 건수 알림.
  - 로컬 등가 검증: `workers/api/src/do/MatchRoom.ts`의 최상위 `fetch()` catch가
    `logError("do_matchroom_fetch_unhandled", ...)` + Sentry capture를 남긴다(WT-M6-04 도입).
    Matchmaker도 동일 패턴(`do_matchmaker_fetch_unhandled`).

- [ ] **④ 가용성: Health Check 2회 연속 실패** (docs/06 §8.2)
  - Cloudflare 대시보드 → Health Checks → 신규 생성.
  - 대상: `GET https://<PUBLIC_ORIGIN>/api/v1/health` (D18: 도메인 확정 후 URL 채움).
  - 조건: 2회 연속 실패(HTTP != 200 또는 timeout). 알림: Email + Slack.
  - 로컬 등가 검증: `?fault=d1`/`?fault=kv` 강제 실패 훅(`routes/health.ts`, 비-prod 전용) —
    `tooling/ops/runbook.md` §7.1, `workers/api/test/health.test.ts`.

- [ ] **⑤ D1 스토리지 80%** (docs/04 §8.2 도구 표)
  - Cloudflare 대시보드 → Notifications → D1 → Storage Alert, 임계 80%.
  - 로컬 등가 검증 불가(실 D1 용량 지표 필요) — `tooling/ops/queries/review.sql` §7의
    users/runs/lb_best 행 수 쿼리를 주간 리포트(WT-M6-04, `runRetentionJob`의 `weeklyReport`,
    KST 월요일마다 로그)로 대체 관측한다.

- [ ] **⑥ 신고 임계(동일 대상 5건)** (docs/06 §3.6, 자동)
  - 코드가 이미 자동 처리(`workers/api/src/queue/consumer.ts` `processReport` — 임계 도달 시 대상
    run을 `flagged`로 자동 격하 + `logWarn("report_threshold_reached", ...)`). Notifications 구성
    불필요 — Workers Logs 쿼리(`evt="report_threshold_reached"`)로 모니터링.

- [ ] **⑦ 합성 모니터링** (docs/04 §8.2)
  - 외부 서비스(BetterStack/UptimeRobot, 무료 플랜)에 `GET /api/v1/config` 60초 폴링 + WS
    핸드셰이크 체크 5분 등록. 계정 가입 필요 — 리드가 계정 생성 후 URL 등록.

## 완료 후

각 항목 체크 시 담당자·날짜·알림 채널 확인 스크린샷을 `tooling/ops/launch-checklist.md`에
append한다(§10 체크리스트 규칙과 동일).
