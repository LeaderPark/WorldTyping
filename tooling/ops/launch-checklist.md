# 런칭 체크리스트 (docs/06 §10 — 전체 12항)

> **권위**: 각 항목의 정의/완료 기준은 `docs/06-rankings-ops.md` §10 표가 canonical이다. 이
> 문서는 그 12항을 실제로 무엇으로 어떻게 소거했는지(자동 항목의 증빙) 또는 원격/실기기/실도메인이
> 있어야만 완결되는 항목을 무엇을 어떤 순서로 실행해야 하는지(수동 항목의 절차)를 기재하는
> **실행 문서**다 — docs/06 §10과 문구가 어긋나면 docs/06이 이긴다.
>
> **정직성 원칙**: GitHub 원격·Cloudflare 계정이 이 세션에 연결되어 있지 않다. 원격 배포·실
> 도메인·실기기·링크 미리보기 크롤러가 필요한 항목은 "완료"로 위장하지 않고 **절차 기재**
> 상태로 정직하게 남긴다. 자동 항목은 로컬에서 실행 가능한 형태로 전부 구현·테스트했고, 커밋
> sha는 이 세션이 커밋하지 않으므로(리드가 커밋) 파일 경로/테스트 이름으로 증빙을 대신한다 —
> 실제 sha는 리드가 커밋 후 이 표에 채운다.
>
> WT-M6-02(OG 인프라)·WT-M6-05(부하 테스트)가 먼저 작성한 절 내용은 그대로 보존하고 아래 12항
> 구조 안에 편입했다(§2, §5).

## 요약표

| # | docs/06 §10 항목 | 구분 | 상태 | 근거 |
|---|---|---|---|---|
| 1 | 도메인/SSL | 수동 | 절차 기재 | §1 |
| 2 | SEO/OG | 자동 | 완료 | §2 |
| 3 | 사이트맵/robots | 자동 | 완료 | §3 |
| 4 | 에러 페이지(404/500)·장애 배너 | 자동 | 완료 | §4 |
| 5 | 부하 테스트 | 혼합 | 로컬 스모크 완료 / staging 실행 수동 | §5 |
| 6 | 무결성 리허설(치트 6종 E2E) | 자동 | 완료(기존 마일스톤 산출물) | §6 |
| 7 | 프라이버시 | 혼합 | 페이지/API 완료 / GA4·DPA 수동 | §7 |
| 8 | 크레딧/라이선스 | 자동 | 완료 | §8 |
| 9 | 백업 | 혼합 | 파이프라인 완료 / 복구 리허설 실행 수동 | §9 |
| 10 | 관측성 | 자동 | 완료(기존 마일스톤 산출물) | §10 |
| 11 | 데이터 신선도 | 자동 | 완료(기존 마일스톤 산출물) | §11 |
| 12 | 스토어 프리뷰(링크 미리보기 3종 스크린샷) | 수동 | 절차 기재 | §12 |

부록: 이 12항 표에는 없지만 WT-M6-06 세션 특이 조정에서 "담당을 사용자(리드)로 명시"하도록
지시된 추가 수동 게이트(실기기 IME 시트, GA4 결정, staging 소프트 런치) — §부록 참조.

---

## 1. 도메인/SSL — 수동 (담당: 사용자(리드))

docs/00 §11 오픈퀘스천 Q1(기한: M0 종료 — 이미 지남, 여전히 미결)이 이 항목의 선행 조건이다.

1. **상표/도메인 가용성 확인**(Q1): `typetrip.gg` WHOIS + 상표 검색 → 가용하면 등록. 불가하면
   폴백 순서 `typetrip.kr` → `typetrip.app`(Q1 기본값). 최후 수단은 R8 리스크 대응(런칭명을
   World Typing으로 회귀) — 이 단계까지 가면 §11에 결정 행을 새로 추가해야 한다(코드 임의 해석
   금지).
2. Cloudflare 대시보드 → "Add a Site" → 확정 도메인 등록 → 네임서버를 Cloudflare로 이전.
3. SSL/TLS → **Universal SSL** 발급 확인 → 암호화 모드를 **Full (strict)**로 설정(Origin
   Server가 유효 인증서를 제시해야 함 — Cloudflare Workers 커스텀 도메인은 자동으로 충족).
4. `workers/api/wrangler.toml`의 `env.prod.routes`(`<PUBLIC_ORIGIN placeholder>`)를 확정
   도메인으로 채운다. `env.staging.routes`(`staging.typetrip.example`)도 실제 서브도메인으로
   교체한다. **이 두 자리 외에는 코드 어디에도 도메인을 굽지 않는다**(§7 gotcha 7 — 이번 세션
   grep 결과 §부록 확인).
5. `PUBLIC_ORIGIN`(Worker 환경변수, `[env.*.vars]`)과 `VITE_PUBLIC_ORIGIN`(클라 빌드 변수, CI/빌드
   파이프라인의 env)을 확정 도메인으로 설정.
