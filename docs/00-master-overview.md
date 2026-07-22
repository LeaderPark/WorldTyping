# 00. 마스터 개요 & 로드맵

> 프로젝트 코드네임: **WORLD TYPING** / 문서 버전: v1.0 (2026-07-21) / 담당: 리드 아키텍트
> 이 문서는 docs/01~06 전체를 통제하는 **최상위 마스터 문서**다. 하위 문서와 본 문서가 상충하면 **본 문서(특히 §11의 확정 결정 표)가 항상 우선**한다. 하위 문서 간 상충은 §11에서 전부 해소했으며, 구현 에이전트는 코드에서 임의 해석하지 말고 §11을 따른다.

---

## 0. 문서의 지위와 권위 순서

1. **docs/00 (본 문서)** — 스코프 계약, 모순 해소, 로드맵. 전 문서에 우선.
2. 도메인 담당 문서 — 각 영역의 권위: 게임 규칙·점수 = 01, 데이터·매칭 = 02, 클라이언트·IME = 03, 인프라·REST API·세션 = 04, 멀티 WS 프로토콜 = 05, 랭킹·안티치트 운영·프라이버시·성장 = 06.
3. 담당 밖 문서가 타 영역을 언급한 내용(예: 04의 리더보드 스키마)은 **참고 정보**이며, 담당 문서(06)와 다르면 담당 문서가 이긴다. 그 판정 결과는 §11에 명문화되어 있다.

---

## 1. 이그제큐티브 요약 / 제품 비전 / 타깃 / 성공 지표

### 1.1 이그제큐티브 요약

- **무엇을**: METRO TYPING(서울 지하철역 타이핑 게임)의 검증된 재미 구조 — 익숙한 고유명사의 나열, "완주"라는 명확한 목표, 타수/정확도라는 자랑 가능한 숫자, 링크 하나로 즉시 실행 — 를 계승해 소재를 "세계 지도 위의 국가 이름"으로 바꾼 웹 브라우저 타이핑 레이스 게임을 만든다.
- **왜**: 국가 이름은 한국어/영어 양측 시장에서 동일 콘텐츠로 성립하는 전 세계 공통 상식이며(글로벌 확장성), "타자 연습 + 세계지리"라는 교육적 알리바이로 공유 맥락이 넓고, "프랑스 → 키리바시"라는 난이도 곡선이 콘텐츠에 내장되어 있다.
- **어떻게**: 프론트는 React SPA + 프레임워크 밖에서 도는 자체 타이핑 엔진(한글 IME 자모 프리픽스 판정), 백엔드는 Cloudflare 전면(Workers + Hono, Durable Objects + WebSocket Hibernation, D1, KV). 클라이언트와 서버가 `packages/shared`의 **동일한 매칭·점수 코드를 번들**하므로 판정 불일치가 구조적으로 불가능하다.
- **언제**: M0~M6 7단계 로드맵, 총 개략 10.5주(에이전트 병렬 시 ~7주). v1은 싱글 3모드 + 데일리 + 멀티 실시간 레이스 + 랭킹 전체를 한 번에 런칭한다.
- **비용**: 10,000 DAU 기준 월 ~$15 (Workers Paid 포함, 04 §9). 100k DAU까지 아키텍처 변경 없이 요금만 선형 증가.

### 1.2 제품 비전 (한 문장)

**"지하철 노선도 대신 세계 지도를 타이핑으로 완주하는, 3분짜리 바이럴 웹 타이핑 레이스."**

### 1.3 타깃 유저 (01 §1.2 요약)

| 세그먼트 | 설명 | 핵심 대응 기능 |
|---|---|---|
| P0 코어 (15~29세 SNS 유저) | 릴스/Threads/X에서 타이핑 챌린지 접함 | 결과 카드 공유, 랭킹, 멀티 레이스 |
| P1 타자 연습층 | 한컴타자·monkeytype 기존 유저 | 티어 모드, 데일리, CPM 기록 추적 |
| P2 지리 퀴즈층 | Seterra/GeoGuessr 팬 | 지도 하이라이트, 세계일주, 업적 |
| P3 라이트 유입 | 링크 타고 온 1회성 방문자 | 로그인 없는 즉시 플레이, 최단 경로 3클릭·15초 내 첫 타이핑(§11-D36) |

기기: 데스크톱 1차, 모바일 2차(단 SNS 유입 특성상 모바일 트래픽 60%+ 가정, 플랫폼 분리 랭킹). 계정: 비로그인 100% 플레이 가능.

### 1.4 성공 지표

**노스스타: WCR (Weekly Completed Runs) — 주간 완주 판 수** (06 §5.4).

| 구분 | 지표 | 목표 (런칭 분기) |
|---|---|---|
| 퍼널 | 방문→첫 시작 / 시작→완주 / 완주→공유 클릭 | 70% / 55% / 8% |
| 리텐션 | D1 / D7 / 데일리 참여율(DAU 대비) | 25% / 12% / 35% |
| 바이럴 | K-factor 근사 (공유발 신규 visit ÷ WAU) | 0.15+ |
| 멀티 | 매치 성사율 / 평균 매칭 대기 | 90%+ / <12s |
| 무결성 | flagged+rejected 비율 | <0.5% |
| 기술 SLO | API 가용성 / 제출 p95 / LB 첫 페이지 p95 / 멀티 tick E2E p95 | 99.9% / <250ms / <100ms / <400ms |
| 클라 성능 | 입력 반영 지연 p95 / entry JS / LCP(모바일) | <16ms / <170KB gzip / <2.5s |

---

## 2. 게임 이름 확정

> **[확정] 런칭명: 타입트립 (TypeTrip)** — 01 §1.4의 1순위안을 그대로 확정한다.

- **한글 태그라인**: "타이핑으로 떠나는 세계일주"
- **영문 태그라인**: "Type your way around the world."
- 코드네임 `WORLD TYPING`은 저장소·문서에서 유지한다. 사용자 노출 문자열(타이틀, OG, 공유 텍스트)만 TypeTrip을 쓴다.
- 도메인: **typetrip.gg 1순위**(대안: typetrip.kr, typetrip.app). 04·06 문서의 `worldtyping.gg`는 전부 **플레이스홀더**다. 코드에서는 오리진을 하드코딩하지 않고 환경 변수 `PUBLIC_ORIGIN`으로 추상화한다(§7) — 도메인 최종 확정(M0 중 상표/도메인 조사, §11 오픈 퀘스천 Q1)이 늦어져도 구현이 블로킹되지 않는다.
- npm 스코프는 `@wt/*`로 통일한다(03의 `@wt/data`와 05의 `@worldtyping/data` 표기 불일치 → `@wt/*` 확정).

---

## 3. v1 기능 목록 (스코프 계약)

### 3.1 포함

| 기둥 | 기능 | 사양 출처 |
|---|---|---|
| 싱글 (a) 대륙별 | 6개 노선(asia 47 / europe 45 / africa 54 / north-america 23 / south-america 12 / oceania 14 = **un195**), 고정 순서, 타임어택 | 01 §3.1, 02 §5 |
| 싱글 (b) 티어별 | T1~T5 서바이벌(라이프 3, 국가당 제한시간 01 §7.2), 1런 20개국, **일일 고정 시드**(전 유저 동일 세트, §11-D5) | 01 §3.2, 02 §4 |
| 싱글 (c) 세계일주 | **50개국** 마라톤(§11-D2), 체크포인트 10개국 간격(10/20/30/40 + 종착), 라이프 3 + 이어하기 1회 | 02 §6, 01 §3.3 |
| 데일리 챌린지 | 매일 KST 00:00, 10개국(T1×3+T2×3+T3×2+T4×1+T5×1), 라이프 1, 1일 1회 등재, 이모지 그리드 공유, 스트릭 | 01 §9.1, 06 §2 |
| 멀티 | 실시간 레이스 2~8인, 15개국(T1×6+T2×5+T3×4), 퀵매치+코드 방+공개 방 목록, 하드캡 180s, 리매치, 고스트 봇, 재접속(grace 15s) | 05 전체 |
| 랭킹 | `lb_best` 기반, 기간(일간/주간/전체) × 모드 × lang(ko/en) × platform(desktop/mobile), 지역 필터(geo), 멀티 MMR 보드(alltime만, §11-D15), keyset 페이지네이션, 내 순위/백분위 | 06 §1 |
| 신원/프로필 | 익명 디바이스 신원(HMAC 파생 저장, §11-D10), 닉네임(2~12자, 모더레이션), 여권 커버 12종, 스탬프, 업적 24종, 고스트 모드(자기 기록 대결) | 06 §4, 01 §9 |
| 무결성 | runToken 서명, 서버 재계산, 물리 한계 검사, 입력 리듬 통계, shadow-ban, 신고 플로우 | 04 §6, 06 §3 |
| 공유/성장 | 결과 카드(클라 캡처 + 서버 OG `/r/:shareId`), 방 초대 링크, 데일리 텍스트 공유, UTM 계측 | 06 §9 |
| 플랫폼 | ko/en (UI+입력 통합 전환, §11-D6), PWA 오프라인 싱글, 접근성(wcag2aa), 모바일 소프트 키보드 대응 | 03 §7·§8 |
| 운영 | 텔레메트리(AE), 알림/헬스체크, D1 백업, 런북, privacy 페이지 + 열람/삭제 API | 06 §5·§6·§8 |

