# CLAUDE.md — WORLD TYPING (런칭명: TypeTrip)

이 파일은 이 레포에서 작업하는 모든 Claude 세션에 항상 로드된다. **여기 있는 규칙은 절대 규칙이고, 상세 사양은 `docs/`가 원천이다.** 문서 간 충돌은 `docs/00` §11의 확정 결정 표가 항상 이긴다 — 코드에서 임의 해석 금지.

## 프로젝트 개요

METRO TYPING(서울 지하철역 타이핑 게임)의 재미 구조를 계승해, 세계 지도 위 국가 이름을 타이핑하는 웹 브라우저 게임. 싱글 3모드(대륙 노선/티어 서바이벌/세계일주 50개국) + 데일리 챌린지 + 실시간 멀티 레이스(2~8인) + 랭킹을 v1에 한 번에 런칭한다. 한국어(IME 자모 판정)/영어 입력, 비로그인 100% 플레이. 프론트는 React SPA + 프레임워크 밖 타이핑 엔진, 백엔드는 Cloudflare 전면(Workers + Hono, Durable Objects + WS Hibernation, D1, KV). 클라와 서버가 `packages/shared`의 동일 판정·점수 코드를 번들해 판정 불일치가 구조적으로 불가능하다.

### docs/ 인덱스 (작업 전 해당 문서를 먼저 읽을 것)

| 문서 | 권위 영역 |
|---|---|
| `docs/00-master-overview.md` | **최상위. 스코프 계약·모순 해소(§11)·로드맵 M0~M6. 전 문서에 우선** |
| `docs/01-game-design.md` | 게임 규칙, 모드, 점수 공식(§6), UX 흐름, juice |
| `docs/02-data-content.md` | 국가 스키마, 매칭 규칙, 티어, 노선/루트, 데이터 빌드 파이프라인 |
| `docs/03-frontend-architecture.md` | 클라 스택, **한글 IME 입력 엔진(§2)**, 지도, 상태 규약 |
| `docs/04-backend-cloudflare.md` | 인프라, REST API, 세션/토큰, wrangler, 배포, 비용 |
| `docs/05-multiplayer-protocol.md` | WS 메시지 전문, DO 상태머신, 매치메이킹, 서버 검증 |
| `docs/06-rankings-ops.md` | 리더보드 스키마, 안티치트 운영, 프라이버시, 런칭 체크리스트 |
| `docs/07-implementation-prompts.md` | 마일스톤별 구현 태스크 프롬프트 + 모델 라우팅 |
| `docs/08-progress-handoff.md` | **진행 상태 단일 원천 — 새 세션/새 PC는 이 문서부터 읽을 것.** 완료 태스크↔커밋 매핑, 셋업 절차, 잔여 작업 |

> **진행 상태(2026-07-24)**: docs/07의 42개 태스크(M0~M6) + 후속 리드 태스크(라이트 디자인·자기호스팅·디자인 정합·계정 로그인 WT-AUTH 배치) **전부 구현·검증 완료, `https://worldtyping.leaderpark.net`에 라이브**(자기호스팅 Docker+Tunnel — docs/08 §8.6·§8.7). 남은 것은 수동 항목(`tooling/ops/launch-checklist.md`)과 백로그뿐 — 상세는 `docs/08`. §11 결정은 D71까지 확정.

## 모델 사용 정책 (사용자 명시 요구 — 반드시 준수)

1. **기획/설계/아키텍처 결정 = Fable 5.** 문서 작성, 사양 변경, `docs/00` §11 결정 추가, 구현 태스크 분해는 Fable 5가 수행한다.
2. **실제 구현(코드 작성) = Sonnet 또는 Opus.** 구현 세션은 설계를 새로 하지 않고 문서를 따른다.
3. **구현 지시 프롬프트는 Fable 5가 작성해 Sonnet/Opus에 전달한다.** 프롬프트 형식(컨텍스트 좌표/산출 경로/acceptance/금지사항/에스컬레이션 5요소)과 작업별 모델 라우팅은 `docs/07-implementation-prompts.md`를 따른다.
4. 구현 세션이 문서 간 충돌·미정의 사항을 발견하면 **코드에서 임의 해석하지 말고** PR 코멘트로 `docs/00` §11 결정 행 추가를 제안하고 리드 승인 후 진행한다.