6. apex/`www` 리다이렉트: 코드는 이미 준비됨(`workers/api/src/mw/www-redirect.ts`, WT-M6-06) —
   www 서브도메인 요청을 구조적으로(문자열 하드코딩 없이) apex로 301 리다이렉트한다. 배포 후
   `curl -sI https://www.<도메인>/ ` → `301` + `location: https://<도메인>/` 확인.
7. **HSTS preload 신청**: 헤더 자체는 이미 모든 응답에 실린다(`workers/api/src/mw/security-headers.ts`,
   `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`). 도메인이 실제
   HTTPS로 뜨고 www→apex 리다이렉트가 확인되면:
   - <https://hstspreload.org/> 에 apex 도메인 입력 → 자동 점검(HTTPS 리다이렉트, HSTS 헤더,
     `includeSubDomains`, `preload`, max-age ≥ 1년) 통과 확인 → "Submit" 제출.
   - 제출은 즉시 반영이 아니라 브라우저 벤더 배포 주기(수 주~수개월)를 탄다 — 제출 완료 자체가
     이 항목의 "완료" 기준이다(브라우저 반영은 리드가 이후 별도로 확인).

---

## 2. SEO/OG

### 2.1 자동 항목(이번 세션, WT-M6-06)

- `apps/web/index.html`: title/description/OG(`og:type`·`og:site_name`·`og:title`·`og:description`·
  `og:image`(+width/height))/Twitter Card(`summary_large_image`) 정적 기본값. 노출명은 전부
  TypeTrip(코드네임 WORLD TYPING 제거).
- `apps/web/src/app/RouteMeta.tsx`(+ `RouteMeta.test.tsx`): AppShell에 마운트되어 SPA 라우트
  전환마다 `document.title`/description/OG/Twitter/`canonical`/`hreflang(ko,en,x-default)`을
  upsert(중복 태그 없음, 테스트로 확인). 홈·`/daily`·`/rank`·`/play`·`/multi`·`/passport`·
  `/privacy`·`/credits` 전부 커버. `/r/:id`·`/multi/:code`는 이 컴포넌트의 대상이 아니다 —
  아래 2.2가 서버에서 완전히 별도로 렌더한다.
- 인증: `pnpm --filter @wt/web test -- RouteMeta` (신규 테스트 2건 — 홈 메타 세팅, 라우트 전환
  시 갱신+비중복).

### 2.2 로컬에서 이미 검증됨(원격 불필요, WT-M6-02 산출물 보존)

- 렌더 왕복(PNG 시그니처·크기), 캐시 헤더(`immutable`), 미존재 shareId 404 셸, 폴백 PNG(500 없음):
  `pnpm --filter @wt/api test`(`test/og.test.ts` 14 케이스 + `test/og-multi.test.ts` 2 케이스).
- **렌더 p95(로컬 workerd 정보용 수치)**: `test/og.test.ts`의 "렌더 성능" 케이스가 10회 렌더 p95를
  콘솔에 보고한다(측정치: **p95 ≈ 201ms** — 목표 <350ms 충족, 단 로컬 workerd 수치임. D48 정신에
  따라 밴드 assert는 없다). 원격 판정은 아래 "staging p95 실측"으로 대체·확정한다.
- 결정성: `pnpm build:data` 재실행 시 `workers/api/src/og/og-maps.json` diff 0(CI `git diff --exit-code`).
- 폰트/폴백 산출물 재현: `pnpm build:og-fonts` 재실행 시 `pretendard-og-subset.{ttf,ts}`·`fallback-og.{png,ts}` diff 0.

### 2.3 원격 절차 (계정 연결 후 리드 실행) — 수동

