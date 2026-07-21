<!-- spec: docs/04 §8.1 + docs/00 §7.1/§7.3 + docs/07 WT-M0-03 -->

# CI/CD 워크플로

이 디렉터리는 3개의 워크플로로 구성된다.

| 파일 | 트리거 | 역할 |
|---|---|---|
| `ci.yml` | `pull_request`, `push`(main) | install → build:data 신선도 검사 → typecheck → lint → test → build |
| `deploy.yml` | `workflow_run`(`ci.yml` 성공 후), `release`(published) | preview 버전 업로드(PR) / staging 자동 배포(main) / prod 수동 게이트 배포(release) |
| `backup.yml` | `schedule`(KST 04:00), `workflow_dispatch` | D1 논리 백업 → R2 업로드 (docs/06 §8.5) |

배포 순서 불변식(docs/00 §7.1): **D1 migrations apply → wrangler deploy**. `deploy.yml`의
`deploy-staging`/`deploy-prod` 잡은 이 두 스텝을 순서대로 실행하며, migrations 스텝이
실패하면 GitHub Actions 기본 동작(스텝 실패 시 잡 중단)에 의해 deploy 스텝은 실행되지 않는다.

`deploy.yml`이 `ci.yml`을 직접 재실행하지 않고 `workflow_run`으로 결과만 참조하는 이유는
같은 커밋에 대해 CI 스텝을 두 번 태우지 않기 위해서다. 원격 GitHub App 권한 제약상
`workflow_run.pull_requests`는 **fork에서 온 PR에는 비어 있을 수 있다** — 이 저장소가
외부 fork PR을 받는 시점이 오면 preview 코멘트 스텝에 fallback(예: `actions/github-script`로
`repos.listPullRequestsAssociatedWithCommit` 조회)을 추가해야 한다.

## 활성화 절차 (GitHub 원격 + Cloudflare 계정 연결 후, 1회)

이 리포는 현재 GitHub 원격/Cloudflare 계정이 연결되어 있지 않다. 연결 후 아래 순서로 활성화한다.

1. **Cloudflare 리소스 발급** (`workers/api/wrangler.toml`의 플레이스홀더를 실제 ID로 교체):
   ```bash
   cd workers/api
   wrangler d1 create wt-main-dev      # 및 staging/prod
   wrangler kv namespace create wt-kv-dev
   wrangler r2 bucket create wt-dev    # 및 staging/prod (D1 백업 겸용, docs/00 §7.2)
   wrangler queues create wt-events-dev
   ```
2. **GitHub Secrets 등록** (Settings → Secrets and variables → Actions → Secrets):

   | 이름 | 용도 | 최소 권한 스코프 |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | wrangler 배포/마이그레이션/R2 업로드 | Account → Workers Scripts:Edit, D1:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, Workers Routes:Edit (커스텀 토큰으로 이 5개만 부여 — Global API Key 금지) |
   | `CLOUDFLARE_ACCOUNT_ID` | 계정 식별 | — (시크릿 아님, Variables로 등록해도 무방하나 편의상 Secrets에 둠) |

3. **GitHub Variables 등록** (Settings → Secrets and variables → Actions → Variables):

   | 이름 | 용도 | 초기값 |
   |---|---|---|
   | `BACKUP_ENABLED` | `backup.yml` 활성화 스위치 | Cloudflare 계정 연결 전까지 `false`(또는 미설정) |

4. **GitHub Environments 생성** (Settings → Environments):
   - `staging` — `deploy-staging` 잡이 참조. 보호 규칙 없이 자동 배포.
   - `production` — `deploy-prod` 잡이 참조. **필수 승인자(Required reviewers)를 최소 1인
     등록**해 수동 게이트를 강제한다(docs/00 §7.1 "GitHub Release 발행(수동 승인 게이트)").

5. **브랜치 보호 규칙** (Settings → Branches → `main`): `CI / ci` 잡을 필수 상태 검사로 지정.

6. 위 시크릿·변수·환경이 모두 준비되면 워크플로는 별도 코드 변경 없이 그대로 동작한다.

## 로컬 등가 검증 (Cloudflare 미연결 상태에서 이 리포에 적용한 방법)

원격 계정이 없어 실제 preview/staging 배포는 확인할 수 없다. 대신:

- `.github/workflows/*.yml`을 actionlint(npm `actionlint` wasm 패키지)로 정적 검증.
- YAML 파싱 후 잡 의존성/트리거/스텝 순서(migrations → deploy)를 스크립트로 구조 검증.
- `wrangler dev` 로컬 서버 + curl로 Worker 라우팅(WT-M0-02 acceptance)을 별도 검증.

두 검증 모두 리드가 실행한 로그는 해당 작업(WT-M0-03) PR 설명에 첨부한다.