## 기술 스택 & 모노레포

Vite 5 · React 18 · TypeScript 5 strict · Zustand 4 · Tailwind 3.4 · d3-geo + 자체 SVG 지도 · i18next / Cloudflare Workers + Hono 4 · Durable Objects(WS Hibernation) · D1 · KV · Queues · R2 · Analytics Engine / Vitest(+vitest-pool-workers) · Playwright(CDP IME) · k6 / pnpm workspaces, npm 스코프 `@wt/*`.

```
apps/web/            # React SPA (pages, features, stores, net, audio)
workers/api/         # 단일 Cloudflare Worker: Hono 라우트, do/(MatchRoom·Matchmaker), cron/, og/, migrations/
packages/shared/     # ★ 클라·서버 공유 단일 원천 (의존성 0, React/DOM 금지)
  ├ country-matcher/ #   normalize, hangul(toJamoSeq), match(matchInput)
  ├ scoring/         #   score, grade(PI 컷), time-limit
  ├ protocol/        #   WS messages(docs/05 §4.2), seeding(mulberry32), constants
  └ auth/            #   wt1 HMAC 토큰
packages/data/       # 콘텐츠: overrides/*.json, content/routes.ts, src/generated/countries.ts(빌드 산출)
packages/engine/     # 클라 게임 엔진 (프레임워크 독립): session, input-controller, accountant, rules/
packages/i18n/       # ko.json, en.json (키 집합 동일성 CI)
packages/moderation/ # badwords, filter (toJamoSeq 재사용)
tooling/scripts/     # build-data.ts / tooling/ops/: runbook, 리뷰 쿼리, k6
e2e/                 # Playwright + helpers/ime.ts + mock-do-server.ts
```

의존 방향(eslint 강제): `shared` ← 모두 / `engine` ← `apps/web`만 / `packages/*` → `apps|workers` 참조 금지 / `features/*` 상호 직접 참조 금지.

## 공통 명령어

```bash
pnpm install --frozen-lockfile        # 의존성 (CI와 동일 플래그)
pnpm dev                              # apps/web Vite dev + workers/api wrangler dev 동시 기동
pnpm build                            # 전 워크스페이스 빌드 (web dist → Worker assets)
pnpm build:data                       # tooling/scripts/build-data.ts — countries.json 등 재생성 (결정적 출력)
pnpm test                             # vitest 전체 (DO는 vitest-pool-workers)
pnpm test --filter @wt/shared         # 패키지 단위
pnpm e2e                              # Playwright (Chromium, CDP IME 포함)
pnpm typecheck && pnpm lint           # TS strict + eslint 경계 규칙

# Worker (workers/api 디렉터리 기준)
wrangler dev                          # 로컬 (miniflare: D1/KV/DO 로컬 시뮬레이션)
wrangler d1 migrations apply wt-main-dev --local        # 로컬 마이그레이션
wrangler d1 migrations apply wt-main-staging --env staging --remote
wrangler deploy --env staging         # main 머지 시 CI가 수행
wrangler deploy --env prod            # GitHub Release 발행 시 CI가 수행 (수동 게이트)
wrangler secret put SESSION_HMAC_SECRET --env prod      # 시크릿은 이 경로로만
wrangler tail --env prod --format pretty                # 실시간 로그
```

**배포 순서 불변식: migrations apply → deploy.** 순서를 바꾸면 신 코드가 구 스키마를 만난다.

## 아키텍처 맵 (무엇이 어디에)