### 3.2 명시적 제외 (백로그)

퀴즈 모드(국기/지도만 보고 맞히기), 음절 타일 모바일 대안 입력, 수도 확장 팩, **시즌제/배틀패스(스키마의 `s:{seasonId}` periodKey만 예약, v1 UI·운영 미노출 — §11-D15)**, 언어별 티어 분리, 관전 전용 링크, 수익화·광고 전체(06 §7), 소셜 로그인(04 §5.4 스키마 대비만), 어드민 대시보드(읽기 전용 쿼리 세트로 대체), PI 밴드 매칭, 세션 리플레이 도구, extended 세트(TW/XK/EH) 출제.

---

## 4. 시스템 아키텍처

```mermaid
flowchart TB
  subgraph B["브라우저 — React SPA (apps/web)"]
    INPUT["HiddenInput + TypingInputController<br/>(IME value-snapshot, epoch 가드)"]
    MATCH["@wt/shared country-matcher<br/>matchInput — 로컬 0ms 판정"]
    ENGINE["@wt/engine GameSessionEngine<br/>FSM + @wt/shared scoring"]
    UIL["React UI + 명령형 렌더러<br/>프롬프트·HUD·WorldMap(SVG)"]
    WSC["WsManager<br/>낙관 렌더 + 서버 권위 롤백"]
    INPUT --> MATCH --> ENGINE --> UIL
    ENGINE --> WSC
  end

  subgraph CF["Cloudflare — 단일 Worker 'typetrip' (workers/api)"]
    ASSETS["Workers Static Assets<br/>SPA + /data/countries.[hash].json"]
    API["Hono /api/v1/*<br/>session·config·daily·runs·lb·nickname·rooms·users"]
    MM[("Matchmaker DO<br/>mm:lang:queue — 퀵매치 큐")]
    MR[("MatchRoom DO — room:CODE<br/>WS Hibernation, 권위 상태머신")]
    CRON["Cron Triggers<br/>데일리 시드 · lb-refresher(1분) · 보존정리"]
    Q[["Queue wt-events<br/>분석·신고·고스트 후처리"]]
  end

  D1[("D1 wt-main<br/>users · runs · lb_best · matches ·<br/>match_participants · reports · unlocks")]
  KV[("KV<br/>config:* · lb:* · dirty:* · daily:* ·<br/>rl:* · publicroom:* · ghost:* · data:*")]
  R2[("R2<br/>backups · ghosts")]
  AE[("Analytics Engine<br/>wt_telemetry")]

  B -->|"GET 정적 (불변 캐시)"| ASSETS
  B -->|"REST + Bearer 세션 토큰"| API
  WSC ===|"wss /ws/room/:code<br/>C→S: hello·join·progress(10Hz)·complete(원문 input)<br/>S→C: room-state·start·progress-tick(4Hz)·accepted/rejected·results"| MR
  API -->|"POST /api/v1/match/quick"| MM
  MM -->|"internal/create · 좌석 배정"| MR
  API --> D1
  API --> KV
  API --> Q
  MR -->|"결과 batch INSERT"| D1
  MR -->|"publicroom TTL 갱신 · ghost 로드"| KV
  CRON --> D1
  CRON --> KV
  Q --> AE
  Q --> R2
```

**핵심 데이터 흐름 3계약**:

1. **타이핑 핫패스는 전부 로컬**: keystroke → `country-matcher`(자모 프리픽스) → 엔진 → 명령형 DOM 갱신. React state·네트워크는 이 경로에 개입하지 않는다(03 §4.5 불변식). 입력 반영 지연 p95 < 16ms.
2. **싱글 = 제출 시 서버 재계산**: `/runs/start`가 서명 runToken(+서버 확정 세트)을 발급 → 플레이 → `/runs/submit`에서 04 §6.2 검증 파이프라인(리플레이/시간 봉투/세트/매칭 재실행/물리 한계/재계산) 통과분만 `lb_best` UPSERT → KV dirty 마킹 → 1분 Cron이 top100 캐시 갱신.
3. **멀티 = DO 100% 권위**: 클라는 `complete{idx, input 원문}`만 보내고 점수·시각·순위를 절대 보내지 않는다. MatchRoom이 동일 `matchInput`을 재실행해 승인/거부하고, 250ms `progress-tick`으로 전파. 최종 순위·PI는 `results` 페이로드만이 진실.

---

## 5. 기술 스택

| 레이어 | 선택 | 이유 (요약, 상세는 담당 문서) |
|---|---|---|
| 빌드 | Vite ^5 + `vite-plugin-pwa` | HMR, manualChunks로 코드 스플리팅 예산 제어 (03 §1) |
| UI | React 18 + TypeScript 5 strict | 비핫패스 UI(전체 코드 70%)의 생산성. 핫패스는 프레임워크 밖 명령형 |
| 상태 | Zustand ^4 (4분할 스토어) | React 외부 일반 객체 → 프레임워크 독립 엔진과 자연 결합, 고빈도 값은 스토어 금지 |
| 스타일 | Tailwind CSS ^3.4 + CSS 변수 토큰 | 대륙 6색·등급색 토큰 일원화, 런타임 CSS-in-JS 금지 |
| 지도 | d3-geo + topojson-client + 자체 SVG 래퍼(~200줄) | path `d` 1회 사전계산·동결, 리렌더 0 계약. react-simple-maps 기각 (03 §1.2) |
| 타이핑 엔진 | 자체 `@wt/engine` + `@wt/shared/country-matcher` | 클라·서버 단일 판정 코드. es-hangul은 테스트 오라클로만 |
| i18n | i18next + react-i18next | 02 §9 평면 카탈로그 호환 (§11-D20) |
| SPA 호스팅 | **Workers Static Assets** (Pages 아님) | API와 단일 배포 단위·버전 원자성, CORS 소멸, DO 1급 시민 (04 §1.1) |
| API | Workers + Hono v4 + zod `.strict()` | 경량, DO/WS 라우팅 자연 결합 |
| 실시간 | Durable Objects + WebSocket Hibernation | 방당 1 DO = 단일 스레드 권위 서버, 유휴 과금 제거 |
| DB | D1 (SQLite) | runs 원장 + lb_best materialized + matches. 리더보드 읽기는 KV 뒤 |
| 캐시/설정 | KV (단일 네임스페이스, 키 프리픽스 운용) | config 핫스왑, lb top100, 데일리 시드, 레이트리밋, 데이터 핫스왑 |
| 비동기/저장 | Queues(`wt-events`) / R2 / Cron / Analytics Engine | 분석·신고·고스트 후처리 / 백업·고스트 blob / 시드·집계·정리 / 텔레메트리 |
| 테스트 | Vitest(+vitest-pool-workers) / Playwright(CDP IME) / k6 | §10 |
| CI/CD | GitHub Actions + wrangler (preview → staging → prod 수동 게이트) | 04 §8.1 |

---

## 6. 모노레포 구조 (pnpm workspaces)

> **핵심 원칙**: `packages/shared`가 **정답 매칭(country-matcher)·점수(scoring)·프로토콜·타입**의 단일 원천이며, **apps/web(브라우저)과 workers/api(Worker + DO)가 같은 코드를 그대로 번들**한다. "클라 판정 ≠ 서버 판정" 버그는 이 구조에서 발생할 수 없다. shared에는 React/DOM 의존을 eslint 규칙으로 금지한다.

