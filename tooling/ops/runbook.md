# 인시던트 런북 — TypeTrip (WT-M6-04)

> 원천: `docs/06-rankings-ops.md` §8.4(인시던트 런북, 표 5개 시나리오)·§8.5(D1 백업/복구)·§8.2(알림).
> 이 문서는 §8.4 표를 실행 가능한 절차로 구체화한다. docs/06과 충돌하면 docs/06이 이긴다 —
> 여기 있는 건 실행 절차이지 스펙 변경이 아니다.
>
> Cloudflare 계정 미연결(세션 어댑테이션 §2) 상태에서 작성됨 — `--local`(wrangler dev/miniflare)
> 명령은 지금 실제로 검증 가능하고, `--remote`(staging/prod) 명령은 계정 연결 후 리드가 그대로
> 실행할 절차로 기재한다. 두 종류를 헷갈리지 않게 각 섹션에 명시한다.

## 0. 공통 준비

```bash
cd workers/api
npx wrangler tail --env prod --format pretty       # 실시간 로그(원격, 계정 연결 후)
npx wrangler tail --env staging --format pretty     # staging 실시간 로그
```

구조화 로그 컨벤션(`workers/api/src/lib/log.ts`): 모든 로그는 `{"evt": "...", "ts": ..., ...}` 단일
JSON 줄이다. `wrangler tail` 출력을 `jq 'select(.evt=="run_rejected")'` 류로 필터링한다(§8.1).

---

## 1. D1 장애/지연

**증상**: `GET /api/v1/health`가 `checks.d1.ok=false`로 503(§8.2 "가용성" 알림 2회 연속 실패).

1. 리더보드 읽기는 자동으로 KV 캐시(`lb:*`)로 서빙이 지속된다(§1.5 폴백 순서) — 유저 임팩트는
   "새 기록이 반영 안 됨" 정도, 완전 장애 아님.
2. 기록 제출은 클라 재시도 큐가 로컬 보관 후 복구 시 재제출한다(runToken TTL 2h 내 — 그 이상
   지연되면 해당 판은 소실, 유저에게 안내).
3. 상태 배너 ON:
   ```bash
   # local 검증(지금 가능)
   npx wrangler kv key put --binding KV --local "config:banner" '{"show":true,"messageKey":"banner.incident.d1","level":"warn"}'
   # remote(계정 연결 후)
   npx wrangler kv key put --binding KV --env prod --remote "config:banner" '{"show":true,"messageKey":"banner.incident.d1","level":"warn"}'
   ```
4. D1 자체 상태는 Cloudflare 대시보드(D1 → Metrics)에서 확인(원격 전용). 완전 장애 시 D1 자체
   장애는 Cloudflare 측 이슈 — 자체 조치 불가, 상태 페이지 안내만 유지.
5. 복구 후 배너 OFF: 위 명령의 값을 `{"show":false}`로 재실행.

---

## 2. 치트 웨이브 (핵 유포)

**증상**: `run_rejected`/`flagged` 비율 급증. 자동 감지는 5분 주기 Cron
(`workers/api/src/cron/retention.ts` `runAbuseSurgeCheck`, §8.2 "부정 급증")이 flagged+rejected
비율 > 5%(표본 ≥ 20)일 때 Slack에 알린다(webhook URL은 `config:ops` KV, §3 참조).

1. **캡 하향 핫스왑** — `config/anticheat.json`을 참고해 임계를 조인 뒤 KV에 즉시 반영(무배포):
   ```bash
   # 예: CPM 하드캡을 임시로 낮춘다
   npx wrangler kv key put --binding KV --local "config:anticheat" --path config/anticheat.tightened.json
   # remote
   npx wrangler kv key put --binding KV --env prod --remote "config:anticheat" --path config/anticheat.tightened.json
   ```
   (`config/anticheat.tightened.json`은 `config/anticheat.json`을 복사해 캡만 낮춘 임시 파일 —
   레포에 커밋하지 않는다, 인시던트 종료 후 삭제.)
