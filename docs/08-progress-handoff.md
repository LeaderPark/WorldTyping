# 08. 진행도 & 핸드오프 (다른 PC에서 이어서 작업하기)

> 최종 갱신: **2026-07-24** / 작성: Fable 5 (리드 아키텍트)
> 이 문서는 **작업 진행 상태의 단일 원천**이다. 새 환경(다른 PC, 새 Claude Code 세션)에서 이 저장소를 열면 이 문서 → `docs/00` §11 → `git log` 순으로 읽고 이어서 작업한다. 진행 상태가 바뀌면 이 문서의 스냅샷 절을 함께 갱신한다.

---

## 1. 상태 스냅샷 (2026-07-24 기준)

**docs/07의 계획 태스크 42개(M0~M6) + M6 이후 후속 리드 태스크 전부(§5.1 — 라이트 디자인 시스템, 자기호스팅 이전, 디자인 정합 WT-DC, 계정 로그인 WT-AUTH 배치) 구현·검증 완료, `main`=`origin/main`=`98b1cda`가 prod에 라이브.** 남은 것은 §6의 수동/원격 항목과 백로그뿐이다.

| 항목 | 값 |
|---|---|
| 브랜치 / 커밋 | `main` / 마지막 `98b1cda` (origin/main 푸시·배포됨) |
| 라이브 | <https://worldtyping.leaderpark.net> — 자기호스팅 Docker+Tunnel(§8.6), 인증 배치 재배포 2026-07-24(§8.7) |
| 테스트 (2026-07-24 배포 게이트) | 전체 e2e **36/36** 그린(axe wcag2aa 포함) · web 단위 541 · contrast-check 29/29 · typecheck·lint 그린. (M6 시점 루트 vitest 1,099개 그린 — 이후 태스크마다 개별 회귀 통과) |
| 커버리지 | `shared`·`engine` 95~100% (게이트 95%), 그 외 60%+ |
| 성능 | entry 96KB gzip(예산 170KB, M6 측정) / LB p95 7.5ms(로컬) / 멀티 tick p95 268ms(<400ms SLO) / LCP는 D48 체제(규범=Lighthouse CI, 로컬은 정보용) |
| 리드 결정 | `docs/00` §11 **D1~D71** (M6 이후 D57~D71 — 전부 실측/리드 확정 근거) |

회귀 확인(전체 그린이어야 정상 상태):

```bash
pnpm install --no-frozen-lockfile   # 최초 1회 (아래 §2 셋업 선행)
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                            # 웹 빌드 + wrangler dev 자동 기동, 실행별 상태 격리
```

---

## 2. 새 PC 셋업 절차

저장소 이동은 **git 히스토리 포함 전체**여야 한다(GitHub 원격 push 후 clone, 또는 폴더 통째 복사 — `.git` 포함).

1. **필수 도구**: Node ≥22 (개발 기준 v24), pnpm 10.x (`corepack enable` 또는 `npm i -g pnpm`), git. 선택: k6 (`winget install k6` — 부하 스크립트용).
2. **의존성**: 루트에서 `pnpm install --no-frozen-lockfile` (postinstall 승인 목록은 루트 package.json의 `pnpm.onlyBuiltDependencies`에 이미 등록됨).
3. **로컬 시크릿**: `workers/api/.dev.vars.example`을 `workers/api/.dev.vars`로 복사(값은 더미 그대로 사용 가능 — gitignore 대상이라 저장소에는 없음).
4. **Playwright 브라우저**: `pnpm --filter @wt/e2e exec playwright install chromium`.
5. **D1 로컬 마이그레이션**: `cd workers/api && pnpm exec wrangler d1 migrations apply wt-main-dev --local`. (E2E는 자체 persist 디렉터리에 매 실행 자동 적용하므로 이 단계는 수동 `wrangler dev` 개발용.)
6. **검증**: §1의 회귀 확인 명령 실행 → 전부 그린이면 이어서 작업 가능.
7. **플레이 확인**: `pnpm build` 후 `pnpm --filter @wt/api run dev` → http://localhost:8787 (프로덕션 등가), 또는 `pnpm dev`(Vite+wrangler 동시).

