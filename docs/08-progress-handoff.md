# 08. 진행도 & 핸드오프 (다른 PC에서 이어서 작업하기)

> 최종 갱신: **2026-07-23** / 작성: Fable 5 (리드 아키텍트)
> 이 문서는 **작업 진행 상태의 단일 원천**이다. 새 환경(다른 PC, 새 Claude Code 세션)에서 이 저장소를 열면 이 문서 → `docs/00` §11 → `git log` 순으로 읽고 이어서 작업한다. 진행 상태가 바뀌면 이 문서의 스냅샷 절을 함께 갱신한다.

---

## 1. 상태 스냅샷 (2026-07-23 기준)

**docs/07의 계획 태스크 42개(M0~M6) 전부 구현 완료.** 코드로 할 수 있는 작업은 100% 끝났고, 남은 것은 §6의 수동/원격 항목뿐이다.

| 항목 | 값 |
|---|---|
| 브랜치 / 커밋 | `main` / 62개 (마지막: `2270faa` WT-M6-06) |
| 테스트 | 루트 1,099개 그린 (일반 vitest 795 + workers pool 212 + DO pool 92) |
| E2E (Playwright) | 25개 그린 — E1~E10 + 치트 6종·섀도우밴 + 멀티 E6/E7 + 공유 캡처 |
| 커버리지 | `shared`·`engine` 95~100% (게이트 95%), 그 외 60%+ |
| 성능 | entry 96KB gzip(예산 170KB) / LB p95 7.5ms(로컬) / 멀티 tick p95 268ms(<400ms SLO) / LCP는 D48 체제(규범=Lighthouse CI, 로컬은 정보용) |
| 리드 결정 | `docs/00` §11 **D1~D56** (이번 빌드에서 D26~D56 31건 추가 — 전부 실측 근거) |

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

- **GitHub 원격·Cloudflare 계정 미연결** 상태로 빌드됨 → PR/CI/배포는 실행 이력 없음(파일은 완비). 로컬 커밋만 존재. 원격 연결 후 활성화 절차: `.github/workflows/README.md`.
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

---

## 6. 남은 작업

### 6.1 수동/원격 항목 (사용자만 가능 — 원천: `tooling/ops/launch-checklist.md`)

1. 도메인/상표 확정(오픈퀘스천 Q1: typetrip.gg → kr → app) + SSL + HSTS preload 제출
2. GitHub 원격 push + Cloudflare 계정 연결 → 실 리소스(D1/KV/R2/Queue/AE) 발급 → staging 배포 (절차: `.github/workflows/README.md`)
3. staging에서 k6 부하 3종 정식 실행(제출 200rps/LB 1,000rps/멀티 500방) + 테스트 데이터 정리 (`tooling/ops/loadtest-report.md` §staging 절차)
4. D1 복구 리허설 1회 (`tooling/ops/runbook.md`)
5. 링크 미리보기 3종(X/Threads/카카오) 검증 스크린샷
6. **실기기 IME 스모크 시트** — iOS Safari, Android Gboard/삼성키보드 (`tooling/ops/ime-qa-sheet.md`, 릴리스 게이트)
7. GA4 ON/OFF 결정(Q3), privacy 페이지 운영 주체 {PLACEHOLDER} 확정, 소프트 런치 채널(Q6)
8. Lighthouse CI·size-limit·치트 스위트가 원격 CI에서 실제로 도는지 첫 PR로 확인

### 6.2 코드 백로그 (v1 필수 아님 — §11 결정으로 이연된 것)

- Pretendard 웹폰트 셀프호스트(서브셋 파이프라인은 M6-02에 이미 존재 — 웹 UI 적용만 남음, D46)
- 서버 사이드 lives 시뮬레이션(run-verify에 추가 — 현재 livesLost는 클라 신뢰, D52-④)
- IG 공유용 캔버스 재렌더(OG 레이아웃 재사용, D52-⑦)
- 라이트 테마 텍스트용 대비 보정 토큰(D50), docs/03 §7.3·§8.3 등 본문 표기를 §11 결정에 맞춰 일괄 정리(선택)
- Windows vitest-pool-workers 좀비 workerd 정리 자동화(관측만 됨, 비차단)

---

## 7. 이어서 작업할 때의 규칙 (요약)

1. 항상 `docs/00` §11(D1~**D56**)을 먼저 읽는다 — 하위 문서와 충돌하면 §11이 이긴다.
2. 새 작업은 §3의 파이프라인(구현→독립 검증→커밋)을 유지한다. 문서 충돌 발견 시 코드에서 임의 해석 금지 — §11에 D행 추가 후 진행.
3. 커밋 메시지에 작업 ID 포함(진행 추적의 원천이 git log다). 마이그레이션 append-only, 시크릿 커밋 금지, 산출물(`generated/`, `public/data/`) 손편집 금지.
4. 이 문서(§1 스냅샷, §5 매핑, §6 잔여)를 상태 변화 시 함께 갱신한다.
