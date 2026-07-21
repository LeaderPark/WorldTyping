# workers/api — TypeTrip Worker

단일 Cloudflare Worker: 정적 자산(SPA) + `/api/v1/*` + `/ws/*`(추후) + DO(추후). 상세는
`docs/04-backend-cloudflare.md`, 환경/바인딩은 `docs/00-master-overview.md` §7 참고.

## 로컬 개발

```bash
pnpm --filter @wt/web build      # apps/web/dist 생성 (assets 바인딩이 참조)
pnpm --filter @wt/api exec wrangler dev
```

`wrangler dev`는 D1/KV/DO를 miniflare로 로컬 시뮬레이션한다(원격 리소스와 데이터 분리, CLAUDE.md
gotcha 6). `wrangler.toml`의 `database_id`/`id`/`bucket_name` 등은 Cloudflare 계정 미연결 상태라
플레이스홀더다 — 계정 연결 후 아래 절차로 1회 발급한다.

## 리소스 발급 절차 (계정 연결 후, 환경별 1회)

```bash
wrangler d1 create wt-main-{env}            # → wrangler.toml의 database_id에 반영
wrangler kv namespace create wt-kv-{env}    # → id에 반영
wrangler r2 bucket create wt-{env}
wrangler queues create wt-events-{env}
```

## 시크릿 (`wrangler secret put`으로만 주입 — 코드/`wrangler.toml`에 값 절대 기재 금지)

```bash
wrangler secret put SESSION_HMAC_SECRET --env staging
wrangler secret put RUN_HMAC_SECRET --env staging
wrangler secret put DAILY_SALT --env staging
wrangler secret put SENTRY_DSN --env staging
wrangler secret put TURNSTILE_SECRET --env staging

wrangler secret put SESSION_HMAC_SECRET --env prod
wrangler secret put RUN_HMAC_SECRET --env prod
wrangler secret put DAILY_SALT --env prod
wrangler secret put SENTRY_DSN --env prod
wrangler secret put TURNSTILE_SECRET --env prod
```

`SESSION_HMAC_SECRET`/`RUN_HMAC_SECRET`은 각 32바이트 랜덤 hex, 분기 1회 로테이션(구/신 2키 7일
병행 검증, docs/00 §7.3). dev 환경은 `.dev.vars`(git-ignored, 로컬 전용)로 대체 가능하나 이 저장소엔
아직 커밋하지 않는다.

## 배포 순서 불변식

```
wrangler d1 migrations apply wt-main-{env} --env {env} [--local|--remote]
wrangler deploy --env {env}
```

마이그레이션을 먼저 적용하지 않고 배포하면 신 코드가 구 스키마를 만난다(CLAUDE.md 참고).
