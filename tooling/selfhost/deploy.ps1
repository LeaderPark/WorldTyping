# spec: WT-DEPLOY-TOOL — 배포 전용 PC(git + Docker Desktop만 설치)에서 더블클릭(deploy.cmd) 한 번으로
# https://worldtyping.leaderpark.net 을 최신 main으로 재배포하는 원클릭 배포 스크립트.
#
# 현재 수동 절차(docs/08 §8.6·§8.7)를 그대로 자동화한다:
#   git pull -> docker compose --profile tunnel up -d --build -> 헬스체크
# entrypoint.sh가 컨테이너 기동 시 D1 마이그레이션(wrangler d1 migrations apply --local, 디렉터리
# 전체 적용 — 특정 파일 하드코딩 아님, entrypoint.sh 참고)을 이미 처리하므로 이 스크립트는 그
# 이후 절차(git 동기화 -> 이미지 빌드 -> 컨테이너 기동 -> 헬스체크 -> 스모크)만 오케스트레이션한다.
#
# PowerShell 5.1 호환 필수(배포 PC에 pwsh 미설치 가능) — 삼항(?:)/널병합(??) 등 PS7 전용 문법 금지.
#
# 사용법: tooling/selfhost/deploy.cmd 더블클릭, 또는 직접:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tooling\selfhost\deploy.ps1 [-DryRun] [-SkipPull] [-Force] [-Ref <branch|sha>]
#
# 파라미터:
#   -DryRun    실제 git/docker 명령을 실행하지 않고 각 단계에서 수행할 동작만 출력한다(Docker Desktop
#              미기동/미설치 상태에서도 끝까지 완주한다 — docker 실행 파일을 아예 호출하지 않는다).
#   -SkipPull  git fetch/checkout/pull을 건너뛰고 현재 로컬 워킹트리 상태 그대로 빌드/배포한다.
#   -Force     워킹트리가 더티(커밋되지 않은 변경 있음)해도 중단하지 않고 `git stash push -u`로
#              치운 뒤 진행한다(stash는 자동으로 pop하지 않는다 — 배포 요약에 안내가 남는다).
#   -Ref       배포할 브랜치명 또는 커밋 SHA. 기본값 "main"(= origin/main을 ff-only로 반영).
#              7~40자 16진수 문자열이면 커밋 SHA로 간주해 해당 커밋으로 detached checkout한다.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipPull,
    [switch]$Force,
    [string]$Ref = "main"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# 출력 헬퍼 (색상 + 한국어 메시지). Start-Transcript가 Write-Host 출력을 그대로 로그 파일에도
# 기록하므로(PS5+ 지원) 별도의 이중 기록 로직 없이 이 함수들만 쓰면 콘솔+로그 양쪽에 남는다.
# ---------------------------------------------------------------------------
function Write-StepHeader {
    param([int]$Index, [int]$Total, [string]$Title)
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}" -f $Index, $Total, $Title) -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

function Stop-DeployWithError {
    param([string]$Message)
    Write-Fail "오류: $Message"
    Write-Fail "배포를 중단합니다. 상세 로그: $LogFile"
    Write-Fail "롤백 참고: 이전 커밋 $OldHash / 필요 시 'git checkout $OldHash' 후 재실행하거나, 보존된 롤백 이미지(worldtyping-rollback:latest, 3단계가 만들었다면)로 'docker compose --profile tunnel up -d --no-build'를 시도하세요."
    exit 1
}

function Test-LastExit {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Stop-DeployWithError "$Description 실패 (종료 코드 $LASTEXITCODE)"
    }
}

$TotalSteps = 8
$ScriptStart = Get-Date

# 실행 도중 여러 단계에서 참조되는 상태값 — Set-StrictMode에서 "정의되지 않은 변수" 오류가 나지
# 않도록 모든 분기 이전에 기본값으로 초기화해 둔다.
$OldHash = "unknown"
$NewHash = "unknown"
$CommitCount = 0
$AppImageName = $null
$StashCreated = $false
$HealthOk = $false
$LocalSmokeOk = $false
$TunnelSmokeOk = $false