```
worldtyping/                          # 저장소 루트 (제품명 TypeTrip)
├─ pnpm-workspace.yaml
├─ package.json                       # 루트 스크립트: build:data, typecheck, test, build
├─ docs/                              # 00~07 계획 문서 (§12)
├─ apps/
│  └─ web/                            # React SPA (내부 구조는 03 §9 그대로)
│     ├─ index.html                   # 테마 FOUC 스니펫, 폰트 preload
│     ├─ vite.config.ts               # manualChunks, PWA, size-limit
│     ├─ public/data/                 # build:data 산출물 (countries.json, countries-110m.json, manifest.json)
│     └─ src/
│        ├─ app/                      # router.tsx, AppShell, bootLoader
│        ├─ pages/                    # Home/ModeSelect/TrackSelect/Game/Rank/Passport/Privacy + multi/
│        ├─ features/                 # typing/ map/ hud/ result/ multiplayer/ leaderboard/ passport/
│        ├─ stores/                   # settings, session, multiplayer, leaderboard, meta
│        ├─ net/                      # ws-manager, api-client, telemetry, swr
│        ├─ audio/  styles/  lib/
├─ workers/
│  └─ api/                            # ★ 단일 Cloudflare Worker (04 문서의 "apps/worker" = 여기, §11-D19)
│     ├─ wrangler.toml                # §7
│     ├─ migrations/                  # D1: 0001_users_runs / 0002_leaderboard / 0003_matches / 0004_moderation
│     └─ src/
│        ├─ index.ts                  # Hono app + queue() + scheduled()
│        ├─ routes/                   # session, config, daily, runs, lb, nickname, rooms, users, report
│        ├─ do/                       # MatchRoom.ts, Matchmaker.ts, room-state.ts (05 문서)
│        ├─ cron/                     # daily-seed, lb-refresher, retention(+kpi)
│        ├─ og/                       # render.ts (workers-og), og-maps.json
│        └─ mw/                       # auth, ratelimit, security-headers, cors(dev/staging 한정)
├─ packages/
│  ├─ shared/                         # ★★ 클라·서버 공유 단일 원천 (의존성 0, DOM/React 금지)
│  │  └─ src/
│  │     ├─ types/                    # Country, GameMode, RunStats, BoardKey, ApiError, verdict …
│  │     ├─ country-matcher/          # normalize.ts, hangul.ts(toJamoSeq), match.ts(matchInput/matchInputDetail)
│  │     │                            #   ← 02 §3의 "packages/data/src/{normalize,hangul,match}"를 여기로 이관 (§11-D19)
│  │     ├─ scoring/                  # score.ts(01 §6.2 FinalScore), grade.ts(PI 컷), time-limit.ts(01 §7.2)
│  │     ├─ protocol/                 # messages.ts(05 §4.2 전문), seeding.ts(mulberry32/buildRaceSet), constants.ts
│  │     └─ auth/                     # token.ts — wt1 HMAC 서명/검증, base64url (04 §5)
│  ├─ data/                           # 콘텐츠 데이터 (02 문서 관할, 빌드타임에 shared 의존)
│  │  ├─ overrides/                   # names.ko / aliases / capitals.ko / recognition / tiers / content-sets
│  │  ├─ content/                     # routes.ts — 대륙 6노선 + ROUTE_WORLD_TOUR(50)
│  │  └─ src/generated/               # countries.ts — Workers 번들용 상수 (빌드 산출)
│  ├─ engine/                         # 클라 게임 엔진 (프레임워크 독립, 03 §5)
│  │  └─ src/                         # session.ts, input-controller.ts, accountant.ts, rules/*, replay.ts
│  ├─ i18n/                           # ko.json, en.json (키 집합 동일성 CI 검사)
│  └─ moderation/                     # badwords.{ko,en}.txt, allowwords.en.txt, filter.ts (toJamoSeq 재사용)
├─ tooling/
│  ├─ scripts/                        # build-data.ts (02 §10), seed-capitals-ko.ts (1회성)
│  ├─ ops/                            # runbook.md, queries/*.sql, scripts/rescore.ts, loadtest/(k6)
│  └─ ci/                             # size-limit 설정, a11y 대비 정적 검사
├─ e2e/                               # Playwright 스펙, helpers/ime.ts(CDP), mock-do-server.ts
└─ .github/workflows/                 # ci.yml, deploy.yml, backup.yml(schedule: d1 export→R2)
```

**의존 방향 규칙** (eslint `import/no-restricted-paths`):
`shared` ← `data`(빌드타임) · `engine` · `apps/web` · `workers/api` / `engine` ← `apps/web`만 / `data/generated` ← `workers/api`(서버 상수) · `apps/web`(정적 fetch는 public/data 경유) / `packages/*` → `apps|workers` 참조 금지 / `features/*` 상호 직접 참조 금지.

---

## 7. 환경 / 설정 / 시크릿

### 7.1 환경 3종 (wrangler env)

| 환경 | Worker 이름 | 도메인 | 배포 트리거 |
|---|---|---|---|
| dev | `typetrip` (local) | `localhost:5173` + `wrangler dev` | 수동 |
| staging | `typetrip-staging` | `staging.{PUBLIC_ORIGIN}` | main 머지 자동 |
| prod | `typetrip-prod` | `{PUBLIC_ORIGIN}` (+www→apex 301) | GitHub Release 발행(수동 승인 게이트) |

배포 순서 불변식: **D1 migrations apply → wrangler deploy** (신 코드가 구 스키마를 만나는 창 제거). 마이그레이션 파일은 append-only.

### 7.2 바인딩

| 바인딩 | 리소스 | 용도 |
|---|---|---|
| `ASSETS` | Static Assets (`apps/web/dist`) | SPA + 데이터. `run_worker_first = ["/api/*","/ws/*","/r/*","/og/*"]`, SPA fallback |
| `DB` | D1 `wt-main-{env}` | users/runs/lb_best/matches/match_participants/reports/admin_audit/user_unlocks/daily_challenges/shares/kpi_daily |
| `KV` | KV `wt-kv-{env}` (**단일 네임스페이스, 프리픽스 운용** — 06의 LB_CACHE는 `lb:` 프리픽스로 통합) | 아래 7.4 |
| `BUCKET` | R2 `wt-{env}` | D1 논리 백업(35일), 고스트 리플레이 blob |
| `EVENTS` | Queue `wt-events-{env}` (§11-D16: 04의 score-postprocess 명칭 폐기) | AE 적재, 신고 처리, 고스트 저장 |
| `AE` | Analytics Engine `wt_telemetry` | 06 §5.2 이벤트 스키마 |
| `MATCH_ROOM` / `MATCHMAKER` | DO (SQLite-backed, `new_sqlite_classes`) | 05 문서 |
| `RL` | Rate Limiting binding | `runs/submit` 1차 방어 (KV 쓰기 절감, 04 §9.3) |

### 7.3 시크릿 (`wrangler secret put --env`, 코드/toml 기재 절대 금지)

| 시크릿 | 용도 | 로테이션 |
|---|---|---|
| `SESSION_HMAC_SECRET` | 세션 토큰 `wt1.*` 서명 + playerId 파생 | 분기 1회, 구/신 2키 7일 병행 검증 |
| `RUN_HMAC_SECRET` | runToken·WS 티켓 서명 (키 용도 격리) | 동일 |
| `DAILY_SALT` | 데일리/티어 시드 사전 계산 유출 방지 (§11-D21) | 유출 시에만 |
| `SENTRY_DSN` | 서버 예외 수집 (toucan-js) | — |
| `TURNSTILE_SECRET` | 예약 (봇 세션 대량 생성 관측 시 활성) | — |

클라이언트에는 시크릿이 존재하지 않는다. 클라 빌드 변수는 `VITE_PUBLIC_ORIGIN` 하나.

### 7.4 KV 키 카탈로그 (원격 설정 = 무배포 운영의 핵심)

| 키 | 내용 | 갱신 주체 |
|---|---|---|
| `config:client` | `GET /config` 전문 — dataUrl, grades(PI 컷), timeLimit 계수, anticheat 캡, featureFlags | 운영자 |
| `config:anticheat` | §11-D12 확정 임계값(핫스왑) | 운영자/런북 |
| `config:moderation` / `config:banner` / `config:lobbyShards` | 금칙어 핫픽스 / 장애 배너 / Matchmaker 샤드 수(기본 1) | 운영자 |
| `data:countries:override` | 국가 데이터 핫스왑(국명 개정 등, 재배포 불필요) | 운영자 |
| `lb:{board_key}` / `dirty:{board_key}` | top100 캐시 / 더티 마킹(TTL 180s) | Cron / 제출 핸들러 |
| `daily:{date}` | 데일리 세트 캐시 | Cron(KST 00:00) |
| `rl:*` / `blk:ip:*` / `sess:{sid}` | 레이트리밋 / IP 해시 차단 / run 세션 사용 플래그 | 미들웨어 |
| `publicroom:{code}` / `ghost:{lang}:{mode}:{piBucket}` | 공개 방 목록(TTL 60s) / 고스트 봇 리플레이 | MatchRoom DO |