2. **해당 기간 재판정** — `pnpm ops:rescore`(`tooling/ops/scripts/rescore.ts`)로 영향 기간 전체를
   새 캡 기준 재검증한다:
   ```bash
   # dry-run(기본) — 변경 후보만 확인
   pnpm ops:rescore -- --from 2026-08-01T00:00:00Z --to 2026-08-01T06:00:00Z --env dev --local
   # 확인 후 실제 반영
   pnpm ops:rescore -- --from 2026-08-01T00:00:00Z --to 2026-08-01T06:00:00Z --env dev --local --apply
   ```
   `--apply`는 `runs.verdict`를 갱신하고 영향받은 `lb_best` 보드를 `dirty:*`로 마킹한다 — 1분 내
   lb-refresher가 보드를 재계산한다(§1.5). 자세한 스크립트 계약·스코프 제약(§11 D3 daily 모드
   미지원 등)은 `tooling/ops/scripts/rescore.ts` 파일 상단 주석 참조.
3. 필요 시 기간 보드 자체를 무효화 공지(운영 판단 — v1은 별도 자동화 없음, 수동 KV 삭제):
   ```bash
   npx wrangler kv key delete --binding KV --env prod --remote "lb:tier:3|ko|desktop|d:2026-08-01"
   ```
4. 캡은 사태 종료 후 원복(`config/anticheat.json` 원본으로 KV 재푸시).

---

## 3. 바이럴 스파이크

**증상**: 트래픽 급증(Workers 요청/DO 인스턴스 수 급증), D1 쓰기 지연.

1. Workers 자체는 자동 스케일 — 조치 불필요.
2. 병목은 대개 D1 쓰기(`runs` INSERT) — `mw/ratelimit.ts`의 게시판/제출 레이트리밋을 하향해
   흡수(`config:client`가 아니라 코드 상수 — 필요 시 KV 핫스왑 확장은 후속 태스크로 이연).
3. KV 캐시 TTL 상향으로 리더보드 읽기 부하를 흡수(lb.ts `LB_CACHE_TOP_N`/TTL — 코드 상수, 조정 시
   재배포 필요. v1은 KV 핫스왑 미노출).
4. DO(MatchRoom) 인스턴스 수는 방 코드 단위로 자동 분산 — 조치 불필요.

---

## 4. 잘못된 데이터 배포 (국가명 오류 등)

**증상**: 국가명·별칭 오표기가 프로덕션에 배포됨.

1. **재배포 없이 즉시 롤백**: `packages/data/overrides/*.json`을 고치고 `pnpm build:data`로 재생성한
   `apps/web/public/data/countries.json` 콘텐츠를 KV `data:countries:override`에 직접 핫스왑한다:
   ```bash
   npx wrangler kv key put --binding KV --local "data:countries:override" --path apps/web/public/data/countries.json
   npx wrangler kv key put --binding KV --env prod --remote "data:countries:override" --path apps/web/public/data/countries.json
   ```
2. 클라는 `GET /api/v1/data/countries`를 통해 이 오버라이드를 우선 서빙한다(`routes/data.ts`) —
   클라 재배포 불필요, `manifest.json` 해시로 캐시 무효화가 자동 반영된다.
3. 오버라이드가 만료돼야 할 시점(정식 릴리스 배포 완료 후)에는 KV 키를 삭제해 번들 산출물로 복귀:
   ```bash
   npx wrangler kv key delete --binding KV --env prod --remote "data:countries:override"
   ```

---

## 5. 리더보드 오염 (버그성 점수)

**증상**: 특정 run_id의 점수가 비정상적으로 높음/낮음 (버그 기인, 치트 아님).

1. 원인 run_id 특정: `tooling/ops/queries/review.sql`의 "최근 고득점 이상치" 쿼리로 탐색.
2. 해당 행 정화:
   ```sql
   UPDATE runs SET verdict='rejected', verdict_reason='manual_bug_fix' WHERE run_id='<run_id>';
   DELETE FROM lb_best WHERE run_id='<run_id>';
   ```
   (`tooling/ops/queries/actions.sql`에 파라미터화된 형태로 보관 — `wrangler d1 execute`로 실행.)