if (-not $PSScriptRoot) {
    Write-Fail "오류: PSScriptRoot를 확인할 수 없습니다. deploy.ps1을 파일로 실행하세요(예: deploy.cmd 더블클릭)."
    exit 1
}
$SelfhostDir = $PSScriptRoot

# ---------------------------------------------------------------------------
# 로그 파일 준비 + Start-Transcript. 모든 단계 출력을 tooling/selfhost/deploy-logs/에 남긴다.
# ---------------------------------------------------------------------------
$LogDir = Join-Path $SelfhostDir "deploy-logs"
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir ("deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

$TranscriptStarted = $false
try {
    Start-Transcript -Path $LogFile -Append | Out-Null
    $TranscriptStarted = $true
} catch {
    Write-Warn "[경고] 로그 파일 기록을 시작하지 못했습니다 ($LogFile): $($_.Exception.Message) — 콘솔 출력만 계속합니다."
}

Push-Location -LiteralPath $SelfhostDir
try {
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " WORLD TYPING (TypeTrip) 원클릭 배포" -ForegroundColor Cyan
    Write-Host " 대상: https://worldtyping.leaderpark.net" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host " 모드: DRY RUN (실제 git/docker 명령 실행 없음)" -ForegroundColor Yellow
    }
    Write-Host "==================================================" -ForegroundColor Cyan

    # -----------------------------------------------------------------------
    # [1/8] 프리플라이트
    # -----------------------------------------------------------------------
    Write-StepHeader 1 $TotalSteps "프리플라이트 확인"

    $IsRepoRaw = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0 -or $IsRepoRaw -ne "true") {
        Stop-DeployWithError "현재 위치가 git 저장소 워킹트리가 아닙니다: $SelfhostDir"
    }
    Write-Host "  - git 워킹트리 확인: OK"

    $OldHash = (git rev-parse HEAD 2>$null)
    Test-LastExit "git rev-parse HEAD"
    $OldHash = $OldHash.Trim()
    Write-Host "  - 현재(배포 전) 커밋: $OldHash"

    $EnvPath = Join-Path $SelfhostDir ".env"
    if (Test-Path -LiteralPath $EnvPath) {
        Write-Host "  - .env 파일 확인: OK ($EnvPath)"
    } elseif ($DryRun) {
        # DryRun은 준비물이 갖춰지지 않은 PC에서도 전체 8단계를 끝까지 미리보기할 수 있어야
        # 하므로(예: 이 저장소를 처음 받아 아직 .env를 만들지 않은 상태) 여기서는 중단하지 않고
        # 경고만 남긴다 — 실배포(-DryRun 미지정)에서는 아래 else 분기로 여전히 하드 블록된다.
        Write-Warn "  - [DRY RUN] .env 파일이 없습니다 ($EnvPath) — 실배포 시 이 단계에서 중단됩니다. .env.example을 복사해 실제 랜덤 시크릿을 채워두세요."
    } else {
        Stop-DeployWithError ".env 파일이 없습니다 ($EnvPath). tooling/selfhost/.env.example을 복사해 실제 랜덤 시크릿(SESSION_HMAC_SECRET/RUN_HMAC_SECRET/DAILY_SALT 등)을 채운 뒤 다시 실행하세요."
    }

    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker info(데몬 응답) 확인을 생략합니다."
    } else {
        docker info *> $null
        Test-LastExit "docker info (Docker 데몬 응답 확인 — Docker Desktop이 실행 중인지 확인하세요)"
        Write-Host "  - docker 데몬 응답 확인: OK"
    }
    Write-Ok "-> 프리플라이트 통과"

    # -----------------------------------------------------------------------
    # [2/8] Git 동기화
    # -----------------------------------------------------------------------
    Write-StepHeader 2 $TotalSteps "Git 동기화 (fetch -> checkout/pull)"

    if ($SkipPull) {
        Write-Warn "  - -SkipPull 지정: fetch/checkout/pull을 건너뛰고 현재 로컬 워킹트리 상태 그대로 진행합니다."
        if ($Ref -ne "main") {
            Write-Warn "  - -SkipPull과 함께 지정된 -Ref '$Ref'는 무시됩니다."
        }
        $NewHash = (git rev-parse HEAD 2>$null)
        Test-LastExit "git rev-parse HEAD"
        $NewHash = $NewHash.Trim()
    } else {
        if ($DryRun) {
            Write-Host "  - [DRY RUN] git fetch origin (실행 생략)"
        } else {
            git fetch origin
            Test-LastExit "git fetch origin"
            Write-Host "  - git fetch origin 완료"
        }

        # 더티 체크는 추적 파일(수정/스테이지)만 본다 — 이 스크립트 자신이 남기는
        # tooling/selfhost/deploy-logs/*.log 등 미추적 산출물 때문에 매번 오탐하지 않도록.
        $DirtyRaw = git status --porcelain --untracked-files=no
        if ($DirtyRaw) {
            if ($Force) {
                Write-Warn "  - 워킹트리에 커밋되지 않은 변경이 있습니다. -Force 지정으로 stash 후 진행합니다."
                Write-Warn "    변경 내역:`n$DirtyRaw"
                if ($DryRun) {
                    Write-Host "  - [DRY RUN] git stash push -u (실행 생략)"
                } else {
                    $StashMessage = "deploy.ps1 auto-stash " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
                    git stash push -u -m $StashMessage
                    Test-LastExit "git stash push -u"
                    $StashCreated = $true
                    Write-Ok "  - 로컬 변경사항을 stash로 보존했습니다: $StashMessage"
                }
            } else {
                Stop-DeployWithError "워킹트리에 커밋되지 않은 변경이 있어 배포를 중단합니다(-Force로 stash 후 진행 가능):`n$DirtyRaw"
            }
        } else {
            Write-Host "  - 워킹트리 클린 확인: OK"
        }

        $IsSha = $Ref -match '^[0-9a-fA-F]{7,40}$'
        if ($IsSha) {
            Write-Host "  - -Ref 값 '$Ref' -> 커밋 SHA로 판단합니다. 해당 커밋으로 고정(detached) 체크아웃합니다."
            if ($DryRun) {
                Write-Host "  - [DRY RUN] git checkout $Ref (실행 생략)"
            } else {
                git checkout $Ref
                Test-LastExit "git checkout $Ref"
            }
        } else {
            Write-Host "  - -Ref 값 '$Ref' -> 브랜치로 판단합니다. origin/$Ref 기준으로 ff-only 반영합니다."
            if ($DryRun) {
                Write-Host "  - [DRY RUN] git checkout $Ref && git merge --ff-only origin/$Ref (실행 생략)"
            } else {
                git checkout $Ref
                Test-LastExit "git checkout $Ref"
                git merge --ff-only "origin/$Ref"
                Test-LastExit "git merge --ff-only origin/$Ref (fast-forward 불가 — 로컬 브랜치가 origin과 갈라졌을 수 있습니다)"
            }
        }

        $NewHash = (git rev-parse HEAD 2>$null)
        Test-LastExit "git rev-parse HEAD"
        $NewHash = $NewHash.Trim()
    }

    Write-Host "  - 이전 커밋: $OldHash"
    Write-Host "  - 신규 커밋: $NewHash"

    if ($OldHash -ne $NewHash -and -not $DryRun) {
        $CountRaw = git rev-list --count "$OldHash..$NewHash" 2>$null
        if ($LASTEXITCODE -eq 0 -and $CountRaw) {
            $CommitCount = [int]($CountRaw.Trim())
        }
    }
    Write-Host "  - 반영된 커밋 수: $CommitCount"
    Write-Ok "-> Git 동기화 완료"

    # -----------------------------------------------------------------------
    # [3/8] 롤백 대비 — 현재 app 이미지를 worldtyping-rollback 태그로 보존
    # -----------------------------------------------------------------------
    Write-StepHeader 3 $TotalSteps "롤백 이미지 보존"

    if ($DryRun) {
        Write-Host "  - [DRY RUN] compose 이미지명 확인 / 기존 이미지 태그 보존을 생략합니다."
    } else {
        # docker-compose.yml의 app 서비스는 image: 를 명시하지 않으므로 compose 기본 네이밍
        # (프로젝트명-서비스명, name: worldtyping -> worldtyping-app)이 적용된다. 하드코딩 대신
        # 'docker compose config --images'로 이 인스턴스의 실제 이미지명을 확인해 둔다(요구사항:
        # "compose가 만드는 실제 이미지명은 compose 파일에서 확인").
        $ImagesRaw = docker compose config --images app 2>$null
        if ($LASTEXITCODE -eq 0 -and $ImagesRaw) {
            $AppImageName = ($ImagesRaw | Select-Object -First 1).Trim()
            Write-Host "  - compose가 사용하는 app 이미지명: $AppImageName"
        } else {
            Write-Warn "  - 'docker compose config --images'로 이미지명을 확인하지 못했습니다(계속 진행)."
        }

        $ExistingImageId = docker inspect --format "{{.Image}}" worldtyping 2>$null
        if ($LASTEXITCODE -eq 0 -and $ExistingImageId) {
            $ExistingImageId = $ExistingImageId.Trim()
            docker tag $ExistingImageId worldtyping-rollback:latest
            Test-LastExit "docker tag $ExistingImageId worldtyping-rollback:latest"
            Write-Ok "  - 이전 이미지 보존 완료: $ExistingImageId -> worldtyping-rollback:latest"
        } else {
            Write-Warn "  - 기존 worldtyping 컨테이너/이미지를 찾을 수 없어 롤백 이미지 보존을 건너뜁니다(최초 배포로 판단)."
        }
    }
    Write-Ok "-> 롤백 대비 단계 완료"

    # -----------------------------------------------------------------------
    # [4/8] 이미지 빌드
    # -----------------------------------------------------------------------
    Write-StepHeader 4 $TotalSteps "Docker 이미지 빌드"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker compose --profile tunnel build --progress plain (실행 생략)"
    } else {
        docker compose --profile tunnel build --progress plain
        Test-LastExit "docker compose --profile tunnel build"
    }
    Write-Ok "-> 빌드 완료"

    # -----------------------------------------------------------------------
    # [5/8] 컨테이너 기동
    # -----------------------------------------------------------------------
    Write-StepHeader 5 $TotalSteps "컨테이너 기동"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker compose --profile tunnel up -d (실행 생략)"
    } else {
        docker compose --profile tunnel up -d
        Test-LastExit "docker compose --profile tunnel up -d"
    }
    Write-Ok "-> 컨테이너 기동 완료"

    # -----------------------------------------------------------------------
    # [6/8] 헬스체크 대기 (healthcheck start_period 40s 감안, 최대 180초 폴링)
    # -----------------------------------------------------------------------
    Write-StepHeader 6 $TotalSteps "헬스체크 대기 (최대 180초)"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] 헬스체크 대기를 생략합니다(컨테이너 미기동)."
        $HealthOk = $true
    } else {
        $Deadline = (Get-Date).AddSeconds(180)
        $LastStatus = "unknown"
        while ((Get-Date) -lt $Deadline) {
            $StatusRaw = docker inspect --format "{{.State.Health.Status}}" worldtyping 2>$null
            if ($LASTEXITCODE -eq 0 -and $StatusRaw) {
                $LastStatus = $StatusRaw.Trim()
                Write-Host ("  - 헬스 상태: {0} ({1})" -f $LastStatus, (Get-Date -Format 'HH:mm:ss'))
                if ($LastStatus -eq "healthy") {
                    $HealthOk = $true
                    break
                }
            }
            Start-Sleep -Seconds 5
        }
        if (-not $HealthOk) {
            Stop-DeployWithError "180초 내에 worldtyping 컨테이너가 healthy 상태가 되지 못했습니다(마지막 상태: $LastStatus). 'docker compose logs app'으로 원인을 확인하세요."
        }
    }
    Write-Ok "-> 헬스체크 통과"

    # -----------------------------------------------------------------------
    # [7/8] 스모크 테스트 — 로컬(필수) + 터널(경고만)
    # -----------------------------------------------------------------------
    Write-StepHeader 7 $TotalSteps "스모크 테스트"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] 로컬/터널 헬스 엔드포인트 호출을 생략합니다."
        $LocalSmokeOk = $true
        $TunnelSmokeOk = $true
    } else {
        try {
            $LocalResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8790/api/v1/health" -TimeoutSec 15
            if ($LocalResp.StatusCode -eq 200) {
                $LocalSmokeOk = $true
                Write-Ok "  - 로컬(http://127.0.0.1:8790/api/v1/health) 200 OK"
            } else {
                Write-Warn "  - 로컬 헬스 응답 코드 비정상: $($LocalResp.StatusCode)"
            }
        } catch {
            Write-Fail "  - 로컬(http://127.0.0.1:8790/api/v1/health) 호출 실패: $($_.Exception.Message)"
        }

        if (-not $LocalSmokeOk) {
            Stop-DeployWithError "로컬 헬스체크(http://127.0.0.1:8790/api/v1/health)가 실패했습니다 — 배포가 정상 완료되지 않았습니다."
        }

        try {
            $TunnelResp = Invoke-WebRequest -UseBasicParsing -Uri "https://worldtyping.leaderpark.net/api/v1/health" -TimeoutSec 15
            if ($TunnelResp.StatusCode -eq 200) {
                $TunnelSmokeOk = $true
                Write-Ok "  - 터널(https://worldtyping.leaderpark.net/api/v1/health) 200 OK"
            } else {
                Write-Warn "  - 터널 헬스 응답 코드 비정상: $($TunnelResp.StatusCode) (경고만 — 로컬 성공이므로 배포 자체는 성공 판정)"
            }
        } catch {
            Write-Warn "  - 터널(https://worldtyping.leaderpark.net/api/v1/health) 호출 실패 (경고만 — 로컬 성공이므로 배포 자체는 성공 판정): $($_.Exception.Message)"
        }
    }
    Write-Ok "-> 스모크 테스트 완료 (판정 기준: 로컬)"

    # -----------------------------------------------------------------------
    # [8/8] 요약
    # -----------------------------------------------------------------------
    Write-StepHeader 8 $TotalSteps "배포 요약"

    $Elapsed = (Get-Date) - $ScriptStart
    $ElapsedStr = "{0}분 {1}초" -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds

    Write-Host ""
    Write-Host "================ 배포 요약 ================"
    Write-Host ("  모드            : {0}" -f $(if ($DryRun) { "DRY RUN (실제 변경 없음)" } else { "실배포" }))
    Write-Host "  이전 커밋       : $OldHash"
    Write-Host "  배포된 커밋     : $NewHash"
    Write-Host "  반영된 커밋 수  : $CommitCount"
    Write-Host "  소요 시간       : $ElapsedStr"
    Write-Host ("  로컬 헬스       : {0}" -f $(if ($LocalSmokeOk) { "OK" } else { "실패" }))
    Write-Host ("  터널 헬스       : {0}" -f $(if ($TunnelSmokeOk) { "OK" } else { "실패(경고)" }))
    Write-Host "  로그 파일       : $LogFile"
    Write-Host "============================================"
    Write-Host ""

    if ($StashCreated) {
        Write-Warn "주의: -Force로 로컬 변경사항을 stash했습니다. 'git stash list'로 확인 후 필요하면 'git stash pop'하세요(자동으로 되돌리지 않습니다)."
    }

    if (-not $DryRun) {
        Write-Host "롤백이 필요하면 다음 중 하나를 실행하세요:"
        Write-Host "  1) 소스 롤백 후 재배포: git checkout $OldHash  ->  deploy.cmd 재실행(-SkipPull로 그 커밋 그대로 빌드)"
        if ($AppImageName) {
            Write-Host "  2) 보존된 이전 이미지로 재빌드 없이 즉시 복구:"
            Write-Host "     docker tag worldtyping-rollback:latest $AppImageName"
            Write-Host "     docker compose --profile tunnel up -d --no-build"
        } else {
            Write-Host "  2) 보존된 이전 이미지가 있다면(worldtyping-rollback:latest), 'docker compose config --images app'으로 실제 이미지명을 확인한 뒤 그 이름으로 재태그하고 'docker compose --profile tunnel up -d --no-build'로 복구하세요."
        }
    }

    Write-Ok "배포가 성공적으로 완료되었습니다."
} finally {
    Pop-Location
    if ($TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}
