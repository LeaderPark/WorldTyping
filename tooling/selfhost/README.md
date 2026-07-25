# Self-hosted deployment (WT-HOST-01)

Cloudflare Workers를 Docker로 자기호스팅하기 위한 스택. **앱 코드는 수정하지 않는다** —
`wrangler dev`(miniflare)가 top-level `workers/api/wrangler.toml`을 그대로 소비해 D1 / KV / DO /
Queues / AE / R2 / WS를 전부 로컬 시뮬레이션한다(`[env.*]`는 무시됨 — 그건 실제 Cloudflare
배포 전용). 데이터는 새로 시작이며, 기존 배포에서 이행하지 않는다.

터널(cloudflared) 실 배선은 **WT-HOST-02**(cloudflared 인증 후)에서 진행한다. 이 문서는
`app`/`cron-ping`/`backup`/`autoheal` 스택 기동까지를 다룬다.

## 원클릭 배포 (deploy.cmd — WT-DEPLOY-TOOL)

**최초 1회 기동(아래 "기동" 절)이 끝난 뒤부터는, 배포 전용 PC(git + Docker Desktop만 설치)에서
재배포할 때 이 절이 표준 경로다.** `tooling/selfhost/deploy.cmd`를 더블클릭하면 지금까지의 수동
절차(`git pull` → `docker compose --profile tunnel up -d --build` → 헬스체크)를 자동으로 수행한다.

### 사용법

```
tooling\selfhost\deploy.cmd
```

더블클릭하거나 커맨드라인에서 실행한다. 끝나면 아무 키나 누르면 창이 닫힌다(결과를 읽을 시간을
주기 위한 `pause`). 본체는 `tooling/selfhost/deploy.ps1`(PowerShell 5.1 호환 — pwsh 미설치 PC에서도
동작)이며, 아래 8단계를 순서대로 실행하고 실패 시 그 단계에서 명확한 에러와 함께 중단한다:

1. 프리플라이트(git 저장소·`.env` 존재·Docker 데몬 응답 확인)
2. Git 동기화(`fetch` → 워킹트리 더티 체크 → `checkout`/`merge --ff-only`)
3. 롤백 대비(현재 app 이미지를 `worldtyping-rollback:latest`로 보존)
4. `docker compose --profile tunnel build`
5. `docker compose --profile tunnel up -d`
6. 헬스체크 대기(최대 180초 폴링, healthcheck `start_period` 40초 감안)
7. 스모크 테스트(로컬 `127.0.0.1:8790`은 필수, 터널 경유 `worldtyping.leaderpark.net`은 실패해도 경고만 — 로컬이 성공하면 배포 자체는 성공 판정)
8. 요약 출력(배포된 커밋·소요 시간·헬스 결과·롤백 명령 안내)

전 단계 로그가 `tooling/selfhost/deploy-logs/deploy-YYYYMMDD-HHmmss.log`에 남는다.

### 옵션 (커맨드라인 인자로 전달, 예: `deploy.cmd -DryRun`)

- `-DryRun` — 실제 git/docker 명령을 하나도 실행하지 않고 8단계를 미리보기만 한다(Docker Desktop이
  꺼져 있거나 미설치여도 끝까지 완주한다). 사전 점검용.
- `-SkipPull` — `git fetch`/`checkout`/`pull`을 건너뛰고 현재 로컬 워킹트리 상태 그대로 빌드/배포한다.
- `-Force` — 워킹트리에 커밋되지 않은 변경이 있어도 중단하지 않고 `git stash push -u`로 치운 뒤
  진행한다(stash는 자동으로 pop하지 않는다 — 실행 종료 시 요약에 안내가 남는다).
- `-Ref <branch|sha>` — 배포할 브랜치명 또는 커밋 SHA(기본값 `main` = `origin/main`을 ff-only로 반영).
  7~40자 16진수 문자열이면 커밋 SHA로 판단해 해당 커밋으로 detached checkout한다.

### 롤백

1. **소스로 롤백 후 재배포**: 배포 요약에 출력된 이전 커밋으로 `git checkout <이전 커밋>` 한 뒤
   `deploy.cmd -SkipPull`로 그 커밋 그대로 재빌드/재기동한다.
2. **재빌드 없이 즉시 복구**: 직전 실행의 3단계가 보존해 둔 `worldtyping-rollback:latest` 이미지를
   실제 app 이미지명(`docker compose config --images app`으로 확인, compose 기본 네이밍은
   `worldtyping-app`)으로 재태그한 뒤 `docker compose --profile tunnel up -d --no-build`로 기동한다.

### 주의

- **`.env`가 반드시 있어야 한다**(아래 "기동" 절 참고) — 없으면 프리플라이트 단계에서 즉시 중단된다.
- **Docker Desktop이 실행 중이어야 한다** — 꺼져 있으면 `docker info` 확인에서 중단된다(부팅 시
  자동 시작 설정 권장, §8.6 운영 주의 참고).