- **정답 판정**: `packages/shared/country-matcher/` — `matchInput`이 유일한 판정기. 클라(로컬 0ms 판정)와 MatchRoom DO(서버 재검증), `/runs/submit` 재계산이 **전부 이 코드를 import**한다. 판정/점수 로직을 apps나 workers에 복제·재구현하는 순간 버그다.
- **점수/등급**: `packages/shared/scoring/` — `docs/01` §6.2 공식. 싱글은 클라 표시 + 서버 재계산 검증, 멀티는 서버 계산만 진실.
- **WS 프로토콜**: `packages/shared/protocol/messages.ts` = `docs/05` §4.2 전문이 유일한 원천 (docs/00 §11-D7).
- **입력 엔진**: `packages/engine/input-controller.ts`(IME value-snapshot + epoch 가드), `apps/web/features/typing/prompt-renderer.ts`(명령형 DOM).
- **멀티 서버**: `workers/api/src/do/MatchRoom.ts`(방당 1 DO, 완전 권위) + `Matchmaker.ts`(퀵매치 큐).
- **랭킹**: D1 `runs`(원장) + `lb_best`(materialized) + KV `lb:*` 캐시 + 1분 dirty Cron — canonical은 `docs/06` §1.
- **원격 설정**: KV `config:*` (등급 컷, 안티치트 임계, 배너) — 무배포 핫스왑 채널.

## 코딩 컨벤션

- **TS strict 필수.** `any`/`@ts-ignore` 금지(불가피하면 사유 주석). zod `.strict()`로 모든 외부 입력 검증.
- 네이밍: 파일 kebab-case(`input-controller.ts`), React 컴포넌트 파일만 PascalCase(`WorldMap.tsx`), 타입 PascalCase, 상수 UPPER_SNAKE, DB 컬럼 snake_case, 시각은 epoch ms INTEGER.
- **UI 문자열 하드코딩 금지.** 전부 `packages/i18n`의 `영역.의미[.상세]` 키(최대 3단계)로. ko/en 키 집합 동일성은 CI가 검사. 국가명은 i18n 카탈로그가 아니라 `countries.json`의 `nameKo|nameEn`에서만.
- 고빈도 값(입력 버퍼, 실시간 CPM, 콤보, 경과 시간)은 **절대 React state/Zustand에 넣지 않는다** — 명령형 DOM 갱신(docs/03 §4.5). 위반은 리뷰 리젝 사유.
- 커밋: Conventional Commits (`feat(engine): ...`, `fix(worker): ...`, scope = 워크스페이스명). PR 1개 = docs/07 태스크 1개.
- 시크릿을 코드/wrangler.toml/문서에 기재 금지. SQL은 전량 prepared statement 바인딩.

## 핵심 함정 (Gotchas)

1. **한글 IME (`docs/03` §2 — 제품 성패 직결)**: 음절 단위 비교 금지, 항상 자모 시퀀스 prefix 비교(`toJamoSeq`). 이벤트 순서에 상태 걸지 말고 `input.value` 전체 스냅샷 재평가. EXACT 확정 시 blur→clear→**동기** focus 플러시 + epoch 가드. `compositionend`를 기다리면 안 된다. es-hangul은 런타임 금지, 테스트 오라클로만.
2. **DO + WS Hibernation (`docs/05` §11)**: `ctx.acceptWebSocket` + `serializeAttachment` 필수. 인메모리 상태는 wake마다 storage에서 재수화(`ensureHydrated()` 가드를 모든 핸들러 앞단에). alarm은 DO당 1개 — min-heap 패턴으로 다중 타이머 관리. ping/pong은 `setWebSocketAutoResponse`(DO를 깨우지 않게). RACING tick의 setTimeout 체인은 종료 시 반드시 해제(누수 = hibernation 불가 = 과금).
3. **클라·서버 점수/판정 패리티**: 단일 소스는 `packages/shared`뿐. "클라에서 대충 계산하고 서버에서 비슷하게" 금지 — 같은 함수를 양쪽에서 import. 멀티에서 클라는 점수·시각·순위를 절대 전송하지 않는다(`complete{idx, input 원문}`만).
4. **D1 migrations**: `workers/api/migrations/000N_*.sql` **append-only, 기존 파일 수정 절대 금지.** 파괴적 변경은 2단계 배포(참조 제거 → 다음 릴리스에 DDL).
5. **시드 RNG 결정성**: PRNG는 mulberry32 하나(`shared/protocol/seeding.ts`). `Math.random`을 세트 생성에 쓰면 재현·검증·고스트가 전부 깨진다. 랭킹 걸린 세트(티어/데일리)는 서버 salt로만 생성 — 클라 사전 계산 불가가 의도된 설계다.
6. **Cloudflare 로컬 개발**: `wrangler dev`(miniflare)의 D1/KV/DO는 로컬 시뮬레이션 — remote와 데이터 분리. DO 테스트는 jsdom이 아니라 vitest-pool-workers. `run_worker_first = ["/api/*","/ws/*","/r/*","/og/*"]` 밖 경로는 정적 자산이 먼저 먹는다.
7. **env/secrets**: 환경은 dev/staging/prod 3종(wrangler env). 도메인은 미확정 — 코드에서 오리진 하드코딩 금지, `PUBLIC_ORIGIN`/`VITE_PUBLIC_ORIGIN`만 사용. 시크릿은 `wrangler secret put`으로만.
8. **KV는 최종 일관성**: 정밀 한도·유일성 판정에 KV 사용 금지(D1 PK/DO가 담당). KV는 캐시·설정·레이트리밋 1차 방어 전용.

