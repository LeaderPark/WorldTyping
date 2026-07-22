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

---

# 부하 테스트 — staging 정식 실행 (WT-M6-05)

> docs/06 §10-#5(부하 테스트 항목)의 **staging 실행이 필요해 로컬에서 완료 처리할 수 없는** 절차.
> 로컬 스모크 결과·방법론·수치는 `tooling/ops/loadtest-report.md`에 있다 — 여기는 "Cloudflare
> 계정 연결 후 리드가 그대로 실행할 명령"만 남긴다.

관련 산출물: `tooling/ops/loadtest/{gen-fixtures.ts,submit.js,leaderboard.js,multi.md,room-sim.ts}`,
`workers/api/src/mw/ratelimit.ts`(`config:loadtest` 완화 플래그, WT-M6-05 신설),
`workers/api/src/lib/anticheat-config.ts`(`newPidAbuseMaxPerHour` 핫스왑, D53).

## 1. 사전 준비 — 레이트리밋 완화 플래그 ON

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

## 2. 픽스처 발급 + 3종 실행

```bash
WT_BASE=https://<staging-origin> SESSION_HMAC_SECRET=(비워둠 — 미사용) \
  node --import tsx tooling/ops/loadtest/gen-fixtures.ts   # 실 POST /session·runs/start 경유라 시크릿 불필요

RPS=200 DURATION=5m WT_BASE=https://<staging-origin> k6 run tooling/ops/loadtest/submit.js
RPS=1000 DURATION=1m WT_BASE=https://<staging-origin> k6 run tooling/ops/loadtest/leaderboard.js
# 멀티는 tooling/ops/loadtest/multi.md 절차대로 room-sim.ts를 WT_BASE=staging으로 재실행.
```

합격선(docs/06 §10-#5·docs/00 §1.4): 제출 p95<250ms, LB p95<100ms(KV 히트)+히트율>95%, 멀티
tick p95<400ms. 결과는 `tooling/ops/loadtest-report.md`에 "staging 정식 실행" 절로 append.

## 3. 원복 (필수 — 잊으면 프로덕션 안티치트 임계가 낮아진 채로 남는다)

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

## 4. 종료 후 정리 — 테스트 데이터(WT-M6-05 수정)

> `tooling/ops/loadtest-report.md` §6이 참조하는 절차. §1~3(레이트리밋 완화 → 픽스처 발급 →
> k6 3종 실행)이 끝나면 staging D1에 실제 유저/제출/`lb_best` 행이 남는다. **`all`/시즌 보드는
> 영구 보존(docs/06 §1.4 "기간 롤오버" — 자동 삭제 대상 아님)이라 방치하면 실사용자 리더보드에
> 테스트 계정이 영구 혼입된다.** runs 원장 자체는 CLAUDE.md 마이그레이션 append-only 정신과
> 동일하게 삭제하지 않고 verdict만 강등한다.

### 4.1 runs 일괄 practice 강등

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

### 4.2 lb_best에서 제거 + dirty 마킹(재빌드)

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

### 4.3 최종 소거 — 보존 정리 크론이 담당

- `workers/api/src/cron/retention.ts`(KST 01:30 1일 1회)가 자동으로 `runs.detail_json`을
  생성 90일 경과 시 `'{}'`로 치환(docs/06 §6.2)하고, `lb_best`의 `d:`(90일)/`w:`(180일) 보드
  행을 만료 기준으로 삭제한다 — 4.1~4.2를 실행한 뒤 혹시 놓친 `d:`/`w:` 잔존분이 있어도 이
  크론이 결국 쓸어간다.
- **`all`/시즌 보드는 이 크론이 절대 건드리지 않는다(영구 보존 설계)** — 4.2의 수동 삭제가
  유일한 제거 경로다. 잊으면 테스트 계정이 all-time 리더보드에 영구 혼입된다.
- `runs` 테이블 행 자체(practice로 마킹된 원장)는 삭제하지 않는다 — 마이그레이션 append-only
  원칙과 같은 정신으로 원장은 보존하고 verdict만 바꾼다. `verdict_reason='loadtest_wt_m6_05'`로
  남겨 두면 이후 `WHERE verdict_reason = 'loadtest_wt_m6_05'`로 언제든 재식별·재확인할 수 있다.