- 워킹트리가 더티(커밋 안 된 로컬 변경)하면 기본적으로 중단한다 — 배포 PC는 보통 항상 클린해야
  정상이므로, 더티하다는 신호는 그 자체로 점검이 필요하다는 뜻이다.

## 기동

```bash
cd tooling/selfhost
cp .env.example .env
# .env를 열어 SESSION_HMAC_SECRET / RUN_HMAC_SECRET / DAILY_SALT에 실제 랜덤 값을 채운다.
# 생성 예: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# (각 시크릿마다 별도로 실행해 서로 다른 값을 넣을 것. dev-secret-* 더미값을 넣으면
#  entrypoint.sh가 기동을 거부한다 — 실배포이므로 의도된 안전장치다.)

docker compose build
docker compose up -d app cron-ping backup    # cloudflared는 제외(WT-HOST-02)
```

첫 기동 시 `app`이 D1 마이그레이션(`workers/api/migrations/*.sql`)을 `wt-main-dev`에 적용한
뒤 `wrangler dev`를 기동한다(순서 불변식: migrations apply → serve). 상태는 named volume
`wt-data`(컨테이너 내부 `/data`)에 영속화되므로 `docker compose restart app`으로 재시작해도
데이터가 유지된다.

`docker compose logs -f app`으로 부팅 로그(시크릿 검증 → `.dev.vars` 생성 → 마이그레이션 →
`wrangler dev` 기동)를 확인할 수 있다.

## 스모크 체크

```bash
curl -s http://127.0.0.1:8787/api/v1/health
curl -s http://127.0.0.1:8787/ | head -c 200                 # SPA index.html
curl -s http://127.0.0.1:8787/api/v1/config
curl -s -X POST http://127.0.0.1:8787/api/v1/session \
  -H "content-type: application/json" -d '{"deviceId":"<유효 UUIDv4>"}'
curl -s http://127.0.0.1:8787/api/v1/daily/today

# 크론 수동 발화(workers/api/wrangler.toml [triggers].crons와 tooling/selfhost/cron-ping/crontab
# 이 정의하는 4개 문자열 중 하나) — app 로그에 해당 잡 실행 흔적이 남는지 확인.
# 엔드포인트는 /__scheduled가 아니라 /cdn-cgi/handler/scheduled다(아래 cron-ping 섹션 참고 —
# /__scheduled는 assets 라우팅에 가로채져 무동작임을 실측으로 확인했다).
curl -s "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*%2F1+*+*+*+*"

# 영속성 증명: 재시작 후에도 데일리 시드가 동일해야 한다(같은 UTC 날짜 기준).
docker compose restart app && sleep 8 && curl -s http://127.0.0.1:8787/api/v1/daily/today

# 백업 수동 1회 실행
docker compose exec backup /backup.sh
ls backups/
```

WS 스모크(퀵매치/방 라이프사이클 전체를 검증하는 건 아니고 `hello`→`welcome` 왕복만 확인):

1. `POST /api/v1/rooms` (Bearer 세션 토큰) → `{roomCode, wsUrl, ticket}` 티켓 발급.
2. `ws://127.0.0.1:8787/ws/room/<code>?ticket=<ticket>`에 접속.
3. 접속 직후 `{v:1, type:'hello', seq:0, auth:{kind:'session', token}, dataVersion}` 전송
   (`dataVersion`은 `GET /api/v1/config` 응답의 `dataUrl` 쿼리스트링 `?v=` 값).
4. `welcome` 메시지 수신 확인.

더미 시크릿 거부 확인: `.env`의 세 시크릿을 `dev-secret-*` 값으로 두고 `docker compose up`하면
`app` 컨테이너가 즉시 exit 1로 종료해야 한다(`docker compose logs app`에 명확한 에러 메시지).

## 정리

```bash
docker compose down          # 볼륨(wt-data)은 유지 — 데이터 보존
docker compose down -v       # 완전 초기화가 필요할 때만(모든 로컬 D1/KV/DO 상태 삭제)
```

## 백업 / 복원

