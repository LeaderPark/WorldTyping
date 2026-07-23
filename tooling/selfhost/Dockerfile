# spec: WT-HOST-01 (Fable 5 승인, 리드 승인 완료) — Cloudflare Workers 자기호스팅 이전.
# 앱 코드는 수정하지 않는다. 이 이미지는 top-level workers/api/wrangler.toml을 그대로 소비하는
# `wrangler dev`(miniflare)로 D1/KV/DO/Queues/AE/R2/WS를 로컬 시뮬레이션한다([env.*]는 무시됨 —
# 그건 `wrangler deploy --env staging|prod`, 즉 실제 Cloudflare 배포 전용 설정이다).
#
# build context = 레포 루트 (docker-compose.yml의 build.context 참조).
#   docker build -f tooling/selfhost/Dockerfile .
#
# [베이스 이미지 선택] node:24-bookworm-slim (glibc/Debian) — Alpine(musl) 금지.
# wrangler는 workerd(Cloudflare Workers 런타임, Rust+V8)를 postinstall로 내려받아 실행하는데,
# 배포되는 workerd 바이너리는 glibc 빌드만 제공된다(musl 미지원) — Alpine 위에서
# `wrangler dev`를 돌리면 workerd가 기동 실패한다. bookworm-slim은 glibc이면서 apt 이미지
# 대비 가볍다.
FROM node:24-bookworm-slim

# docker-compose.yml의 `app` healthcheck가 컨테이너 내부에서 curl로 /api/v1/health를 찌른다 —
# bookworm-slim에는 curl이 기본 포함되지 않으므로 여기서 설치한다. ca-certificates는 wrangler가
# (원격 API를 부르지 않는 --local 모드에서도) 내부적으로 TLS 스택을 여는 경우를 대비한 안전망.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm-lock.yaml이 packageManager(pnpm@10.21.0)를 명시 — corepack이 그 버전을 그대로 받아쓴다.
RUN corepack enable

# CI=true: 일부 postinstall/스크립트가 CI 감지 시 대화형 프롬프트·자동 브라우저 오픈 등을
# 건너뛴다. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: 이 이미지는 e2e(Playwright)를 실행하지 않으므로
# 브라우저 바이너리 다운로드(수백MB, 네트워크 의존)를 건너뛴다. WRANGLER_SEND_METRICS=false:
# wrangler 사용 텔레메트리 전송 비활성(자기호스팅 인스턴스가 외부로 사용 통계를 보내지 않게).
ENV CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    WRANGLER_SEND_METRICS=false

WORKDIR /app

# ---------------------------------------------------------------------------
# Layer 1 — 워크스페이스 매니페스트만 먼저 복사해 `pnpm install` 레이어를 캐싱한다.
# 이후 소스만 바뀌는 반복 빌드에서는 이 레이어가 캐시 히트되어 install을 재실행하지 않는다.
# pnpm-workspace.yaml의 실제 패키지 전부를 나열한다(apps/web, workers/api, packages/*, e2e).
# ---------------------------------------------------------------------------
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY workers/api/package.json workers/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/data/package.json packages/data/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/moderation/package.json packages/moderation/package.json
COPY e2e/package.json e2e/package.json

# 전체(pnpm install --frozen-lockfile) 설치는 @wt/e2e(Playwright 등 무거운 devDependency 포함)
# 까지 끌어와 이 이미지에 불필요하게 무겁다. 먼저 @wt/api·@wt/web과 그 워크스페이스 의존성만
# (--filter "pkg..." 의 "..."는 "해당 패키지 + 의존하는 워크스페이스 패키지 전부") 설치를
# 시도해 레이어를 가볍게 한다. pnpm의 partial install(--filter + install) 조합이 이 레포
# 구성(lockfile/워크스페이스 그래프)과 어긋나는 등의 이유로 실패하면, 빌드를 막지 않고 전체
# 설치로 안전하게 폴백한다(사유를 stderr에 남긴다) — 두 경로 모두 --frozen-lockfile이라
# 커밋된 lockfile과 다른 의존성이 몰래 설치될 위험은 없다.
RUN pnpm install --frozen-lockfile --filter "@wt/api..." --filter "@wt/web..." \
    || { echo "[selfhost][Dockerfile] filtered pnpm install failed - falling back to full workspace install" >&2; \
         pnpm install --frozen-lockfile; }

# ---------------------------------------------------------------------------
# Layer 2 — 전체 소스 복사 + 빌드
# ---------------------------------------------------------------------------
COPY . .
RUN chmod +x tooling/selfhost/entrypoint.sh

# build:data(국가 데이터 재생성)는 여기서 실행하지 않는다 — packages/data/src/generated/*와
# apps/web/public/data/*는 이 레포에서 커밋된 산출물이라(CLAUDE.md "국가 데이터 추가/갱신") 이미
# 최신 상태다. `pnpm build`는 apps/web/dist(Vite 프로덕션 빌드, wrangler assets가 서빙)와 나머지
# 워크스페이스의 tsc 빌드/타입체크만 수행한다.
RUN pnpm build

ENV NODE_ENV=production
WORKDIR /app/workers/api
EXPOSE 8787

ENTRYPOINT ["/app/tooling/selfhost/entrypoint.sh"]