**이 저장소에 없는(이동하지 않는) 것들** — 전부 위 절차로 재생성됨: `node_modules/`, `workers/api/.dev.vars`, `.wrangler/`(로컬 D1/KV 데이터 — 일회성 개발 데이터라 백업 불필요), `e2e/artifacts/`(스크린샷 — 재생성 스크립트 존재), Claude Code 세션 메모리(이 문서가 대체).

---

## 3. 작업 방식 (사용자 확정 지시 — 계속 유지할 것)

사용자(리드)가 명시한 모델 역할 분리. CLAUDE.md의 "모델 사용 정책"과 함께 적용:

- **계획/설계/에스컬레이션 결정/문서 갱신 = Fable 5** (리드 아키텍트 역할).
- **실제 구현 = Sonnet/Opus** 에이전트 (라우팅은 `docs/07` §0.2 표). **구현 프롬프트는 Fable 5가 작성해 전달**한다.
- 태스크 파이프라인: 구현 에이전트 → **독립 검증 에이전트**(acceptance 명령 직접 재실행, 구현 보고 불신) → 실패 시 수정 루프(최대 2회) → **통과 시에만 커밋**(태스크당 1커밋, Conventional Commits, 작업 ID를 메시지에 포함).
- 검증 실패 원인이 코드가 아닌 **문서 충돌**이면 수정 루프를 돌지 않고 리드에게 에스컬레이션 → 리드가 검산 후 `docs/00` §11에 D행 추가 + 관련 문서 동기 정정 → 재개. (이 방식으로 D26~D56이 만들어졌고, 기획 문서의 산술 오류·치명 버그 다수를 잡았다.)
- 순차 실행 원칙(태스크 병렬 금지): pnpm lockfile 경합과 `git add -A` 커밋 교차 오염 방지.

## 4. 환경 제약 (이 빌드가 전제한 것)

- ~~**GitHub 원격·Cloudflare 계정 미연결** 상태로 빌드됨~~ → **2026-07-23 연결·배포 완료**(아래 §8 배포 기록 참조). GitHub 원격 `github.com/LeaderPark/WorldTyping`(main 푸시됨), Cloudflare 계정 연결(OAuth), **prod가 `https://worldtyping.leaderpark.net`에 라이브**. CI/CD 워크플로 자동 활성화 절차는 여전히 미실행(GitHub Secrets/Environments 등록 필요 — `.github/workflows/README.md`).
- E2E는 밀폐 설계: `workers/api/scripts/e2e-dev-server.mjs`가 실행별 persist 디렉터리 초기화+마이그레이션. 세션 생성 경로는 `e2e/helpers/session-budget.ts`(+`identity.ts`) 경유 필수 — 서버 레이트리밋(10회/60초/IP, 신규 pid 20/h)을 스위트가 스스로 넘지 않게 하는 장치다. **새 E2E 스펙을 추가할 때 반드시 이 헬퍼를 쓸 것.**
- 로컬 Lighthouse LCP는 정보용(D48) — 규범 게이트는 원격 Lighthouse CI. 로컬 k6 제출 p95도 단일 SQLite 한계로 참고용(staging 재검증 절차는 `tooling/ops/loadtest-report.md`).

---

## 5. 완료 태스크 ↔ 커밋 매핑

`git log --oneline --reverse`와 1:1 대응. 각 태스크의 계약은 `docs/07`의 동명 블록.