- **자동**: `backup` 서비스가 매일 17:30 UTC(KST 02:30) `/data`를 `tooling/selfhost/backups/wt-data-YYYYMMDD.tar.gz`로 스냅샷하고 14일(`BACKUP_RETAIN_DAYS`) 초과분을 정리한다(`backup/backup.sh` 참고). `*.sqlite` 본체는 `sqlite3 -readonly ... .backup`으로 WAL 정합 스냅샷을 뜬다.
- **수동 1회**: `docker compose exec backup /backup.sh`
- **[알려진 이슈 — Windows Docker Desktop named volume]** 실측 결과, `wrangler dev`가 그 순간 활발히 쓰고 있는 sqlite 파일(D1 본체, 방금 만들어진 DO 스토리지, 최근 쓴 KV blob 등)에 대해 `sqlite3 -readonly ... .backup`이 간헐적으로 `unable to open database file`(SQLITE_CANTOPEN)로 실패할 수 있다 — 파일 자체는 손상되지 않았고(다른 경로로 복사해 열면 정상) Docker Desktop for Windows의 named volume 백엔드 파일 잠금 프리미티브 이슈로 추정된다(Linux 호스트에서는 미재현 가능성 있음 — 확인 필요). `backup.sh`는 이 경우 raw `cp`로 폴백해 최소한 파일을 아카이브에 남기고, 폴백이 한 건이라도 있었으면 스크립트가 exit 2로 종료해 로그에서 눈에 띄게 한다(`docker compose logs backup` 확인). 폴백된 파일도 복원 시 정상 오픈됨을 확인했다(스냅샷 시점에 트랜잭션이 겹치면 이론상 일관성이 100% 보장되지 않으므로, 폴백이 잦다면 백업 직전 몇 초간 해당 서비스를 멈추는 등의 추가 조치를 리드와 상의할 것).
- **복원 절차**:
  1. `docker compose down app` (app만 중지 — 데이터 볼륨은 그대로 둔다)
  2. 복원할 아카이브를 골라 named volume에 풀어 넣는다:
     ```bash
     docker run --rm -v wt-data:/data -v "$(pwd)/backups:/backups:ro" alpine \
       sh -c "rm -rf /data/* && tar -xzf /backups/wt-data-<YYYYMMDD>.tar.gz -C /data"
     ```
  3. `docker compose up -d app` — 컨테이너가 다시 마이그레이션을 적용(이미 적용된 마이그레이션은
     no-op)한 뒤 복원된 데이터로 `wrangler dev`를 기동한다.
  4. `curl http://127.0.0.1:8787/api/v1/daily/today` 등으로 복원된 데이터가 보이는지 확인.

## cron-ping (Cloudflare Cron Triggers 대체)

`cron-ping` 서비스가 `workers/api/wrangler.toml`의 `[triggers].crons` 4개 문자열과 같은 주기로
`/cdn-cgi/handler/scheduled?cron=<url-encoded>`를 curl로 호출한다(`cron-ping/crontab` 참고).
**`wrangler.toml`의 crons 배열이 바뀌면 `cron-ping/crontab`도 반드시 함께 수정한다** — 둘이
어긋나면 자기호스팅 인스턴스에서 데일리 시드/리더보드 갱신/부정 급증 체크/보존 정리 잡이 조용히
실행되지 않는다(`wrangler dev`가 자체적으로 크론을 발화하지 않으므로 이 서비스가 유일한 트리거
경로다).

**[리드 승인 완료 — 엔드포인트 확정]** WT-HOST-01 acceptance 실측 결과 문서상 경로인
`/__scheduled?cron=...`는 `event.cron` 디스패치를 태우지 못했다 — `run_worker_first`
(`workers/api/wrangler.toml` `[assets]`)에 `/__scheduled`가 없어서 wrangler의 asset 우선순위
판단이 Worker보다 먼저 개입해 `not_found_handling: single-page-application` 폴백으로 SPA
`index.html`을 돌려줄 뿐이었다(`wrangler:info` 로그: `` GET /__scheduled 200 OK ...
`Sec-Fetch-Mode: navigate` header present - using `not_found_handling` behavior ``, D1/KV
부작용 없음). `/cdn-cgi/handler/scheduled?cron=...`(wrangler dev의 실제 스케줄 트리거
엔드포인트, assets 라우팅보다 아래 계층에서 처리되어 그 우선순위 문제를 겪지 않는다)는 실제로
`scheduled()`를 실행함을 D1 `kpi_daily` INSERT 등 부작용으로 직접 증명했다 — 리드 승인 후
`cron-ping/crontab`을 이 경로로 교체했고, `wrangler.toml`/앱 코드는 변경하지 않았다(self-host
툴링만 수정 — 승인 범위). 4개 크론 전부 이 경로로 수동 발화해 재검증 완료(daily-seed → KV
`daily:*` 생성, lb-refresher → 무오류 완주, retention → `kpi_daily` INSERT).

## 알려진 제약 / 다음 단계

- `cloudflared` 서비스는 `profiles: ["tunnel"]`로 기본 비활성 — `tooling/selfhost/cloudflared/config.yml`(실 UUID·credentials-file)이 준비되면 WT-HOST-02에서 `docker compose --profile tunnel up -d cloudflared`로 활성화한다.
- `autoheal`이 `/var/run/docker.sock`을 마운트한다(호스트 Docker 데몬 전체 제어권과 동등한 권한) — `app` 컨테이너의 헬스체크가 unhealthy로 넘어가면 자동 재시작하기 위한 트레이드오프다.
- 이 스택은 Cloudflare Workers Free 플랜 제약(Queues/AE/R2 prod 미바인딩)과 무관하다 — top-level(dev) wrangler.toml을 그대로 쓰므로 이 3개 바인딩이 전부 시뮬레이션된다.
