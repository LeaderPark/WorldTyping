# 런칭 체크리스트 — OG 공유 인프라 (WT-M6-02)

> 이 문서는 docs/06 §10 런칭 체크리스트(권위 원천)의 **원격 실행이 필요해 로컬에서 완료 처리할 수
> 없는** 항목을 구체 절차로 기재한다. GitHub 원격·Cloudflare 계정이 연결되면 리드가 순서대로 실행한다.
> docs/06 §10과 충돌하면 docs/06이 이긴다 — 여기 있는 것은 실행 절차이지 스펙 변경이 아니다.

관련 구현: `workers/api/src/routes/share.ts`(`/r/:shareId`·`/og/:shareId.png`·`/multi/:code`),
`workers/api/src/og/{render.ts,layout.ts,og-maps.json,fonts/,fallback-og.*}`,
`workers/api/src/routes/runs.ts`(share_id 발급), `workers/api/src/mw/security-headers.ts`(/r/* 임베드 예외).

## 로컬에서 이미 검증됨(원격 불필요)

- 렌더 왕복(PNG 시그니처·크기), 캐시 헤더(`immutable`), 미존재 shareId 404 셸, 폴백 PNG(500 없음):
  `pnpm --filter @wt/api test`(`test/og.test.ts` 14 케이스 + `test/og-multi.test.ts` 2 케이스).
- **렌더 p95(로컬 workerd 정보용 수치)**: `test/og.test.ts`의 "렌더 성능" 케이스가 10회 렌더 p95를
  콘솔에 보고한다(측정치: **p95 ≈ 201ms** — 목표 <350ms 충족, 단 로컬 workerd 수치임. D48 정신에
  따라 밴드 assert는 없다). 원격 판정은 아래 §"staging p95 실측"으로 대체·확정한다.
- 결정성: `pnpm build:data` 재실행 시 `workers/api/src/og/og-maps.json` diff 0(CI `git diff --exit-code`).
- 폰트/폴백 산출물 재현: `pnpm build:og-fonts` 재실행 시 `pretendard-og-subset.{ttf,ts}`·`fallback-og.{png,ts}` diff 0.

## 원격 절차 (계정 연결 후 리드 실행)

### 1. staging 배포 (배포 순서 불변식: migrations → deploy)

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

### 2. staging p95 실측 (docs/06 §9.1 목표 <350ms — 규범 판정)

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

### 3. 링크 미리보기 검증기 (docs/06 §10-#2·#12 — 바이럴 첫인상 최종 승인)

staging 공개 URL이 있어야 외부 검증기가 크롤할 수 있다(로컬 wrangler dev는 외부 도달 불가라 이 단계는
**원격 전용**).

- **X(Twitter) Card Validator**: <https://cards-dev.twitter.com/validator> 에 `https://<origin>/r/<shareId>`
  입력 → `summary_large_image` 카드 + 1200×630 이미지 렌더 확인 → 스크린샷 아카이브.
- **Kakao 디버거**: <https://developers.kakao.com/tool/debugger/sharing> 에 같은 URL 입력 →
  제목/설명/이미지 확인. (og 캐시가 오래되면 "다시 스크랩" 실행.)
- **Threads/Facebook(선택)**: Meta Sharing Debugger로 og:image 확인.
- **방 초대 미리보기**: `https://<origin>/multi/<활성 roomCode>` → "타이핑 레이스 초대 — {lang} ·
  {n}/{max}명" 메타 + `/og/default.png` 이미지 확인. 만료된 방 코드 → "레이스가 끝났어요" 대체 메타 확인.
- 스크린샷 3종(X/Threads/카카오)을 아카이브(docs/06 §10-#12).

### 4. robots/sitemap OG 노출 (docs/06 §10-#3)

- `robots.txt`: `/og/`는 **Allow**(미리보기 크롤 허용), `/multi/*`는 Disallow, `/api/` 언급 없음.
  `/r/`는 Allow(공유 랜딩은 인덱싱 대상). — 이 파일은 SPA 정적 자산(apps/web/public) 소관(별도 태스크).
- `sitemap.xml`: 정적 라우트만(`/`·`/daily`·`/rank`). `/r/:id`·`/og/:id`·`/multi/*`는 미포함.

### 5. CSP/임베드 회귀 확인 (docs/06 §9.4)

- `curl -sI https://<origin>/r/<shareId>` → `content-security-policy`에 `frame-ancestors` **없음**
  (블로그 iframe 임베드 허용), `x-frame-options` 헤더 **없음**.
- `curl -sI https://<origin>/` (게임 라우트) → CSP에 `frame-ancestors 'self'` 유지(클릭재킹 방지).

### 6. CF 캐시·CPU 예산 (docs/06 §9.1 "share_id당 1회 렌더")

- 동일 shareId 2회 요청 → 2회차 `cf-cache-status: HIT`(엣지 캐시) 또는 Worker `caches.default` 히트로
  재렌더 없음. `wrangler tail --env staging`로 렌더 로그가 share_id당 1회만 찍히는지 육안 확인.

## 미해결/이월

- **폰트 서브셋 크기**: D46 추정 ~180KB 대비 실제 KS 완성형(2350자) Pretendard Regular 서브셋은
  **~425KB TTF**로 산출됨(한글 아웃라인이 추정보다 무겁다). 기능(닉네임 커버리지) 우선으로 D46의
  "KS 완성형" 요건을 그대로 지켰다 — 크기 추정치만 실측과 어긋난다(escalation, 리드 확인 요청).
- **satori 700 weight**: 서브셋은 Regular 1종이라 satori에 400/700 모두 같은 버퍼를 등록했다(굵기
  대비는 색·크기로 표현). 별도 Bold 서브셋 추가는 크기 예산상 이월.