관련 구현: `workers/api/src/routes/share.ts`(`/r/:shareId`·`/og/:shareId.png`·`/multi/:code`),
`workers/api/src/og/{render.ts,layout.ts,og-maps.json,fonts/,fallback-og.*}`,
`workers/api/src/routes/runs.ts`(share_id 발급), `workers/api/src/mw/security-headers.ts`(/r/* 임베드 예외).

#### 1. staging 배포 (배포 순서 불변식: migrations → deploy)

```bash
# shares 테이블은 0001에 이미 포함(신규 마이그레이션 없음) — 확인만.
wrangler d1 migrations apply wt-main-staging --env staging --remote
wrangler deploy --env staging
```

배포 후 산출물 확인:
- `curl -sI https://<staging-origin>/og/default.png` → `200`, `content-type: image/png`,
  `cache-control: public, max-age=31536000, immutable`.
- 실제 기록 1건 생성(플레이 or `runs/submit`) → 응답의 `shareId` 확보 →
  `curl -sI https://<staging-origin>/og/<shareId>.png` → `200 image/png`, immutable.
- `curl -s https://<staging-origin>/r/<shareId>` → `og:image`·`twitter:card` 메타 존재.
- (WT-M6-06 신규) `curl -s https://<staging-origin>/` → `<title>`·`og:title`·`meta[name=description]`
  존재 확인(정적 기본값 — §2.1). `curl -s https://<staging-origin>/rank` 등 SPA 라우트는 JS
  미실행 크롤러에게는 여전히 홈과 동일한 정적 HTML만 보인다(RouteMeta는 클라 실행 시점에만
  갱신) — 이는 §2.1 설계상 의도된 한계이며 §12의 링크 미리보기 대상(/r/:id, /multi/:code)에는
  영향이 없다(그 두 경로는 서버 렌더).

#### 2. staging p95 실측 (docs/06 §9.1 목표 <350ms — 규범 판정)

캐시 miss(첫 렌더) 경로를 측정해야 한다. share_id마다 1회만 렌더되므로 **서로 다른 shareId 10개**로 측정한다.

```bash
# 사전: 서로 다른 기록 10건을 제출해 shareId 10개를 확보(tooling/ops/loadtest 스크립트 재사용 가능).
for id in $(cat shareids.txt); do
  curl -s -o /dev/null -w "%{time_total}\n" "https://<staging-origin>/og/$id.png"
done | sort -n | awk '{a[NR]=$1} END{print "p95(s)=", a[int(NR*0.95)]}'
```

- 통과 기준: p95 < 0.350s. (CF 엣지 캐시 웜업 후 2회차부터는 캐시 히트라 <50ms — 반드시 **신규
  shareId**로 miss 경로를 재라.)
- 결과를 `ops/loadtest-report.md`에 append(docs/06 §10-#5와 동일 아카이브 규칙).

#### 3. 링크 미리보기 검증기 (docs/06 §10-#2·#12 — 바이럴 첫인상 최종 승인, §12와 공유)

staging 공개 URL이 있어야 외부 검증기가 크롤할 수 있다(로컬 wrangler dev는 외부 도달 불가라 이 단계는
**원격 전용**).

- **X(Twitter) Card Validator**: <https://cards-dev.twitter.com/validator> 에 `https://<origin>/r/<shareId>`
  입력 → `summary_large_image` 카드 + 1200×630 이미지 렌더 확인 → 스크린샷 아카이브.
- **Kakao 디버거**: <https://developers.kakao.com/tool/debugger/sharing> 에 같은 URL 입력 →
  제목/설명/이미지 확인. (og 캐시가 오래되면 "다시 스크랩" 실행.)
- **Threads/Facebook(선택)**: Meta Sharing Debugger로 og:image 확인.
- **방 초대 미리보기**: `https://<origin>/multi/<활성 roomCode>` → "타이핑 레이스 초대 — {lang} ·
  {n}/{max}명" 메타 + `/og/default.png` 이미지 확인. 만료된 방 코드 → "레이스가 끝났어요" 대체 메타 확인.
- 스크린샷 3종(X/Threads/카카오)을 아카이브(docs/06 §10-#12, §12 참조).

#### 4. robots/sitemap OG 노출

WT-M6-06에서 실제로 구현·확정(§3 참조) — `/og/`는 Allow, `/multi/*`는 Disallow, `/api/`도
Disallow(§3 결정 근거 참조), `/r/`는 별도 disallow 없음(기본 허용, 공유 랜딩은 인덱싱 대상).

#### 5. CSP/임베드 회귀 확인 (docs/06 §9.4)

- `curl -sI https://<origin>/r/<shareId>` → `content-security-policy`에 `frame-ancestors` **없음**
  (블로그 iframe 임베드 허용), `x-frame-options` 헤더 **없음**.
- `curl -sI https://<origin>/` (게임 라우트) → CSP에 `frame-ancestors 'self'` 유지(클릭재킹 방지).

#### 6. CF 캐시·CPU 예산 (docs/06 §9.1 "share_id당 1회 렌더")

- 동일 shareId 2회 요청 → 2회차 `cf-cache-status: HIT`(엣지 캐시) 또는 Worker `caches.default` 히트로
  재렌더 없음. `wrangler tail --env staging`로 렌더 로그가 share_id당 1회만 찍히는지 육안 확인.

### 2.4 로컬 wrangler dev curl 검증 (이 세션 대체 절차 — §3 세션 조정 지시)

staging 배포가 불가능해 로컬 `wrangler dev`(8787)를 대상으로 동등한 curl 검증을 수행했다.
실행 로그는 최종 보고에 원문으로 포함한다. 확인 항목: 홈(`/`)의 `<title>`/`og:title`/
`meta[name=description]` 정적 태그, `/daily`·`/rank`(SPA 정적 셸 — RouteMeta는 클라 실행 후
갱신), `/og/default.png`(200, image/png, immutable), 존재하는 shareId의 `/r/:id`(og:image·
twitter:card 메타).

### 2.5 미해결/이월 (WT-M6-02 원본 보존)

- **폰트 서브셋 크기**: D46 추정 ~180KB 대비 실제 KS 완성형(2350자) Pretendard Regular 서브셋은
  **~425KB TTF**로 산출됨(한글 아웃라인이 추정보다 무겁다). 기능(닉네임 커버리지) 우선으로 D46의
  "KS 완성형" 요건을 그대로 지켰다 — 크기 추정치만 실측과 어긋난다(escalation, 리드 확인 요청).
- **satori 700 weight**: 서브셋은 Regular 1종이라 satori에 400/700 모두 같은 버퍼를 등록했다(굵기
  대비는 색·크기로 표현). 별도 Bold 서브셋 추가는 크기 예산상 이월.

---

## 3. 사이트맵/robots — 자동 (WT-M6-06)

- `apps/web/public/robots.txt`(신규): `Allow: /`, `Allow: /r/`, `Allow: /og/`, `Disallow: /api/`,
  `Disallow: /multi/` — docs/07 WT-M6-06 산출물 지시("/api/·/multi/* Disallow, /og/ Allow")를
  그대로 따랐다(docs/06 §10-3 원문 문구는 다소 모호해 이 태스크 블록 자체의 더 구체적인 지시를
  우선했다 — 프리앰블 권위 순서상 작업 블록이 참고 문서보다 위).
  - `Sitemap:` 지시어는 절대 URL을 요구하는데 도메인이 미확정(Q1)이라 **의도적으로 생략**했다 —
    §1에서 도메인이 확정되면 `Sitemap: https://<PUBLIC_ORIGIN>/sitemap.xml` 한 줄을 추가한다.
- `apps/web/public/sitemap.xml`(신규): 정적 라우트만(`/`, `/play`, `/daily`, `/rank`, `/multi`,
  `/passport`, `/privacy`, `/credits`) — `/r/:id`·`/og/:id`·`/multi/:code`·`/play/:mode(/:trackId)`
  등 동적 라우트는 미포함(docs/06 §10-3 "정적 라우트만"). `<loc>`은 도메인을 하드코딩하지 않기
  위해 RFC 2606 예약 TLD 플레이스홀더(`https://typetrip.example/...`, `wrangler.toml`의
  `staging.typetrip.example`과 동일 관례)를 쓴다 — **§1에서 도메인이 확정되면 배포 직전에 이
  오리진 문자열만 일괄 치환**한다(파일 상단 XML 주석에 명시).
- 검증: `curl http://localhost:8787/robots.txt`, `curl http://localhost:8787/sitemap.xml`
  (wrangler dev가 `apps/web/dist`를 ASSETS로 서빙 — 최종 보고에 curl 로그 포함).

---

## 4. 에러 페이지(404/500) · 장애 배너 — 자동 (WT-M6-06)

- `apps/web/src/pages/NotFoundPage/index.tsx`(+ test): 404 "항로 이탈" 콘셉트(🧭 + "항로를
  이탈했어요"/"You've gone off course"). `apps/web/src/app/router.tsx`의 catch-all(`path: '*'`)
  라우트가 렌더한다.
- `apps/web/src/pages/ErrorPage/index.tsx`(+ test): 범용 500 상당 에러 셸.
  `apps/web/src/app/RootErrorBoundary.tsx`가 `isRouteErrorResponse(error) && status===404`이면
  NotFoundPage로, 그 외에는 ErrorPage로 위임하도록 리팩터했다(`RootErrorBoundary.test.tsx` 그대로
  그린 — 리팩터가 기존 계약을 깨지 않음을 확인).
- 장애 배너(KV `config:banner`): `workers/api/src/routes/config.ts`가 GET `/api/v1/config` 응답에
  `banner: {message, level} | null` 필드를 병합(config:client와 독립된 KV 키, zod 검증 실패 시
  null 폴백) — `workers/api/test/config.test.ts`에 4개 신규 케이스(부재/정상/스키마 실패/JSON
  파싱 실패). 클라 `apps/web/src/app/bootLoader.ts`의 `ClientConfigSchema`에 `banner` 옵션 필드
  추가, `apps/web/src/app/AppShell.tsx`의 `BannerBar` 컴포넌트가 `data-testid="app-banner"`로
  렌더(level별 배색) — `AppShell.banner.test.tsx`(신규)가 bootLoader를 실제로 구동해 배너 렌더/
  미렌더 양쪽을 종단 검증.
- 인증: `pnpm --filter @wt/web test -- NotFoundPage ErrorPage AppShell.banner RootErrorBoundary`,
  `pnpm --filter @wt/api test -- config`.

---

## 5. 부하 테스트 — 자동(로컬 스모크) + 수동(staging 정식 실행, WT-M6-05 보존)

### 5.1 로컬에서 이미 완료됨

방법론·수치는 `tooling/ops/loadtest-report.md`에 있다(WT-M6-05). 요약: 로컬 스모크 기준
합격선 충족, 상세 그래프/히스토그램 포함.

### 5.2 staging 정식 실행 — 수동 (Cloudflare 계정 연결 후 리드 실행)

> docs/06 §10-#5(부하 테스트 항목)의 **staging 실행이 필요해 로컬에서 완료 처리할 수 없는** 절차.

관련 산출물: `tooling/ops/loadtest/{gen-fixtures.ts,submit.js,leaderboard.js,multi.md,room-sim.ts}`,
`workers/api/src/mw/ratelimit.ts`(`config:loadtest` 완화 플래그, WT-M6-05 신설),
`workers/api/src/lib/anticheat-config.ts`(`newPidAbuseMaxPerHour` 핫스왑, D53).

#### 1. 사전 준비 — 레이트리밋 완화 플래그 ON

staging은 로컬처럼 `signSessionToken`을 직접 서명해 세션 발급 상한을 우회할 수 없다(배포된
`SESSION_HMAC_SECRET` 값을 로컬에서 알 수 없다 — 알아서도 안 된다). 대신 KV 플래그로 그
엔드포인트의 레이트리밋만 잠깐 낮춘다.

```bash
# 원복을 위해 기존 값부터 저장(비어있으면 "없음"으로 기록해 두고, 종료 시 delete로 원복).
wrangler kv key get config:anticheat --binding KV --env staging --remote > /tmp/anticheat-before.json || true

# 완화: 세션 신규 pid 상한을 대량 상향(기존 JSON에 newPidAbuseMaxPerHour만 덮어써서 put).
wrangler kv key put config:loadtest "$(date +%s000)" --binding KV --env staging --remote --ttl 7200
wrangler kv key put config:anticheat "$(node -e "const b=require('fs').existsSync('/tmp/anticheat-before.json')?JSON.parse(require('fs').readFileSync('/tmp/anticheat-before.json','utf-8')):{minMsPerKeystroke:35,cpmHardCapKo:1100,cpmHardCapEn:1000,cpmSoftCapKo:950,cpmSoftCapEn:900,rhythmCvThreshold:0.12,rhythmSpreadMsThreshold:25,burstMaxThreshold:3,growthJumpFactor:0.6,growthMinSample:5,accComboCpmThreshold:800,timeEnvelopeGraceMs:3000,sumMsToleranceLowFactor:0.99,sumMsToleranceHighFactor:1.01,sumMsToleranceFlatMs:500,scoreMismatchTolerance:1,rejectedShadowbanThreshold:3,multi:{reactionFloorMs:250,maxKps:{ko:14,en:18}},newPidAbuseMaxPerHour:20};b.newPidAbuseMaxPerHour=1000000;console.log(JSON.stringify(b))")" --binding KV --env staging --remote
```

#### 2. 픽스처 발급 + 3종 실행

```bash
WT_BASE=https://<staging-origin> SESSION_HMAC_SECRET=(비워둠 — 미사용) \
  node --import tsx tooling/ops/loadtest/gen-fixtures.ts   # 실 POST /session·runs/start 경유라 시크릿 불필요

RPS=200 DURATION=5m WT_BASE=https://<staging-origin> k6 run tooling/ops/loadtest/submit.js
RPS=1000 DURATION=1m WT_BASE=https://<staging-origin> k6 run tooling/ops/loadtest/leaderboard.js
# 멀티는 tooling/ops/loadtest/multi.md 절차대로 room-sim.ts를 WT_BASE=staging으로 재실행.
```

합격선(docs/06 §10-#5·docs/00 §1.4): 제출 p95<250ms, LB p95<100ms(KV 히트)+히트율>95%, 멀티
tick p95<400ms. 결과는 `tooling/ops/loadtest-report.md`에 "staging 정식 실행" 절로 append.

#### 3. 원복 (필수 — 잊으면 프로덕션 안티치트 임계가 낮아진 채로 남는다)

```bash
wrangler kv key delete config:loadtest --binding KV --env staging --remote
# 1단계에서 저장해 둔 원래 config:anticheat을 그대로 되돌린다(비어 있었다면 delete).
wrangler kv key put config:anticheat "$(cat /tmp/anticheat-before.json)" --binding KV --env staging --remote
# 확인:
wrangler kv key get config:loadtest --binding KV --env staging --remote   # NotFound여야 정상
```

`config:loadtest`는 세이프가드로 2h TTL이 걸려 있어(만료 시각을 값으로 저장) 원복을 잊어도
자동 소멸하지만, **완화 상태로 방치하면 그동안 세션 IP 어뷰징 방어가 없다** — 반드시 위 delete를
직접 실행해 즉시 원복할 것.

#### 4. 종료 후 정리 — 테스트 데이터

> `tooling/ops/loadtest-report.md` §6이 참조하는 절차. §1~3(레이트리밋 완화 → 픽스처 발급 →
> k6 3종 실행)이 끝나면 staging D1에 실제 유저/제출/`lb_best` 행이 남는다. **`all`/시즌 보드는
> 영구 보존(docs/06 §1.4 "기간 롤오버" — 자동 삭제 대상 아님)이라 방치하면 실사용자 리더보드에
> 테스트 계정이 영구 혼입된다.** runs 원장 자체는 CLAUDE.md 마이그레이션 append-only 정신과
> 동일하게 삭제하지 않고 verdict만 강등한다.

##### 4.1 runs 일괄 practice 강등

부하 테스트 실행 창(gen-fixtures 시작 ~ k6 종료, epoch ms)과 사용한 `mode_key` 접두사로 좁혀
직접 SQL로 마킹한다. **`tooling/ops/scripts/rescore.ts`는 이 용도에 맞지 않는다** — 그 스크립트는
"anticheat 캡을 하향한 뒤 그 기준으로 실제 재검증"이 목적이라(파일 상단 주석 참조) verdict를
`verifyRun` 재계산 결과(valid/flagged/rejected)로만 바꾸고 `practice`로는 강등하지 않는다. 부하
테스트 데이터는 "재판정"이 아니라 "애초에 테스트였다"는 마킹이 목적이므로 직접 `UPDATE`가 맞다.

```bash
# 예시(§1 south-america 픽스처 — FROM_MS/TO_MS는 gen-fixtures.ts 실행 로그의 타임스탬프로 특정):
wrangler d1 execute wt-main-staging --env staging --remote --command \
  "UPDATE runs SET verdict='practice', verdict_reason='loadtest_wt_m6_05' \
   WHERE created_at >= <FROM_MS> AND created_at < <TO_MS> \
     AND mode_key LIKE 'continent:south-america%' AND verdict = 'valid'"
```

- `mode_key LIKE`로 gen-fixtures.ts/room-sim.ts가 실제 발급한 모드에만 좁힌다 — 시간 창만 걸고
  모드를 생략하면 같은 시간대의 실사용자 제출까지 practice로 오염된다(반드시 둘 다 지정).
- `AND verdict = 'valid'` 조건으로 이미 flagged/rejected였던 행은 건드리지 않는다(원 판정 보존).

##### 4.2 lb_best에서 제거 + dirty 마킹(재빌드)

`runs.verdict`를 바꿔도 이미 `lb_best`(materialized, docs/06 §1.2)에 올라간 행은 그대로 남는다 —
직접 지우고, 영향받은 `board_key`를 dirty 마킹해 1분 refresher가 top-100 캐시를 재계산하게 한다
(§11-D24).

```bash
# 1) 영향받은 board_key 목록 확보(삭제 전에 조회 — 다음 단계 dirty 마킹에 필요).
wrangler d1 execute wt-main-staging --env staging --remote --json --command \
  "SELECT DISTINCT board_key FROM lb_best WHERE run_id IN (
     SELECT run_id FROM runs WHERE verdict='practice' AND verdict_reason='loadtest_wt_m6_05')"

# 2) lb_best에서 해당 run 제거.
wrangler d1 execute wt-main-staging --env staging --remote --command \
  "DELETE FROM lb_best WHERE run_id IN (
     SELECT run_id FROM runs WHERE verdict='practice' AND verdict_reason='loadtest_wt_m6_05')"

# 3) 1)에서 얻은 board_key마다 dirty 마킹(TTL 180s — lb-refresher가 1분 내 소비 후 스스로 삭제).
wrangler kv key put "dirty:continent:south-america|en|desktop|all" 1 --binding KV --env staging --remote --ttl 180
wrangler kv key put "dirty:continent:south-america|en|desktop|d:<YYYY-MM-DD>" 1 --binding KV --env staging --remote --ttl 180
wrangler kv key put "dirty:continent:south-america|en|desktop|w:<YYYY-Www>" 1 --binding KV --env staging --remote --ttl 180
```

##### 4.3 최종 소거 — 보존 정리 크론이 담당

- `workers/api/src/cron/retention.ts`(KST 01:30 1일 1회)가 자동으로 `runs.detail_json`을
  생성 90일 경과 시 `'{}'`로 치환(docs/06 §6.2)하고, `lb_best`의 `d:`(90일)/`w:`(180일) 보드
  행을 만료 기준으로 삭제한다 — 4.1~4.2를 실행한 뒤 혹시 놓친 `d:`/`w:` 잔존분이 있어도 이
  크론이 결국 쓸어간다.
- **`all`/시즌 보드는 이 크론이 절대 건드리지 않는다(영구 보존 설계)** — 4.2의 수동 삭제가
  유일한 제거 경로다. 잊으면 테스트 계정이 all-time 리더보드에 영구 혼입된다.
- `runs` 테이블 행 자체(practice로 마킹된 원장)는 삭제하지 않는다 — 마이그레이션 append-only
  원칙과 같은 정신으로 원장은 보존하고 verdict만 바꾼다. `verdict_reason='loadtest_wt_m6_05'`로
  남겨 두면 이후 `WHERE verdict_reason = 'loadtest_wt_m6_05'`로 언제든 재식별·재확인할 수 있다.

---

## 6. 무결성 리허설 — 자동 (기존 마일스톤 산출물, WT-M3-07)

docs/06 §10-6 "치트 시나리오 6종(토큰 재사용/시간 압축/점수 위조/봇 리듬/붙여넣기/세트 불일치)
E2E 테스트가 CI에서 그린"은 이미 충족되어 있다 — 이 세션은 게임 로직/안티치트 변경 금지 범위라
새로 만들지 않고 존재를 재확인만 했다.

- 증빙: `e2e/specs/cheat-suite.spec.ts` — 베이스라인 1건 + 치트 ①~⑥(토큰 재사용/시간 압축/
  점수 위조/봇 리듬/붙여넣기/세트 불일치) + 섀도우밴 종단(⑦, 보너스) = 8개 테스트.
- 인증: `pnpm e2e`(전체 스위트에 포함되어 실행됨 — 개별 실행은 `pnpm --filter e2e exec
  playwright test cheat-suite`).

---

## 7. 프라이버시 — 혼합 (페이지/API 자동 완료, GA4·DPA 수동)

### 7.1 자동 완료 (기존 마일스톤 WT-M6-01)

- `/privacy` 게시(ko/en 병기, 11항 아웃라인): `apps/web/src/pages/PrivacyPage/`.
- 열람/삭제 셀프서비스: `GET /api/v1/users/me/export`, `DELETE /api/v1/users/me`
  (`workers/api/src/routes/me.ts`) + 설정 오버레이 UI(`AppShell.tsx`의 `SettingsOverlay`).
- WT-M6-06 추가: 이전까지 `/privacy`·`/credits` 라우트는 존재했지만 앱 내 어디서도 링크되지
  않았다(직접 URL 진입만 가능) — `SettingsOverlay`에 두 링크(`settings-link-privacy`,
  `settings-link-credits`)를 추가해 실제 도달 가능하게 했다(`AppShell.test.tsx` 기존 그린 유지
  확인).

### 7.2 수동 (담당: 사용자(리드))

- **GA4 활성 시점**(docs/00 §11 Q3): 기본값은 "런칭 시 OFF, 마케팅 캠페인 개시 시 ON"(AE만으로
  시작 가능 — 이미 AE 텔레메트리 배선 완료, WT-M6-03). 리드가 GA4 ON 결정 시: 동의 배너 UI 신설
  (v1 스코프 밖이라 아직 미구현) → GA4 속성 생성 → 태그 삽입 → 동의 배너 QA(거부 시 GA4 스크립트
  미로드 확인).
- **Cloudflare DPA 체결 확인**: Cloudflare 계정의 Enterprise/Business 약관 페이지에서 DPA
  (Data Processing Addendum) 서명 상태 확인 — 계정 연결 후 리드가 대시보드에서 직접 확인.

---

## 8. 크레딧/라이선스 — 자동 (WT-M6-06)

- `apps/web/src/pages/CreditsPage/index.tsx`(+ test): ODbL 1.0(world-countries) · "Made with
  Natural Earth"(world-atlas, ISC/public domain) · flag-icons(MIT) 고지 + 각 라이선스 전문
  링크(opendatacommons.org / naturalearthdata.com / github flag-icons LICENSE) + `notice.disputed`
  (분쟁 지역 표기 고지) 전부 포함. `router.tsx`에 `/credits` 라우트 추가.
- `PrivacyPage`의 기존 "전체 크레딧 페이지는 준비 중입니다" 문구를 `/credits`로의 실제 링크로
  교체(`privacy-credits-link` 테스트 추가).
- `SettingsOverlay`에서 `/credits`·`/privacy` 모두 링크(§7.1 참조) — 이전에는 두 페이지 다
  앱 내에서 도달 불가능했다(발견된 갭, 이번에 해소).
- 인증: `pnpm --filter @wt/web test -- CreditsPage PrivacyPage`.

---

## 9. 백업 — 혼합 (파이프라인 자동 완료, 복구 리허설 실행 수동)

### 9.1 자동 완료 (기존 마일스톤 WT-M6-04)

- 일일 논리 백업 파이프라인(`.github/workflows/backup.yml`, dry-run 구조 커밋됨 — 계정 미연결
  상태에서는 `vars.BACKUP_ENABLED` 부재로 항상 skip).
- 로컬 dry-run으로 D1 export+gzip 파이프라인 자체는 이미 실증됨(`tooling/ops/runbook.md` §6.1).

### 9.2 수동 (담당: 사용자(리드))

- **복구 리허설 1회 성공**(docs/06 §10-9): 절차는 이미 `tooling/ops/runbook.md` §6.3에 구체
  기재되어 있다(staging export → 임시 D1 주입 → 행 수 대조 → 결과를 이 문서에 날짜와 함께 기록
  → 임시 D1 삭제) — **아직 실행되지 않았다**(Cloudflare 계정 연결 필요). 리드가 최초 1회 실행
  후 아래에 결과를 append한다.
- R2 35일 보존 라이프사이클 규칙도 계정 연결 후 리드가 대시보드에서 1회 구성(`runbook.md` §6.1).

```
[복구 리허설 실행 기록 — 리드가 실행 후 추가]
날짜:
staging runs 행 수(원본):        임시 D1 복원 후:
staging users 행 수(원본):       임시 D1 복원 후:
결과: PASS / FAIL
비고:
```

---

## 10. 관측성 — 자동 (기존 마일스톤 산출물, WT-M6-04)

- Health Check + 알림 채널 발화 테스트(강제 실패 주입): `workers/api/test/health.test.ts`
  (`?fault=d1`, `?fault=kv` 강제 실패 → 503 + 개별 체크 상태), `workers/api/test/retention.test.ts`의
  `runAbuseSurgeCheck` 스위트(표본 임계·비율>5%→Slack webhook 호출·webhook 부재 시 skip 로그).
- 알림 경로 로컬 등가 절차: `tooling/ops/runbook.md` §7("알림 경로 강제 발화 테스트").
- SLO 대시보드: Cloudflare Analytics Engine 기반이라 실 대시보드 육안 확인은 계정 연결 후
  수동(쿼리는 `tooling/ops/queries/*.sql`에 이미 준비됨).
- 인증: `pnpm --filter @wt/api test -- health retention`.

---

## 11. 데이터 신선도 — 자동 (기존 마일스톤 산출물)

- `pnpm build:data` 산출물 CI diff 클린: `.github/workflows/ci.yml`의 "build:data freshness
  check" 스텝(`pnpm build:data && git diff --exit-code apps/web/public/data`), WT-M0-03.
- 데일리 시드 자정 롤오버 리허설(시계 mock): `workers/api/test/daily.test.ts`의 "different dates
  yield different (deterministic) seeds/sets" — `ensureDailySeed(env, now)`가 `now`를 명시적
  epoch 인자로 받는 설계라(내부에서 `Date.now()`를 직접 읽지 않음) 서로 다른 날짜 경계를 명시적
  타임스탬프로 넘겨 결정적으로 재현·검증한다(별도 시스템 시계 조작 불요).
- 인증: `pnpm --filter @wt/api test -- daily`.

---

## 12. 스토어 프리뷰(링크 미리보기 3종 스크린샷) — 수동 (담당: 사용자(리드))

§2.3의 "3. 링크 미리보기 검증기" 절차와 동일 작업이다(중복 방지를 위해 여기서는 요약만).

1. staging 배포 후 실제 기록 공유 URL(`/r/:shareId`) 1개 확보.
2. X Card Validator(<https://cards-dev.twitter.com/validator>) → 스크린샷 저장.
3. Kakao 공유 디버거(<https://developers.kakao.com/tool/debugger/sharing>) → 스크린샷 저장.
4. Threads(Meta Sharing Debugger) → 스크린샷 저장.
5. 3장을 이 저장소 밖 아카이브(사내 드라이브 등 — 저장소에 이미지 바이너리 커밋 금지 원칙과
   무관하게, 스크린샷은 리뷰 목적상 별도 채널 보관 권장)에 보관하고 이 문서에 링크만 남긴다.

```
[스크린샷 아카이브 링크 — 리드가 실행 후 추가]
X:
Kakao:
Threads:
날짜:
```

---

## 부록 — 12항 표 밖의 추가 수동 게이트 (WT-M6-06 세션 특이 조정 지시)

이 항목들은 docs/06 §10 12항 표에 직접 대응하는 번호가 없지만, 이번 태스크의 세션 특이 조정이
"담당을 사용자(리드)로 명시하고 실행 명령·절차를 구체 기재"하도록 지시했다.

- **실기기 IME QA 시트**: 이미 `tooling/ops/ime-qa-sheet.md`에 기기×브라우저 매트릭스와 절차가
  구체 기재되어 있다(WT-M2-08 산출물) — iOS Safari/Android Gboard·삼성키보드/Windows Chrome/
  macOS Safari 5종, 전부 "미실시(리드 수행 예정)" 상태. 이 세션은 게임 로직/입력 엔진 변경 금지
  범위라 그대로 재확인만 했다(수정 없음).
- **GA4 결정**: §7.2 참조.
- **staging 소프트 런치**(docs/00 §11 Q6, 기한 M6): 기본값 "staging 링크 폐쇄 배포 → 국내
  커뮤니티 1곳". 실행 절차(리드): ① staging 배포 완료(§2.3 절차 1) ② 비공개 링크를 선정
  커뮤니티 1곳에 공유(예: 관련 개발자 커뮤니티) ③ 1주 관측 후 `tooling/ops/loadtest-report.md`·
  KPI 대시보드로 실사용자 트래픽 하에서의 안정성 확인 ④ 이상 없으면 §1 도메인 확정 후 prod
  배포로 전환.