Cron: `0 15 * * *`(KST 00:00 데일리+티어 시드 발행·D1 확정 저장), `*/1 * * * *`(lb-refresher, dirty만 — §11-D24로 04의 5분 주기 폐기), `30 16 * * *`(보존 정리 + kpi_daily 스냅샷). D1 백업은 GitHub Actions schedule에서 `d1 export` → R2 (06 §8.5).

---

## 8. 단계별 빌드 로드맵 M0~M6

```mermaid
flowchart LR
  M0[M0 스캐폴드] --> M1[M1 데이터+shared 코어]
  M1 --> M2[M2 싱글 3모드+타이핑 엔진]
  M1 --> M3[M3 API+제출+리더보드]
  M2 --> M3
  M2 --> M4[M4 멀티]
  M3 --> M4
  M4 --> M5[M5 폴리시·i18n·a11y·모바일]
  M5 --> M6[M6 런칭]
```

> 규모 표기: 캘린더 기준(리드 1인 + 구현 에이전트). M2와 M3은 M1 완료 후 부분 병렬 가능(총 캘린더 ~7주까지 단축).

### M0 — 스캐폴드 (0.5주, PR 3~5개)

- **목표**: 빈 모노레포가 CI를 통과하고 staging에 배포되는 상태.
- **산출물**: pnpm workspaces + TS strict + eslint(경계 규칙 포함) + vitest 골격, `apps/web` 헬로 SPA, `workers/api` Hono + `GET /api/v1/health`, wrangler dev/staging 설정, GitHub Actions(ci.yml: install→typecheck→test→build / deploy.yml: preview·staging), 도메인/상표 조사 착수.
- **완료조건(acceptance)**: ① `pnpm i && pnpm typecheck && pnpm test && pnpm build` 그린, ② `wrangler dev`에서 SPA + `/api/v1/health` 200, ③ PR마다 preview URL 코멘트, ④ main 머지 시 staging 자동 배포.
- **의존성**: 없음.

### M1 — 데이터 파이프라인 + shared 코어 (1.5주, PR 6~8개)

- **목표**: 게임의 정합성 전부(매칭·점수·시딩·데이터)를 코드와 테스트로 확정. **최대 리스크(한글 IME 판정)의 순수 로직 절반을 여기서 소거.**
- **산출물**: `packages/shared` 전체(country-matcher, scoring, protocol/seeding, auth 토큰), `packages/data` overrides + `tooling/scripts/build-data.ts`(02 §10 Step 1~8) + `countries.json`/`generated/countries.ts`/`manifest.json`, `content/routes.ts`(6노선 + 세계일주 50), `packages/i18n` 초판, `packages/moderation`.
- **완료조건**: ① 02 §3.3 매칭 테스트 표 전부 + es-hangul 교차 오라클(198개국 nameKo) 그린, ② 점수 골든 벡터 5세트 + 등급 컷 경계값 그린, ③ 05 §3 시딩 테스트(동일 seed 재현·15개·중복 없음·티어 분포) 그린, ④ `build:data` 결정적 출력(CI `git diff --exit-code`), acceptedInputs 전역 유일성·자모 유일성·routes 검증 통과, ⑤ shared·data line coverage ≥95%.
- **의존성**: M0.

### M2 — 싱글 3모드 + 타이핑 엔진 (2.5주, PR 10~14개)

- **목표**: 제품 성패를 가르는 IME 입력 엔진을 브라우저에서 완성하고, 싱글 수직 슬라이스 → 3모드 + 데일리(로컬) 전체를 플레이 가능하게.
- **산출물**: `packages/engine`(TypingInputController + epoch 가드 플러시, KeystrokeAccountant, GameSessionEngine FSM, ModeRules 5종), 프롬프트 명령형 렌더러, WorldMap(GeoIndex·카메라·노선 라인), GamePage(S5→S6→S7), HUD/진행바, 결과·점수·리트라이, juice(01 §13.3), localStorage 메타.
- **완료조건**: ① 03 §2.10 IME 매트릭스 12항목 전부 그린(vitest + Playwright CDP `typeHangul`), ② 실기기 IME 스모크 시트 통과(Windows Chrome, macOS Safari, iOS Safari, Android Gboard/삼성키보드), ③ 입력 반영 지연 p95 <16ms 자체 계측, ④ 국가 확정 시 WorldMap React 커밋 0회(Profiler 확인), ⑤ E2E E1~E4 그린, ⑥ engine coverage ≥95%.
- **의존성**: M1.

### M3 — 백엔드 API + 점수 제출 + 리더보드 (1.5주, PR 8~10개, M2와 부분 병렬)

- **목표**: "기록이 등재되는 게임"으로 전환. 싱글 무결성 종단 완성.
- **산출물**: D1 마이그레이션 0001·0002(06 스키마 canonical), Hono 라우트(session/config/daily/runs/lb/nickname/users/report), 04 §6.2 + 06 §3 통합 검증 파이프라인, lb_best UPSERT(튜플 비교) + KV dirty + lb-refresher Cron, 데일리 시드 Cron, 레이트리밋(RL binding + KV), 클라 랭킹 화면(S8) + 결과 화면 순위 인라인 + pendingSubmission 오프라인 큐.
- **완료조건**: ① 치트 시나리오 6종(토큰 재사용/시간 압축/점수 위조/봇 리듬/붙여넣기/세트 불일치) E2E가 전부 reject/flag, ② 제출 p95 <250ms(k6 스모크 50rps), ③ LB 첫 페이지 KV 히트 + keyset 커서 동작, ④ 데일리 1일 1회 등재·스트릭·연습 강등 동작, ⑤ vitest-pool-workers로 라우트 통합 테스트 그린.
- **의존성**: M1(shared/auth), M2(클라 제출 지점 — API만 먼저 진행 가능).

### M4 — 멀티플레이 (2주, PR 10~12개)

- **목표**: 05 프로토콜 전체 구현. DO 권위 레이스 완성.
- **산출물**: MatchRoom DO(상태머신·storage 키·hydrate-on-wake·alarm min 관리·onComplete 검증·250ms tick·타이브레이크·D1 영속화 재시도), Matchmaker DO(퀵매치·openRoom·봇 오퍼), WS 티켓/hello/resume, 타임싱크, 클라 로비/방/레이스 UI(GameView 재사용 + OpponentTracks 보간), 리매치, 마이그레이션 0003_matches, `e2e/mock-do-server.ts`.
- **완료조건**: ① E2E E6(2인 레이스: 동시 출발·보간·서버 결과 일치)·E7(재연결 race-sync) 그린, ② 하드캡 타이브레이크·자동 스킵·grace 만료 단위테스트, ③ vitest-pool-workers DO 테스트(멱등 complete, WRONG_INDEX, TOO_FAST 3-strike), ④ Hibernation 동작 확인(대기실 유휴 시 wake 로그 0), ⑤ 부하: 500 동시 방 시뮬레이션에서 tick E2E p95 <400ms.
- **의존성**: M1(protocol/seeding), M2(GameView), M3(세션·신원).

### M5 — 폴리시 / i18n / a11y / 모바일 (1.5주, PR 8~10개)

- **목표**: "전 세계 아무 기기에서나" 수준으로 끌어올린다.
- **산출물**: PWA(precache + 오프라인 싱글 + 업데이트 토스트), 코드 스플리팅 예산 튜닝, 접근성 일괄(키보드 온리, aria-live, reduced-motion, 고대비, 폰트 스케일), 모바일(visualViewport, 스킵 버튼, 벌크 삽입 practice 강등, 첫 제스처 포커스), 여권/스탬프/업적 24종, 공유 카드 클라 캡처, 사운드 매니저, en 카탈로그 완성, 고스트 모드.
- **완료조건**: ① E8(모바일)·E9(PWA 오프라인)·E10(axe wcag2aa 위반 0) 그린, ② entry <170KB gzip(size-limit CI), LCP <2.5s(Lighthouse CI, Moto G4급), ③ 업적 24종 판정 단위테스트(서버 재계산 기준), ④ i18n ko/en 키 집합 동일성 CI.
- **의존성**: M2~M4.