3. 영향받은 보드를 dirty 마킹(§1.5, 위 rescore.ts 사용 또는 수동):
   ```bash
   npx wrangler kv key put --binding KV --env prod --remote "dirty:<board_key>" 1 --ttl 180
   ```
4. 90초 내 KV top100이 정화된 값으로 재구성됨(§8.3 SLO "KV top100 신선도 < 90s").

---

## 6. D1 백업/복구

### 6.1 일일 논리 백업 (자동, §8.5)

`.github/workflows/backup.yml` — 일 1회(KST 04:00) `wrangler d1 export` → gzip →
R2 `wt-{env}/d1-backups/`(§11-D26, 35일 보존). 계정 미연결 상태에서는 `vars.BACKUP_ENABLED`가
없어 잡이 항상 skip된다(dry-run 구조만 커밋됨) — 활성화 절차는 `.github/workflows/README.md`.

**로컬 dry-run 검증(지금 가능, D1 export+gzip 파이프라인 자체를 실증)**:

```bash
cd workers/api
npx wrangler d1 export wt-main-dev --local --output ../../wt-main-dev-dryrun.sql
gzip -k ../../wt-main-dev-dryrun.sql
ls -la ../../wt-main-dev-dryrun.sql.gz   # 0바이트 아님 + gzip 매직바이트 확인
gunzip -t ../../wt-main-dev-dryrun.sql.gz && echo "gzip OK"
rm ../../wt-main-dev-dryrun.sql ../../wt-main-dev-dryrun.sql.gz
```

R2 업로드 단계(`r2 object put wt-{env}/d1-backups/...`)는 실 R2 버킷/계정이 필요해 로컬로는
검증할 수 없다 — 계정 연결 후 `workflow_dispatch`로 1회 수동 실행해 확인한다(§6.3).

**35일 보존 라이프사이클(계정 연결 후 리드가 1회 구성, wrangler/코드로 선언 불가)**:
Cloudflare 대시보드 → R2 → `wt-{env}` 버킷 → Lifecycle Rules → 규칙 추가:
프리픽스 `d1-backups/`, "Expire objects" 35일 경과 시. `.github/workflows/backup.yml`은 이
버킷 프리픽스로만 업로드하고 만료는 전적으로 이 R2 규칙에 위임한다(코드가 삭제를 수행하지
않음 — 이중 삭제/경쟁 방지).

### 6.2 Time Travel 복원 (30일 시점 복원, 원격 전용)

```bash
npx wrangler d1 time-travel restore wt-main-prod --timestamp=2026-08-01T00:00:00Z --env prod
```

전체 DB 단위 복원이므로, 부분 오염은 위 §5(행 단위 정화)를 우선한다.

### 6.3 복구 리허설 절차 (런칭 전 1회, 이후 분기 1회 — §10 체크리스트)

1. staging D1을 대상으로 `wrangler d1 export`(§6.1) → 로컬 파일로 다운로드.
2. 별도 임시 D1(`wt-main-rehearsal`)을 생성하고 export한 SQL을 `wrangler d1 execute --file`로 주입.
3. `SELECT COUNT(*) FROM runs`·`SELECT COUNT(*) FROM users` 등으로 행 수가 원본과 일치하는지 확인.
4. 결과를 `tooling/ops/launch-checklist.md`류 문서에 날짜와 함께 기록.
5. 임시 D1 삭제.

---

## 7. 알림 경로 강제 발화 테스트 (§8.2, 로컬/staging 등가 절차)

원격 Cloudflare Notifications/Health Checks가 미구성 상태라 실제 알림 채널을 발화시킬 수 없다
(계정 미연결). 아래로 **로직 자체**(가용성 체크 실패 감지, 부정 급증 감지 → Slack 호출)를 로컬에서
증명하고, 실제 Notifications 구성은 `tooling/ops/alerts.md` 체크리스트로 계정 연결 후 리드가 수행한다.

### 7.1 가용성(Health Check) 강제 실패