| 마일스톤 | 태스크(커밋) |
|---|---|
| M0 스캐폴드 | M0-01 `66de807` · M0-02 `841e7e5` · M0-03 `7ddc09c` |
| M1 shared 코어 | M1-01 `39473cd` · M1-02 `4eee776` · M1-03 `3ce6eb6` · M1-04 `96074b3` · M1-05 `0f6e119` · M1-06 `3d2e70b` · M1-07 `fb7c1d2` |
| M2 타이핑 엔진+싱글 | M2-01 `6bb3f0f` · M2-02 `98e6c70` · M2-05 `a2e4180` · M2-03 `2637b80` · M2-04 `925a855` · M2-06 `ee0881a` · M2-07 `b1a2901` · M2-08 `ae139b4` · **핫픽스 M2-09** `dff00c5`(dev StrictMode 입력 결함) |
| M3 백엔드+랭킹 | M3-01 `758282a` · M3-02 `4aab320` · M3-03 `e267861` · M3-04 `d5cd928` · M3-05 `fcc7fc7` · M3-06 `01e8af8` · M3-07 `0f008a9` · **핫픽스 M3-08** `b4db17a`(E2E 밀폐화) |
| M4 멀티플레이 | M4-01 `0f6480a` · M4-02 `edd25c5` · M4-03 `190d8fe` · M4-04 `176a26d` · M4-05 `becff6f` · M4-06 `84edd70` |
| M5 폴리시 | M5-01 `9ab0c65` · 01b `22d3776` · 01c `0f87426` · 01d `811d3d3`(LCP 사가 — D45→D47→D48) · M5-02 `d8d60b6` · M5-03 `81cf306` · M5-04 `6b84852` · M5-05 `4268fb3` |
| M6 런칭 준비 | M6-01 `6eda971` · M6-02 `21bc89c` · M6-03 `09e3471` · M6-04 `4e260d9` · M6-05 `324969a` · M6-06 `2270faa` |
| 리드 결정(docs) | `0af480d`(D26) `f78bca6`(D27·28) `5f3bd2f`(D29) `ff54483`(D30~37) `871c9a3`(D38) `18caeaf`(D39~44) `2da594d`(D45·46) `2e8abae`(D47) `a8bffb6`·`db959cc`(D48) `fde5306`(D49·50) `b26acf2`(D51~53) `d55ddff`(D54·55) `4173c10`(D56) |

### 5.1 M6 이후 후속 리드 태스크 (D57~D73) — 전부 main 머지·라이브 배포 완료

M6 완료 후 리드 지시로 추가된 후속 태스크 계열. `docs/00` §11 **D57~D71**이 이 계열의 결정이다(§11이 항상 진실). 판정·점수·프로토콜·엔진 이벤트 계약은 불변이고, 예외는 §11에 명시된 additive 확장뿐이다(D68 인증 계층·D70 입력 버퍼 소유권 등). 아래 해시는 대표 커밋(태스크별 `feat`+`Merge` 짝이 있는 경우 리드 매핑 기준 하나만 표기) — 전체는 `git log --oneline 2270faa..98b1cda`.