### M6 — 런칭 (1주, PR 6~8개)

- **목표**: 06 §10 런칭 체크리스트 12항목 전부 충족 + 소프트 런치.
- **산출물**: `/privacy`(ko/en) + `GET /users/me/export` + `DELETE /users/me`, OG 렌더러(`/r/:shareId`, `/og/:shareId.png`, og-maps.json), AE 이벤트 전체 배선 + `/api/t`, 알림(헬스체크/에러율/부정 급증)·백업 파이프라인·복구 리허설, k6 부하 3종(제출 200rps / LB 1,000rps / 멀티 500방), 도메인/SSL/HSTS, SEO/OG 실물 검증, 크레딧(ODbL·Natural Earth·flag-icons 고지).
- **완료조건**: ① 06 §10 체크리스트 12항목 전부 "완료 기준" 충족, ② 복구 리허설 1회 성공, ③ staging 소프트 런치 1주간 SLO 위반·flagged 급증 없음, ④ 링크 미리보기 3종(X/Threads/카카오) 승인.
- **의존성**: M5.

---

## 9. 리스크 레지스터

| # | 리스크 | 등급 | 조기 경보 신호 | 완화책 | Plan B |
|---|---|---|---|---|---|
| R1 | **한글 IME 판정 오류** (도깨비불, 조합 중 EXACT, 확정 직후 첫 타 유실 — 제품 성패 직결) | 치명×높음 | 실기기 QA 시트 실패, `client_server_divergence` 텔레메트리 | 03 §2 설계 전체(value-snapshot, 자모 prefix, epoch 가드 플러시), M1~M2 최우선 배치, es-hangul 교차 오라클, Playwright CDP IME 재현, 실기기 시트 = 릴리스 게이트 | 문제 브라우저 한정 `compositionend` 대기 폴백 모드(featureFlag), 최악 시 해당 UA 기록을 practice 처리 |
| R2 | DO/WS 복잡도·비용 (hibernation 미스, alarm 단일성, 좀비 방) | 높음×중간 | DO duration 과금 급증, MatchRoom 예외 알람 | Hibernation 필수 + `ensureHydrated()` 가드, alarm min-heap 패턴, 전 상태 storage 복원 가능 설계, vitest-pool-workers 테스트, 비용 모델 상시 대조(04 §9) | 멀티를 featureFlag 뒤에 두고 페이즈드 롤아웃(싱글 먼저 런칭 가능 — 스코프 계약상 최후 수단) |
| R3 | 안티치트 우회·리더보드 오염 | 높음×중간 | flagged+rejected >5%/기간, 상위 100위 이상치 | 다층 방어(서명 토큰→재계산→물리 한계→리듬 통계→shadow-ban), 임계값 KV 핫스왑, 상위 100위 수동 리뷰, 치트 6종 E2E 상시 | 런북 rescore 스크립트로 기간 보드 일괄 재판정, 최악 시 기간 보드 무효화 공지 |
| R4 | 지도 SVG 성능 (저사양·모바일 프레임 드랍) | 중간×중간 | juice 자동 강등 발동률, long task 계측 | path 사전계산·동결, 리렌더 0 계약, transform/opacity 한정, juice 레벨 자동 하향 | `WorldMapHandle` 인터페이스 유지한 Canvas 레이어 교체(escape hatch, 03 §3.6) |
| R5 | 모바일 소프트 키보드 파편화 (Gboard/삼성/iOS 자동완성·스와이프) | 중간×높음 | 모바일 practice 강등률 급증 | hidden input 스펙 고정, 벌크 삽입 감지→practice, 실기기 시트, 플랫폼 분리 랭킹으로 피해 국지화 | 모바일 랭킹 등재 일시 보류(플레이는 유지), v1.5 음절 타일 모드 앞당김 |
| R6 | D1 단일 DB 쓰기 병목/장애 | 중간×낮음 | 제출 p95 상승, D1 알림 | 리더보드 읽기는 KV로 무중단, 클라 재제출 큐(token TTL 내), Time Travel 30일, 실용 한계 ~300k DAU로 여유 | 배너 ON + 제출만 지연 수용, 스키마 샤딩은 백로그 |
| R7 | 정치·표기 민감성 (수록국·국경·국명) | 중간×중간 | 문의 메일, SNS 이슈화 | un195 단일 객관 규칙, 바다 라벨 무렌더, 중립 고지 문구, 문의 대응 스크립트, KV 데이터 핫스왑으로 즉시 수정 | 특정 콘텐츠(이벤트성) 회피 원칙 유지 |
| R8 | 상표/도메인 미확정 | 낮음×중간 | — | M0에서 조사 착수, 코드 전역 `PUBLIC_ORIGIN` 추상화로 늦은 확정 허용 | 2순위 도메인(typetrip.kr/app), 최후 World Typing으로 런칭명 회귀 |
| R9 | 문서-코드 드리프트 (에이전트 구현 품질) | 중간×중간 | acceptance 실패율, 리뷰 리젝률 | docs/07 프롬프트에 acceptance 명령 포함, coverage/size CI 게이트, 충돌 발견 시 §11 에스컬레이션 규칙(§12.3) | 마일스톤 경계에서 리드가 통합 감사 |
| R10 | 바이럴 스파이크 | 낮음×높음 | 요청량 알람 | Workers 자동 스케일, 병목은 D1 쓰기뿐 — rate limit 하향 + KV TTL 상향 런북 | 데일리/랭킹 집계 주기 완화로 흡수 |

---

## 10. 테스트 전략 요약 & Definition of Done

### 10.1 테스트 피라미드