## 국가 데이터 추가/갱신

1. 원천은 npm 패키지(world-countries, world-atlas) + `packages/data/overrides/*.json`(names.ko / aliases / capitals.ko / recognition / tiers / content-sets). **런타임 네트워크 없음.**
2. 표기·별칭·티어 수정 = 해당 override 파일 편집 → `pnpm build:data` → 산출물(`apps/web/public/data/countries.json`, `packages/data/src/generated/countries.ts`, `manifest.json`)이 재생성된다. **산출물 직접 편집 금지.**
3. 빌드는 결정적이어야 하며 CI가 `pnpm build:data && git diff --exit-code`로 신선도를 검사한다. 별칭 추가 시 전역 유일성 검사(다른 국가와 입력 충돌 시 빌드 에러)가 돈다 — 에러를 우회하지 말고 별칭을 조정할 것.
4. 수록 범위·순서(`content/routes.ts`)·분쟁 표기 정책은 `docs/02` §5·§6·§12 준수. 긴급 국명 수정은 재배포 없이 KV `data:countries:override` 핫스왑(런북 참조).

## 테스트 & DoD

- 커버리지 게이트: **`packages/shared`·`data`·`engine` line 95%+**, 그 외 60%.
- 필수 스위트: 02 §3.3 매칭 표 + es-hangul 교차 오라클 / 점수 골든 벡터 + 등급 컷 경계값 / 시딩 결정성 / 03 §2.10 IME 매트릭스 12항목 / 치트 시나리오 6종 E2E / E1~E10(Playwright).
- 성능 예산(CI): entry JS < 170KB gzip(size-limit), 입력 반영 지연 p95 < 16ms, LCP < 2.5s.
- PR DoD: typecheck·lint·test 그린 + 커버리지 + size-limit + 핫패스 규약 준수 + 마이그레이션 append-only + 계약 변경 시 docs 동기 갱신(docs/00 §10.2).

### Do
- 작업 시작 전 docs/07 태스크의 컨텍스트 좌표 + **docs/00 §11을 항상 먼저** 읽기
- 판정·점수·프로토콜 변경은 `packages/shared`에서만, 테스트 먼저 갱신
- acceptance 명령을 로컬에서 실행하고 PR에 결과 기재

### Don't
- 매칭/점수 로직 복제, IME 처리 재발명, 프로토콜 메시지 임의 확장
- 고빈도 값의 React state 사용, 인게임 레이아웃 리플로우 유발 애니메이션
- 마이그레이션 수정, 산출물(`generated/`, `public/data/`) 손편집, 시크릿 커밋
- 문서와 다른 구현을 "더 낫다"는 이유로 진행 — §11 에스컬레이션 먼저

## 배포 플로우

```
PR → CI(typecheck·test·build:data diff·build) + preview 버전 업로드(PR 코멘트 URL)
main 머지 → d1 migrations apply(staging) → wrangler deploy --env staging (자동)
GitHub Release 발행 → 승인 게이트 → d1 migrations apply(prod) → wrangler deploy --env prod
```

롤백: Worker는 이전 버전 재배포, 데이터는 KV 핫스왑, D1은 Time Travel(30일) — 상세는 `tooling/ops/runbook.md`.