| 계열 | 태스크(커밋) |
|---|---|
| prod 배포 → 자기호스팅 (§8) | Workers prod 최초 배포 `e5b6c23`·`0d70397`(해당 Worker는 이후 삭제 — §8.6) · WT-OPT-01 `c211bf7`(D60·D61) · WT-HOST-01 `a4db199`(+컨테이너 명명 `7dc3215`) · WT-HOST-02 `246151a`(터널 컷오버 LIVE) · 호스트 포트 8787→8790 `dceee2a` |
| 라이트 디자인 시스템 (WT-UI) | UI-01 `23b2525`(D57·D58·D62) · UI-02 `a83af6f`(D63) · UI-03 `a8fc86e`(D64·D65) · UI-04 `8660c3d` · UI-05 `32ae836` · UI-06 `4db5f86` · UI-07 `93fefee` · UI-08 `05f8a55` · UI-09 `2d97039` · OG 라이트 정합 `01528f7` |
| 디자인 정합 (WT-DC) | DC-01 `d1f9011` · DC-02 `50948bd` · DC-03 `8b695e8` · DC-04 `8146fc1` · DC-05 `b9468a8` · DC-06 `8c382cc` · DC-07 `2597a67`(D66) · DC-08 `90fd7a1`(D67, idle-spin 후속 `928ad72`) · DC-09 `42f72f6`(D69·D70) · DC-10 `26061a2`+`08f6aa9` · myBest 표기 확정 `2b6730c` · 공유 X/Threads 버튼 제거 `967cebc` |
| 계정 로그인 (WT-AUTH, D68) | AUTH-01 `6b05bb0` · AUTH-03 `d505837` · AUTH-02 `37032d7` · AUTH-04 `50765f9` · AUTH-07 `c7b1b98` · AUTH-05 `024666b` · AUTH-06 `f120a78` · 기어→테마 토글 `b6e549a` · AUTH-08(e2e 이행) `64983b1`+`875f4de` · a11y 대비 회귀 3종 후속 `98b1cda` |
| 리드 결정 (docs) | `ffc5ba5`+`3922c5c`(D59~D65) · `191cd0f`(D68) · D66·D67·D69·D70은 해당 태스크 커밋에 동봉 · D71(멀티 라이브 검증 정책 — §8.7) |
| footer 튜닝 (WT-LGL-01·Tweak C, D72) | WT-LGL-01 — footer 법적 링크(개인정보/약관/지원)를 제자리 딤 스크림 모달로 전환 + 법적 본문 settings.lang 단일 언어화(신규 `features/legal/*`, 페이지·모달 공유 `LegalArticle`, `privacy.lang.*` 키 양쪽 삭제, §11-D72) · Tweak C — footer 하단 고정(AppShell flex 레이아웃) + 희소 페이지(로비) 방 목록 내부 스크롤. 표시/레이아웃 계층만(판정·점수·프로토콜·엔진 불변). 커밋 2개(Tweak C / WT-LGL-01) |
| 지구본 튜닝 (Tweak E, D73) | Tweak E — GlobeMap 비행 연출을 리드 참조 프로토타입(globe-flight.html)과 정합: 비행기 = 참조 제트 실루엣 path + 정적 `rotate(90) translate(-12 -12)`(신규 토큰 `--globe-plane-fill`/#fff·`--globe-plane-stroke`/#274690 + stroke 1.4 + drop-shadow) · 활성 홉 앰버 점선+글로우 트레일(`--globe-trail`/#ffb703·`--globe-trail-glow`/#ffd166, canvas 3-패스, 도착 후 600ms 페이드) + 진행 대륙색 프리픽스 폐기(완주 노선만 대륙색 아크) · lift `0.8+sin(π·raw)·0.85` · 홈 데모 순항 `HOME_GLOBE_HOP_DURATION_MS`=2600(`MoveVehicleOptions.durationMs` 활성화). **Tweak B(idle spin 0.55°/s·홈 홉 10~22s·IDLE_MIN_DT) 불변**, 표시 계층만(판정·점수·프로토콜·엔진 불변). docs 동기: §11-D73·03 §3.7(idle spin 0.55°/s 정정 포함). 커밋 1개(Tweak E, §11-D73) |

a11y 후속 3종(`98b1cda`)은 표시 계층 CSS/className만 변경(판정·점수·프로토콜·엔진 불변): ① `.wt-footer__copyright` opacity 0.8 제거(3.62:1 미달 → `--text-muted` 5.54:1) ② `text-red-600`→`red-700` 라이트(PrivacyPage×3·LoginModal×2, `dark:red-400` 유지) ③ `.wt-strip__secondary`(WT-DC-10 보조행)를 `--continent-*-text` 토큰으로 repoint(골드/시안 2.83:1 미달 → D62 대륙·테마별 튜닝 토큰, BoardingStrip이 `--wt-strip-continent-text` 주입).

---

## 6. 남은 작업

### 6.1 수동/원격 항목 (사용자만 가능 — 원천: `tooling/ops/launch-checklist.md`)

1. ~~도메인/상표 확정(Q1: typetrip.gg)~~ → **`worldtyping.leaderpark.net` 확정·배포됨**(존 leaderpark.net, 2026-07-23). SSL은 Cloudflare 커스텀 도메인 자동(Universal SSL). **HSTS preload 제출은 여전히 수동**(launch-checklist §1.7).
2. ~~GitHub push + CF 연결 → 리소스 발급 → staging 배포~~ → **완료(§8)**. 단 무료 플랜이라 **staging이 아닌 prod에 직행**, **R2/Queue/AE는 미발급**(prod 바인딩에서 제거, 코드 no-op 가드). CI/CD 자동화(GitHub Secrets/Environments)는 미설정 — 현재 배포는 로컬 wrangler 수동 배포.
3. staging에서 k6 부하 3종 정식 실행(제출 200rps/LB 1,000rps/멀티 500방) + 테스트 데이터 정리 (`tooling/ops/loadtest-report.md` §staging 절차)
4. D1 복구 리허설 1회 (`tooling/ops/runbook.md`)
5. 링크 미리보기 3종(X/Threads/카카오) 검증 스크린샷
6. **실기기 IME 스모크 시트** — iOS Safari, Android Gboard/삼성키보드 (`tooling/ops/ime-qa-sheet.md`, 릴리스 게이트)
7. GA4 ON/OFF 결정(Q3), 소프트 런치 채널(Q6). (~~privacy 운영 주체 {PLACEHOLDER}~~ → **LeaderPark·dkdleldjqkr976@gmail.com 확정** — D68-⑨)
8. Lighthouse CI·size-limit·치트 스위트가 원격 CI에서 실제로 도는지 첫 PR로 확인
9. **멀티 실-DO 2-클라 라이브 레이스 = 리드 결정으로 미실행(00 §11-D71 — 현재 커버리지 수용).** 멀티 로그인 필수(D68-①) + prod에 `/auth/dev` 우회 없음(D68-⑩) + Google OAuth 헤드리스 자동화 불가라 자동화 불가능 — 원할 경우 **수동 2계정 테스트**로만 검증 가능(§8.7)

### 6.2 코드 백로그 (v1 필수 아님 — §11 결정으로 이연된 것)

- Pretendard 웹폰트 셀프호스트(서브셋 파이프라인은 M6-02에 이미 존재 — 웹 UI 적용만 남음, D46)
- 서버 사이드 lives 시뮬레이션(run-verify에 추가 — 현재 livesLost는 클라 신뢰, D52-④)
- IG 공유용 캔버스 재렌더(OG 레이아웃 재사용, D52-⑦)
- 라이트 테마 텍스트용 대비 보정 토큰(D50), docs/03 §7.3·§8.3 등 본문 표기를 §11 결정에 맞춰 일괄 정리(선택)
- Windows vitest-pool-workers 좀비 workerd 정리 자동화(관측만 됨, 비차단)

---

## 7. 이어서 작업할 때의 규칙 (요약)

1. 항상 `docs/00` §11(D1~**D71**)을 먼저 읽는다 — 하위 문서와 충돌하면 §11이 이긴다.
2. 새 작업은 §3의 파이프라인(구현→독립 검증→커밋)을 유지한다. 문서 충돌 발견 시 코드에서 임의 해석 금지 — §11에 D행 추가 후 진행.
3. 커밋 메시지에 작업 ID 포함(진행 추적의 원천이 git log다). 마이그레이션 append-only, 시크릿 커밋 금지, 산출물(`generated/`, `public/data/`) 손편집 금지.
4. 이 문서(§1 스냅샷, §5 매핑, §6 잔여)를 상태 변화 시 함께 갱신한다.

---

## 8. 배포 기록 (2026-07-23 — 최초 prod 라이브)

**라이브 URL: <https://worldtyping.leaderpark.net>**

> ⚠️ **최신 상태(2026-07-24): §8.6 자기호스팅 스택 + §8.7 인증 배치 재배포가 현재 진실.** 아래 §8.1~8.5는
> **최초 Cloudflare Workers 배포 이력**이며, **그 Worker(`typetrip-prod`)는 삭제됨**(KV 무료 한도 소진 →
> 자기호스팅 전환). 현재 prod는 서버 Docker(wrangler dev/miniflare) + Cloudflare Tunnel로 `98b1cda`를 서빙한다.

### 8.1 무엇이 어떻게 배포됐나

| 항목 | 값 |
|---|---|
| GitHub 원격 | `github.com/LeaderPark/WorldTyping` (main 푸시됨) |
| Cloudflare 계정 | `132fc163aeb4d9194ddfff699c67af57` (dkdleldjqkr976@gmail.com), OAuth 로그인 |
| 존 | `leaderpark.net`(active) → 커스텀 도메인 `worldtyping.leaderpark.net` 자동 생성 + Universal SSL |
| Worker | `typetrip-prod` (`wrangler deploy --env prod`), `workers_dev = false` |
| D1 | `wt-main-prod` = `2d8ed3d7-9735-46d9-baae-c1c5dab53b02` (APAC), 마이그레이션 0001~0004 적용 |
| KV | `wt-kv-prod` = `7a23c9d9b86247b48b0c38ea762d1600` |
| DO | MATCH_ROOM / MATCHMAKER (SQLite classes — 무료 플랜 지원) |
| 시크릿 | SESSION_HMAC_SECRET·RUN_HMAC_SECRET·DAILY_SALT (`wrangler secret put --env prod`, 랜덤 32B hex) |
| Cron | 4종 등록(데일리 시드 / lb-refresher / 부정 급증 / 보존 정리) |

### 8.2 무료 플랜 적응 (다음 세션이 알아야 할 것)

- `wrangler.toml`의 **`[env.prod]`에서만** Queues·Analytics Engine·R2 바인딩을 제거했다. top-level(dev)·
  staging은 그대로라 **vitest 1,099개 영향 없음**(테스트는 top-level 설정 사용).
- 코드는 전부 미바인딩 가드가 있어 no-op으로 안전 동작: `report.ts`/`MatchRoom.ts`(EVENTS),
  `telemetry.ts`/`retention.ts`(AE); R2(BUCKET)는 코드 사용처 0. → prod에서 텔레메트리·신고 큐·
  고스트 수집만 비활성(허용된 저하). 싱글/데일리/멀티/랭킹/DB는 전부 정상.
- **Workers Paid 전환 시**: `[env.prod]`에 top-level과 동일한 `queues`·`analytics_engine_datasets`·
  `r2_buckets` 블록을 되살리면 코드 변경 없이 재활성화(R2/Queue 리소스 발급 선행).

### 8.3 인증 함정 (다음 세션 필독)

- 이 환경의 `CLOUDFLARE_API_TOKEN`(env)은 **Zone 권한만** 있어 배포·리소스 발급 불가(D1/KV/Workers 403).
- 배포 명령 전 **`Remove-Item Env:CLOUDFLARE_API_TOKEN`(PowerShell) / `unset CLOUDFLARE_API_TOKEN`(bash)로
  env 토큰을 해제**해야 `wrangler login` OAuth 자격증명(`…\xdg.config\.wrangler\config\default.toml`)이 쓰인다.

### 8.4 라이브 스모크 검증 (전부 통과)

- SPA(`/` 200) · `GET /api/v1/config`(200) · 세션 부트스트랩(D1 INSERT, geo=KR) · `session/me`(Bearer) ·
  `daily/today`(결정적 시드) · `lb`(빈 보드).
- 멀티: `POST /match/quick`·`POST /rooms`(200, 서명 티켓) → WS 업그레이드 → MatchRoom DO `hello→welcome`
  핸드셰이크 성공(세션 인증 + dataVersion 검증). 닉네임 검증도 라이브 동작 확인.
- 스모크로 생긴 GUEST_* 유저 소수는 runs/lb_best 없음 → 리더보드 무영향(정리 불요).

### 8.5 남은 것

- CI/CD 자동화: GitHub Secrets(계정 스코프 `CLOUDFLARE_API_TOKEN`)·Environments·브랜치 보호 등록
  (`.github/workflows/README.md`). 현재는 로컬 wrangler 수동 배포.
- HSTS preload 제출 · 실기기 IME 스모크 · 링크 미리보기 3종(launch-checklist).
- (선택) Workers Paid 전환 시 Queue/AE/R2 재활성화.

---

## 8.6 자기호스팅 이전 (2026-07-23 — 현재 prod 진실)

**계기**: §8.1 Workers 배포의 KV 무료 한도(쓰기/삭제/목록 각 1,000/일)를 `lb-refresher` 크론 낭비
버그(빈 보드 삭제 스톰 ≈6,900/일 + 매분 list 1,440/일)가 트래픽 0에서도 소진 → 리드가 자기호스팅 결정.

**현재 아키텍처**: `worldtyping.leaderpark.net` → Cloudflare Edge(TLS+`CF-IPCountry`) → **Cloudflare Tunnel
(remotely-managed, token)** → 24/7 서버 Docker. 앱 코드 재작성 없음 — `wrangler dev`(miniflare)가
D1/KV/DO/Queues/AE/R2/WS를 전부 로컬 시뮬레이션(**KV/D1 무료 한도 자체가 없음**; Queues/AE/R2도 자동 부활).

| 항목 | 값 |
|---|---|
| 코드/스택 | `tooling/selfhost/`(Dockerfile·docker-compose·entrypoint·cron-ping·backup·autoheal) |
| Compose 프로젝트 | `worldtyping` (컨테이너: `worldtyping`(app) + `worldtyping-{cloudflared,cron-ping,backup,autoheal}`), 볼륨 `worldtyping_wt-data`(/data = D1/KV/DO SQLite) |
| 구동 | `cd tooling/selfhost && docker compose --profile tunnel up -d --build` |
| 터널 | id `dc4baecc-430c-44af-891c-955daac82b5f`, remotely-managed(token, `.env`의 `CLOUDFLARE_TUNNEL_TOKEN`), ingress/DNS는 CF API 설정(proxied CNAME → `<id>.cfargotunnel.com`) |
| 시크릿 | `tooling/selfhost/.env`(gitignore) — 새 랜덤 32B(새로 시작, 데이터 이행 없음) |
| 크론 | cron-ping 컨테이너가 `/cdn-cgi/handler/scheduled?cron=...`+`Host:localhost:8787` 핑(`/__scheduled`는 assets가 가로채 무동작) |
| geo | `CF-IPCountry` 헤더 우선(§11-D61) — 라이브 `geo=KR` 검증됨 |

**터널을 브라우저 로그인 없이 만든 방법(다음 세션 참고)**: `cloudflared tunnel login`(브라우저)은 불요.
CF API로 터널 생성/ingress/DNS 처리 — **터널 API = wrangler OAuth 토큰(`connectivity:admin`), DNS API =
env `CLOUDFLARE_API_TOKEN`(Zone)** 로 나눠 사용(OAuth는 DNS 403, env는 Workers 403이라 역할 분담).

**옛 Cloudflare 리소스**: Worker `typetrip-prod` **삭제됨**. D1 `wt-main-prod`·KV `wt-kv-prod`는
**고아 상태로 유휴 잔존**(연산 0 → 쿼터/비용 0) — 선택적으로 삭제 가능(새로 시작이라 데이터 불요).

**운영 주의**: ① **Docker Desktop 부팅 시 자동 시작** 설정 필수(24/7 전제; 미설정 시 재부팅=다운타임).
② 전 서비스 `restart: unless-stopped`. ③ `/data` 일 1회 백업(내구성은 이제 우리 책임 — backup 서비스).
④ 커밋: `23b2525`(UI-01 라이트) `c211bf7`(OPT-01 낭비) `a4db199`(HOST-01 스택) `7dc3215`(명명) `246151a`(HOST-02 터널).
⑤ §11 D57~D65 정식 행 반영 완료(docs/00 §11 표) — 자기호스팅·lb최적화·geo·대비·카메라·국기·TAB.

**라이브 스모크(터널 경유, 전부 통과)**: 세션(geo=KR)·config·daily(no=1)·lb·멀티(방 생성→WS `welcome`).

---

## 8.7 인증 배치 라이브 배포 (2026-07-24 — 현재 라이브 코드)

**배포 커밋: `98b1cda`(= `origin/main`)** — WT-AUTH-01~08 + WT-DC-09/10 + a11y 후속(§5.1)을 §8.6 자기호스팅 스택에 재배포. 스택 구성은 §8.6 그대로(변경 없음).

- **구동**: Docker Compose `worldtyping` 앱 컨테이너(호스트 **8790**→컨테이너 8787) + Cloudflare Tunnel. `tooling/selfhost/entrypoint.sh`가 기동 시 **`0005_auth_identities` 마이그레이션을 적용**한 뒤 wrangler dev(miniflare) 서빙 — 기존 D1 데이터 볼륨(`worldtyping_wt-data`) 보존, 컨테이너 healthy.
- **배포 게이트(전부 그린)**: 전체 e2e **36/36**(axe wcag2aa 스캔 포함) · web 단위 테스트 541 · contrast-check 29/29 · typecheck·lint.
- **라이브 스모크(통과)**: 홈 배경 지구본(앰비언트 자동 데모, D68-⑦) · Google 로그인 GIS 버튼 렌더(승인된 JavaScript 오리진 정상) · Footer(개인정보/약관/지원, D68-⑨) · 멀티 로비 재디자인 + 로그인 게이트 렌더(D68-①⑧). 멀티 백엔드: `POST /api/v1/rooms` 무토큰 → **401 `INVALID_TOKEN`**, `GET /api/v1/rooms/public` → **200 `{rooms:[], counts:{public,private}}`**.
- **미실행(리드 결정 — 00 §11-D71)**: **멀티 실-DO 2-클라 라이브 레이스는 실행하지 않았다.** 사유: 멀티 로그인 필수(D68-①) + prod 컨테이너에 `/auth/dev` 우회 없음(`ENVIRONMENT=prod` — D68-⑩) + Google OAuth 헤드리스 자동화 불가. v1은 **현재 커버리지로 수용**: e2e mock DO(E6/E7) + DO 유닛(vitest-pool-workers, CI) + 위 라이브 백엔드 스모크. 실-DO 라이브 레이스 검증은 **수동 2계정 테스트**로만 가능(§6.1-9).