```bash
# wrangler dev를 띄운 상태에서
curl -s "http://localhost:8787/api/v1/health?fault=d1" | jq .
# → {"ok":false,"checks":{"d1":{"ok":false,"error":"injected fault ..."},"kv":{"ok":true}}}, HTTP 503
curl -s "http://localhost:8787/api/v1/health?fault=kv" | jq .
```

`?fault`는 `ENVIRONMENT!=='prod'`에서만 동작한다(health.ts 가드) — prod에서는 항상 무시되어
외부에서 헬스체크를 조작할 수 없다. 자동 테스트: `workers/api/test/health.test.ts`,
`workers/api/src/index.test.ts`(prod 가드 케이스).

### 7.2 부정 급증(Abuse Surge) 강제 발화

로컬 D1에 짧은 시간창에 `verdict='rejected'` 행을 몰아 삽입한 뒤 5분 Cron 핸들러를 직접 호출한다
(테스트 하네스와 동일 절차 — `workers/api/test/retention.test.ts`
`describe("cron/retention — runAbuseSurgeCheck...")` 참조). 수동 확인:

```bash
npx wrangler d1 execute wt-main-dev --local --command \
  "INSERT INTO runs (run_id,user_id,mode_key,lang,platform,score,pi,cpm,acc_milli,elapsed_ms,countries_cleared,countries_skipped,max_combo,completed,grade,session_id,verdict,detail_json,created_at) VALUES ('rb-test-1','<존재하는 user_id>','tier:1','ko','desktop',0,0,0,0,0,0,0,0,0,'D','rb-test-1','rejected','{}', $(date +%s000))"
# (표본 20개 이상 반복 후) config:ops에 테스트 webhook URL을 넣고 5분 cron을 --test-scheduled로 트리거:
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

### 7.3 staging 1회 수행 (계정 연결 후, 리드 실행 항목)

1. staging에 배포 후 §7.1과 동일하게 `?fault=d1`을 호출해 실제 Cloudflare Health Check가 2회
   연속 실패를 감지하고 이메일/Slack이 오는지 확인(§8.2).
2. staging `config:ops`에 실 Slack webhook을 넣고 §7.2 절차로 부정 급증을 재현해 Slack 알림 수신
   확인.
3. 결과(스크린샷/타임스탬프)를 PR 본문 또는 `tooling/ops/launch-checklist.md`에 기재.

---

## 8. KV 핫스왑 절차 요약

| 키 | 용도 | 스키마 원천 |
|---|---|---|
| `config:anticheat` | 안티치트 임계(§11-D12, D53) | `workers/api/src/lib/anticheat-config.ts` |
| `config:client` | 등급 컷/제한시간 계수 | `workers/api/src/routes/config.ts` |
| `config:banner` | 상태 배너 | `apps/web` BannerConfig(§8.4-①) |
| `config:ops` | Slack webhook 등 운영 알림 설정(WT-M6-04) | `workers/api/src/lib/ops-config.ts` |
| `data:countries:override` | 국가 데이터 긴급 롤백(§8.4-④) | `packages/data` 산출물과 동일 스키마 |

공통 명령 형태:

```bash
npx wrangler kv key put --binding KV --env <env> [--local|--remote] "<key>" '<json>'
npx wrangler kv key get --binding KV --env <env> [--local|--remote] "<key>"
npx wrangler kv key delete --binding KV --env <env> [--local|--remote] "<key>"
```

---

## 9. rescore.ts 사용법 요약

`tooling/ops/scripts/rescore.ts`(`pnpm ops:rescore --`) — 기간·모드 지정 → 후보 runs 재검증 →
verdict 갱신 → 영향 보드 dirty 마킹. 옵션 전체와 설계 결정(daily 모드 미지원, PersonalStats 중립화
등)은 스크립트 파일 상단 주석이 원천이다. 기본은 dry-run — `--apply` 없이는 아무것도 바뀌지 않는다.

```bash
pnpm ops:rescore -- --from <ISO|YYYY-MM-DD> --to <ISO|YYYY-MM-DD> [--mode tier:3] [--env dev|staging|prod] [--local|--remote] [--config <path>] [--apply]
```