| 계층 | 도구 | 핵심 대상 | 게이트 |
|---|---|---|---|
| 단위 | Vitest | country-matcher(02 §3.3 표 + es-hangul 오라클), accountant/session/rules, scoring 골든 벡터, seeding 결정성, protocol zod 왕복 | **shared·data·engine line 95%+**, 기타 60% |
| 서버 통합 | vitest-pool-workers | Hono 라우트, 검증 파이프라인, lb_best UPSERT 튜플 비교, MatchRoom/Matchmaker DO(멱등·거부·alarm) | 모든 PR |
| E2E | Playwright (Chromium: CDP `Input.imeSetComposition`으로 한글 IME 재현) | E1~E10(03 §10.2) + 치트 6종 + mock-do-server 멀티 | 모든 PR(Chromium), WebKit/FF는 비IME 케이스 |
| 부하 | k6 | 제출 200rps / LB 1,000rps / 멀티 500 동시 방 | M6 릴리스 게이트 |
| 수동 | 실기기 IME QA 시트 | iOS Safari, Android Gboard/삼성키보드 (§2.10 #5, #6) | M2 및 매 릴리스 게이트 |

### 10.2 Definition of Done

**PR 단위**: ① typecheck/lint/unit/통합 그린 + 커버리지 게이트, ② 웹 변경 시 size-limit 통과, ③ 핫패스 규약(03 §4.5 — 고빈도 값 React state 금지) 위반 없음(리뷰 체크 항목), ④ D1 마이그레이션은 append-only, ⑤ 계약(스키마/프로토콜/공식) 변경 시 해당 docs + 본 문서 §11 갱신.

**마일스톤 단위**: 해당 M의 acceptance 전 항목 충족 + staging 데모 + 리스크 레지스터 갱신.

**릴리스(=M6)**: 06 §10 체크리스트 12항목 + 실기기 IME 시트 + k6 3종 + 복구 리허설.

---

## 11. 교차 결정사항 (모순 해소, 전부 확정) & 오픈 퀘스천

### 11.1 확정 결정 (이 표가 하위 문서를 오버라이드한다)

| ID | 쟁점 | 문서 간 상충 | **확정** |
|---|---|---|---|
| D1 | 수록·출제 범위 | 01: 197개국(TW·XK 포함) ↔ 02: un195 + extended | **02 승**: 랭킹 걸린 전 모드 = un195(193+VA+PS). TW/XK/EH는 데이터·지도 렌더에만 존재, 출제 제외 |
| D2 | 세계일주 길이 | 01: 80개국 ↔ 02: 50개국 (03도 50 기준 체크포인트) | **50개국** (`ROUTE_WORLD_TOUR`). 체크포인트 10/20/30/40 + 종착. "80타의 세계일주" 카피는 폐기, "50개국 논스톱 세계일주"로 |
| D3 | 대륙 국가 수·노선 시작점 | 01: asia 49·유럽 GB 시작 ↔ 02: asia 47·유럽 PT 시작 | **02 승** (asia 47 / europe 45 / africa 54 / NA 23 / SA 12 / OC 14, 시작점 KR·PT·EG·CA·CO·AU) |
| D4 | 영어 공백 타수 | 01 §4: 공백 포함 ↔ 02 §3.2·03 §2.9: 정규화로 제거 | **제거 확정**: 판정·타수 모두 공백 무시(한 소스 두 정책 금지). CPM 정의는 이 계상 기준 |
| D5 | 티어 모드 세트 | 01: 일일 고정 시드(전원 동일) ↔ 02 §4.3: 판마다 셔플 | **01 승**: 일일 고정. 시드 = 서버가 `SHA-256(DAILY_SALT + "tier:" + tierId + ":" + dateKST)`로 발급, `/runs/start`가 세트 확정 반환 |
| D6 | UI 언어와 출제 언어 | 02 §9: 별개 설정 ↔ 01 §4·03: v1 통합 | **통합 확정**: 단일 `lang` 설정(판 시작 시점 고정). 분리는 v2 |
| D7 | 멀티 메시지 스키마 | 03 §6.2(commit+inputHash)·04 §3.1(progress+input) ↔ 05 §4.2(progress/complete 분리, 원문 input) | **05 승**: `packages/shared/protocol/messages.ts` = 05 §4.2 전문이 유일한 원천. 03·04의 메시지 정의는 폐기, `complete`는 원문 input 전송(서버 matchInput 재실행) |
| D8 | 매치메이킹 토폴로지 | 04: LobbyDO + WS `/ws/quickmatch` ↔ 05: Matchmaker DO + REST enqueue + KV publicroom | **05 승**: `POST /api/v1/match/quick`(REST) → 티켓 → 방 WS 직결. 공개 방 목록 = KV `publicroom:*`. LobbyDO 폐기. WS 경로는 **`/ws/room/:code`**(04 라우팅 채택) |
| D9 | 랭킹 저장 모델 | 04: scores+leaderboard_snapshots+5분 cron ↔ 06: runs+lb_best+1분 dirty cron | **06 승**: `users/runs/lb_best` + keyset 페이지네이션 + 1분 dirty refresher가 canonical. 04 §4의 players/nicknames/scores/leaderboard_snapshots 및 §9.2는 폐기 |
| D10 | 신원 저장 | 04: deviceId 원문 비저장(HMAC 파생 pid) ↔ 06: users.device_id 원문 UNIQUE | **절충 확정**: `users.device_hash = base58(HMAC(SESSION_HMAC_SECRET, deviceId))` UNIQUE 저장, **원문 비저장**. 결정적 파생이라 bootstrap 조회 가능 + 04의 프라이버시 성질 유지 |
| D11 | 세션 토큰 | 04: `wt1.*` 30일 rolling ↔ 06: 90일 | **04 승**: `wt1.` 포맷, 30일, 만료 7일 전 rolling refresh |
| D12 | 안티치트 임계 | 04·05·06 수치 상이 | **단일 `config:anticheat` KV로 통합.** 초기값: 국가당 최소 `ms ≥ L_i × 35ms`, 싱글 CPM 하드캡 ko 1100/en 1000(보수값 채택), 소프트캡(flag) ko 950/en 900, 멀티 `REACTION_FLOOR_MS=250`·`MAX_KPS={ko:14,en:18}`, 리듬 `stdev/mean<0.12` flag. 전부 핫스왑 가능 |
| D13 | 결정적 PRNG | 05: mulberry32 ↔ 06: xoshiro128** | **mulberry32** (05 구현 전문 존재). 데일리 셔플도 동일 함수 공유 |
| D14 | 닉네임 정책 | 04: 2~16자·7일 1회 ↔ 06: 2~12자·30일 2회 | **06 승**: 2~12자, 30일당 2회, `NICK_RE`·자모 분해 금칙어 매칭 |
| D15 | 시즌 | 06: `s:{seasonId}` 운영 ↔ 01 부록 A: 시즌제 제외 | **01 승(스코프)**: v1 periodKey = daily/weekly/alltime만. `s:*`는 스키마·seasons 테이블에 예약만, UI·운영 미노출. 멀티 MMR 보드는 alltime만 |
| D16 | Queue 용도 | 04: 점수 후처리 Queue ↔ 06: 제출 경로 동기 | **06 승**: 제출·lb_best·업적 판정은 동기(단일 batch). Queue `wt-events`는 AE 적재·신고·고스트 저장 전용 |
| D17 | 방 코드 | 04: "28^6"(오기) ↔ 05: 31자 알파벳 31⁶ | **05 승**: 알파벳 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(31자) 6자리 |
| D18 | 이름/도메인 | 04·06 예시 worldtyping.gg ↔ 01 TypeTrip | **TypeTrip 확정**(§2). 도메인은 `PUBLIC_ORIGIN` 변수, 문서 내 worldtyping.gg는 플레이스홀더로 읽는다 |
| D19 | 워크스페이스 명명 | 03: apps/worker·packages/data 내 매칭엔진·packages/protocol ↔ 태스크 구조 | **§6 트리 확정**: Worker = `workers/api`. 매칭엔진·scoring·protocol·auth는 `packages/shared`로 통합. 하위 문서의 `packages/data/src/match.ts` 등 경로 언급은 `packages/shared/country-matcher/`로 치환해 읽는다 |
| D20 | i18n 구현 | 02: 자체 5줄 포매터 ↔ 03: i18next | **03 승**: i18next. 02의 카탈로그 규칙(키 규약·집합 동일성)은 유지 |
| D21 | 시드의 클라 재현 | 01: 클라 계산 가능한 시드 ↔ 04·06: 서버 salt | **서버 salt 확정**: 랭킹 걸린 세트(티어/데일리)는 서버만 생성·배포(`/runs/start`, `/daily`). 클라 재현은 검증·리플레이 용도로만(시드는 시작 시 수령) |
| D22 | nameKo 캐노니컬 | 01: 통용 단축명 뉘앙스("한국") ↔ 02: "대한민국" canonical | **02 승**: 02 §11 샘플·overrides가 원천("대한민국" canonical, "한국"·"남한" 별칭) |
| D23 | 멀티 모드 노출 | 05: race-continent/race-tier 프로토콜 존재 | v1 UI(퀵매치·방 생성 모두)는 **race-mixed만** 노출. 나머지는 프로토콜 예약 |
| D24 | LB 캐시 주기·KV 구성 | 04: 5분 스냅샷, 단일 KV ↔ 06: 1분 dirty, LB_CACHE 분리 | **주기는 06(1분 dirty)**, **네임스페이스는 04(단일 KV + `lb:` 프리픽스)** |
| D25 | AE 바인딩·Queue 이름 | 04: `AE`/score-postprocess ↔ 06: `ANALYTICS`/wt-events | 바인딩 `AE`, Queue `wt-events` |
| D26 | D1 백업 버킷 | 06 §8.5: 별도 `wt-backups` 버킷 ↔ 00 §7.2: `wt-{env}` 겸용 | **00 §7.2 승**: 별도 버킷 없이 R2 `wt-{env}`의 `d1-backups/` 프리픽스에 저장. 06 §8.5의 `wt-backups`는 이 경로로 치환해 읽는다 (M0 구현 확정, 2026-07-21) |
| D27 | 01 §7.2 제한시간 예시 산수 오류 | 01 §7.2 예시: 미국=4타→3.58s, 상투메프린시페=15타→7.5s ↔ 01 §6.1 자모 계상 규칙(한국=6타)·toJamoSeq 실측: 미국=5자모, 상투메프린시페=16자모 | **자모 계상 규칙 승(공식·L_i 정의 불변)**: 예시만 정정 — 미국 L=5 → 4.10s, 상투메프린시페 L=16 → 7.90s. 01 §7.2·07 WT-M1-02 acceptance 수치 동기 정정 (M1 구현 확정, 2026-07-21) |
| D28 | 02 §3.3 테스트 표 5행 기대값 | 표 5행: "벨"→"벩" = P→MISS ↔ 같은 절의 매처 코드(canonical): toJamoSeq('벩')=ㅂㅔㄹㄱ 는 ㅂㅔㄹㄱㅣㅇㅔ 의 접두 → PREFIX | **매처 코드 승**: '벩'은 도깨비불 임시 복합 종성(간→가나와 동일 부류)이므로 P→**PREFIX**가 정답. 표 5행 정정. 진짜 오타 MISS 케이스는 "벨키"→MISS로 별도 커버 (M1 구현 확정, 2026-07-21) |
| D29 | 07 WT-M1-04 성능 스모크 판정 기준 | 07: 1,000회 루프 벽시계 100ms ↔ Node 병렬 vitest 워커 환경에서 벽시계는 스케줄링에 지배되어 비결정(60~430ms 요동) | **user CPU 기준 확정**: `process.cpuUsage().user` < 250ms로 판정(compute 회귀 가드, 전 실행 모드 비플레이키). 벽시계 100ms는 Workers 네이티브 crypto 기준 참고치로만 (M1 구현 확정, 2026-07-21) |
| D30 | 창 블러(playing 중) 처리 | 03 §5.1 FSM: blur→aborted 암시 ↔ 01 §5.5·07 WT-M2-02: practice 강등 | **practice 강등 확정**: `degradedToPractice{reason:'blur'}` — 판 계속, 랭킹 제외. `aborted`는 명시적 `abort()` 호출로만 (M2 구현 확정, 2026-07-21) |
| D31 | ModeRules.onSkip 책임 범위 | 03 §5.2: onSkip="라이프 차감/오타 가산 정책" ↔ 01 §5.5 공통 페널티는 모드 불변 | **분리 확정**: onSkip은 모드별 라이프 정책만(대륙/레이스 no-op, 티어/일주/데일리 −1). 공통 페널티(콤보 0·필요 타수 전량 오타·국가 점수 0)는 엔진이 일괄 적용. `MutableRunState={lives}` (M2 구현 확정) |
| D32 | 엔진 finished.result 타입 | 03 §5.1 `RunResult` 표기 ↔ @wt/shared computeScore 반환형과 동명 충돌 | **엔진 RunResult = 확장형 확정**: `{mode, lang, outcome:'completed'\|'gameover', practice, viaCheckpoint, stats:RunStats, score:ScoreResult}` — shared RunResult는 `ScoreResult`로 별칭. 점수는 computeScore 위임(재구현 아님) (M2 구현 확정) |
| D33 | useTypingEngine 반환 계약 | 03 §4.4: `{inputRef, focusInput}`만 ↔ §2.7/§2.8 렌더러 배선에 접점 부재 | **확장 확정**: `{inputRef, focusInput, controller, getInputValue}` (additive). 별칭 에코 원문은 표시 계층이 input 스냅샷(`getInputValue()`)에서 취득 — miss/exact 이벤트에 rawValue 미탑재 유지 (M2 구현 확정) |
| D34 | 지도 렌더 계층 바인딩 확장 | 07 WT-M2-04 #1: "코소보는 빌드에서 바인딩됨" ↔ 실제 산출물 XK.mapFeatureId=null(canonical 테스트 고정) | **렌더 계층 해소 확정**: buildGeoIndex가 `properties.name==='Kosovo'`를 XK에 수동 바인딩(02 §7c·03 §3.1 위임 그대로). 또한 `CountryGeo.continent` 필드 추가(setTarget 대륙색 파생용, additive) (M2 구현 확정) |
| D35 | i18n interpolation 규약 | packages/i18n 카탈로그: 단일 중괄호 `{var}` ↔ i18next 기본값 `{{var}}` | **단일 중괄호 확정**: i18next 초기화에 `interpolation.prefix='{' / suffix='}'` 지정(i18next-icu 불채택). 카탈로그는 그대로 (M2 구현 확정) |
| D36 | "3클릭·15초" 클릭 수 산정 | 00 §1.3·01 §11.1: 3클릭 ↔ 01 §10.1 화면 그래프(S1→S3→S4→S5)상 대륙 모드는 구조적으로 4클릭 | **최단 경로 기준으로 정정**: KPI는 "최단 경로(데일리 직행 등) 3클릭·15초". 대륙 정규 경로 4클릭은 허용(화면 그래프·보딩패스 시그니처 유지). D27과 동류의 문서 산술 착오 (M2 확정) |
| D37 | E2E 실행 대상 빌드 | 07 WT-M2-08: vite dev 기동 ↔ dev(StrictMode)에서 useTypingEngine 입력 결함 발견 | **프로덕션 프리뷰(build+preview) 대상 확정**(실배포 등가물). 단 dev StrictMode 입력 결함은 별도 수정(WT-M2-09) — E2E 대상 결정과 무관하게 dev 플레이는 동작해야 한다 (M2 확정) |
| D38 | users.user_id ↔ 세션 pid 관계 | 04 §5: pid=base58(HMAC("pid:"+deviceId))[0:12] 결정적 파생 ↔ 06 §1.3: users.user_id TEXT PK(출처 미명세, UUIDv7 예시 뉘앙스) | **동일값 확정**: `user_id = pid` (결정적 파생, 랜덤 UUID·매핑 테이블 없음). bootstrap 멱등(D10 정합), runToken.pid 직접 비교(04 §6.2-①) 성립. v2 소셜 로그인 계정 연동 시 별도 canonical-user 매핑 도입 여지는 남긴다 (M3 구현 확정, 2026-07-21) |
| D39 | 제출 검증 실패 응답 형식 | 04 §6.2: 401/409 + 명명 코드(INVALID_TOKEN 등) ↔ 06 §3.1·구현: 항상 200+verdict | **06 승**: 전 케이스 HTTP 200 + `verdict`만 반환, `verdict_reason`은 DB 전용(API 비노출 — 어뷰저 탐지 신호 차단). 04 §6.2의 HTTP 코드 열은 내부 분류표로만 읽는다. verdict 어휘는 마이그레이션 CHECK 기준 `valid\|flagged\|practice\|rejected` (M3 확정) |
| D40 | 리더보드 total 분모 | 06 §1.4-② total 예시: JOIN 없는 COUNT ↔ 같은 절 rank 쿼리: `u.status='active'` 필터 | **rank와 동일 분모로 통일**: total도 users JOIN + status='active'. "모든 경로 동일 순위" 불변식(§1.2)이 예시 SQL 자구보다 상위 (M3 확정) |
| D41 | seasons.season_id 포맷 | 마이그레이션 주석 's:2026q3'(접두 포함) ↔ 06 §1.3 write 경로 `s:${season}` 함의 | **periodKey 원문 그대로**('s:2026q3') 저장·사용 — 이중 접두 금지. boardKeysForRun은 season_id를 그대로 periodKey로 사용. v1은 seasons 행 없음(D15)이라 실행 무영향 (M3 확정) |
| D42 | daily_no 산식 | 문서 미정의(UNIQUE 제약만) | **MAX(daily_no)+1 순차 증가** 확정(조회 후 INSERT, date_kst PK가 레이스 흡수) (M3 확정) |
| D43 | 신고 reason 코드·임계 스코프 | 06 §3.6: UI 문구만 존재, API 어휘 미정의 | **코드 3종 확정**: `macro_suspected\|nickname_inappropriate\|other`. 임계 5건은 target_user_id 기준 OPEN 카운트, flagged 대상은 임계 도달 신고의 target_run_id (M3 확정) |
| D44 | 리더보드 "내 지역" 탭 v1 | 03 §1.1: Global/내 지역 2탭 ↔ 세션 응답에 geo 미노출(users.geo는 D1 전용) | **v1은 스텁 유지, M5에서 활성화**: POST /session·GET /session/me 응답에 `geo`(CF-IPCountry 저장값) 필드를 추가하고 RankPage 탭을 배선하는 소형 태스크를 M5에 편성. 클라 측 IP/타임존 추정 금지 (M3 확정) |
| D45 | 홈 히어로 지도 로딩 전략 | 03 §8.3 확정 청크: HeroMap이 d3-geo+topojson eager import ↔ 03 §8.5 LCP<2.5s 예산(실측 2.64s 초과) | **§8.3 개정 — 홈 한정 lazy 전환**: HeroMap(d3-geo/topojson/geo-index)은 React.lazy 청크로 분리하고, 즉시 페인트되는 경량 플레이스홀더(인라인 실루엣 SVG 또는 히어로 텍스트/카드)가 LCP 요소가 되도록 설계. 게임 라우트 지도 로딩은 불변. LCP 게이트가 성능 예산의 상위 계약 (M5 확정, 2026-07-22) |
| D46 | Pretendard 웹폰트 v1 | 03 §8.1 폰트 preload ↔ npm 레지스트리에 한글 서브셋 패키지 부재(전체 2.0MB뿐) | **웹 UI는 v1 시스템 폰트 스택 확정**(Pretendard 웹폰트 셀프호스트는 백로그 — 서브셋 파이프라인 필요). 단 M6-02 OG 렌더러는 satori용 서브셋 TTF가 필수이므로 subset-font(npm, harfbuzzjs) 빌드 스텝을 M6-02 태스크 내에서 신설(~180KB, KS 완성형 + 라틴/숫자) (M5 확정) |
| D47 | 홈 LCP 실원인·해소책 (D45 진단 정정) | D45 진단(지도 eager가 원인) ↔ 실측 반증: lazy 분리 후에도 LCP 2640ms 불변(5/5, 베이스라인 동일), LCP 요소는 S2 언어 게이트 문구, 게이트 제거 실험에서도 2640ms — CSR 첫 페인트 JS 총비용(4x 스로틀)이 상한 | **정적 크리티컬 셸 확정**: index.html의 #root 안에 S2 언어 게이트+히어로 타이틀을 정적 HTML/CSS로 인라인, 최소 인라인 스크립트가 React와 동일한 localStorage 상태를 기록(동일 data-testid 유지 — E2E 호환). React 마운트 시 자연 대체(createRoot가 교체). D45의 지도 lazy 분리는 엔트리 위생 개선으로 유지. LCP 게이트 <2.5s 불변 (M5 확정, 2026-07-22) |
| D48 | LCP 판정 환경·정적 셸 독립 페인트 보장 | D47 이행 후에도 로컬 Lighthouse(simulate)가 2490/2640ms 바이모달 — React 커밋이 같은 프레임에 정적 셸을 교체하면 독립 페인트 미기록(레이스, 실측 입증) | **2단 확정(개정판)**: ① main.tsx의 createRoot 초기 render를 double-rAF 지연해 정적 셸 독립 페인트 보장(실측: 중앙값 2640→2160ms, 단 4/10회 2640ms 이산 재발 — 로컬 환경 콜드/웜 분기로 판명, 추가 지연 해킹 금지). ② 규범 게이트는 스펙 그대로 **Lighthouse CI(표준 러너, <2.5s assert)** — 로컬 dev 머신 측정은 **정보용 수치 보고만**(밴드 assert 없음). 원격 CI 활성화 시 실판정 (M5 확정, 2026-07-22) |

### 11.2 오픈 퀘스천 (결정 기한 명시)

| # | 질문 | 기한 | 기본값(미결 시) |
|---|---|---|---|
| Q1 | typetrip.gg 도메인·상표 가용성 | M0 종료 | typetrip.kr → typetrip.app 순 폴백 |
| Q2 | en 등급 컷 보정 계수(±15% 이내, `config:grades`) | 런칭 +2주 (percentile 데이터) | ko와 동일 컷 |
| Q3 | GA4 활성 시점 (동의 배너 포함, AE만으로 시작 가능) | M6 | 런칭 시 OFF, 마케팅 캠페인 개시 시 ON |
| Q4 | 고스트 봇 콜드 스타트 프로필 3종(스플릿 타임 상수) | M4 | 중급자 PI 250/350/450 프로필을 티어 모드 파 타임에서 역산 |
| Q5 | Turnstile 활성 임계(시간당 신규 세션 기준) | 런칭 후 관측 | 비활성(시크릿 자리만) |
| Q6 | 소프트 런치 채널/지역 | M6 | staging 링크 폐쇄 배포 → 국내 커뮤니티 1곳 |
| Q7 | 시즌·PI 밴드 매칭 도입 | v1.5 킥오프 | 미도입 |

---

## 12. 문서 맵 & 구현 프롬프트(docs/07) 사용법

### 12.1 canonical 문서 맵

| 파일 | 제목 | 권위 영역 | 주 소비 마일스톤 |
|---|---|---|---|
| `docs/00-master-overview.md` | 마스터 개요 & 로드맵 (본 문서) | 스코프·모순 해소·로드맵 — **전 문서에 우선** | 전체 |
| `docs/01-game-design.md` | 게임 디자인 문서(GDD) | 게임 규칙·모드·점수 공식·UX 흐름·juice | M2, M5 |
| `docs/02-data-content.md` | 데이터 & 콘텐츠 명세 | 국가 스키마·매칭 규칙·티어·노선/루트·빌드 파이프라인 | M1 |
| `docs/03-frontend-architecture.md` | 프론트엔드 아키텍처 | 클라 스택·**IME 입력 엔진**·지도·상태·테스트 | M2, M5 |
| `docs/04-backend-cloudflare.md` | 백엔드 & Cloudflare 아키텍처 | 인프라·REST API·세션/토큰·wrangler·배포·비용 | M0, M3 |
| `docs/05-multiplayer-protocol.md` | 멀티플레이 실시간 프로토콜 | WS 메시지 전문·DO 상태머신·매치메이킹·검증 | M4 |
| `docs/06-rankings-ops.md` | 랭킹 · 운영 · 성장 | 리더보드 스키마·안티치트 운영·프라이버시·분석·런칭 체크리스트 | M3, M6 |
| `docs/07-implementation-prompts.md` | 구현 프롬프트 (Fable 5 작성 예정) | 마일스톤별 에이전트 작업 지시서 | 전체 |

### 12.2 하위 문서 상호 참조 정규화 (문서 번호 표기가 어긋나는 부분의 해석표)

각 문서는 집필 시점의 가번호로 상호 참조하고 있다. 실제 파일로는 다음과 같이 읽는다:

| 원문 표기 | 실제 문서 |
|---|---|
| 01이 참조하는 "03. 입력 엔진 스펙" | `docs/03` §2 |
| 01이 참조하는 "04. 멀티플레이 프로토콜" | `docs/05` |
| 01이 참조하는 "05. Cloudflare 아키텍처" | `docs/04` |
| 01·02가 참조하는 "06. 랭킹/부정 방지" | `docs/06` |
| 05가 참조하는 "04. 게임플레이/점수" | `docs/01` §6~§7 |
| 05가 참조하는 "07. Cloudflare 아키텍처" | `docs/04` |
| 06이 참조하는 "05. Cloudflare 아키텍처" / "04. 멀티 프로토콜" | `docs/04` / `docs/05` |

### 12.3 docs/07 구현 프롬프트 사용법 (구현 에이전트 운영 규칙)

`docs/07`은 마일스톤(M0~M6)별 장으로 구성되며, 장 안의 **태스크 1개 = 에이전트 세션 1개 = PR 1개**를 원칙으로 한다. 각 태스크 프롬프트는 다음 5요소를 반드시 포함한다:

1. **컨텍스트 좌표**: 읽어야 할 문서·섹션의 정확한 위치(예: "docs/03 §2.5~2.7 + docs/00 §11-D7"). 문서 전체를 다시 읽히지 않는다.
2. **산출 파일 경로**: §6 트리 기준 절대 경로 목록(생성/수정 구분).
3. **수용 기준(acceptance)**: 통과해야 할 구체적 테스트 명령(예: `pnpm --filter @wt/shared test`, `pnpm e2e --grep E2`)과 마일스톤 완료조건 중 해당 항목.
4. **금지사항**: 해당 태스크에서 건드리면 안 되는 것(예: "마이그레이션 파일 수정 금지", "핫패스에 React state 도입 금지").
5. **에스컬레이션 규칙**: 문서 간 충돌이나 미정의 사항을 발견하면 **코드에서 임의 해석하지 말고**, 본 문서 §11에 결정 행을 추가 제안(PR 코멘트)한 뒤 리드 승인 후 진행한다.

에이전트 워크플로: (a) 프롬프트의 컨텍스트 좌표 + **본 문서 §11을 항상 먼저** 읽는다 → (b) 구현 → (c) acceptance 명령 로컬 실행 → (d) PR 생성(§10.2 PR DoD 체크리스트를 PR 템플릿에 포함) → (e) CI 그린 + 리뷰 통과 시 머지. 마일스톤 경계에서는 리드가 acceptance 전 항목을 통합 검증하고 §9 리스크 레지스터와 §11 표를 갱신한 뒤 다음 마일스톤 프롬프트를 발행한다.