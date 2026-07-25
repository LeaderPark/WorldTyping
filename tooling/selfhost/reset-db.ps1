# spec: WT-DBRESET-TOOL — 자기호스팅 PC용 원클릭 DB 초기화 도구.
#
# 라이브 데이터 볼륨(worldtyping_wt-data — docker-compose.yml `name: worldtyping` + 볼륨명
# `wt-data`가 compose 프로젝트 접두사와 합쳐진 실제 이름. D1/KV/DO SQLite 상태가 전부 이 안에
# 있다)을 백업한 뒤 완전히 비우고, app 컨테이너를 재기동해 entrypoint.sh가 마이그레이션을 새로
# 적용하는 "새로 시작" 상태를 만든다. 볼륨 자체는 삭제하지 않는다(compose 참조 보존, 내용물만
# 비운다) — docker-compose.yml/Dockerfile/entrypoint.sh는 이 도구가 건드리지 않는다.
#
# PowerShell 5.1 호환 필수(자기호스팅 PC에 pwsh 미설치 가능) — 삼항(?:)/널병합(??) 등 PS7 전용
# 문법 금지. 출력·로그·인자 관례는 deploy.ps1(WT-DEPLOY-TOOL)을 그대로 따른다.
#
# 사용법: tooling/selfhost/reset-db.cmd 더블클릭, 또는 직접:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tooling\selfhost\reset-db.ps1 [-DryRun] [-Force]
#
# 파라미터:
#   -DryRun  실제 docker 명령을 하나도 실행하지 않고 8단계를 미리보기만 한다(RESET 확인 입력도
#            건너뛴다 — Docker Desktop 미기동/미설치 상태에서도 끝까지 완주해야 하므로). 사전
#            점검용.
#   -Force   시작 시 요구하는 "RESET" 확인 입력을 건너뛰고 바로 진행한다(자동화/무인 실행용).
#            안전장치 자체를 없애는 것이 아니라 "사람이 지금 타이핑해서 확인"하는 절차만 생략한다.
#
# 안전장치: DryRun도 -Force도 아니면 시작 직후 빨간 경고를 띄우고 정확히 대문자 "RESET"을 입력받아
# 대소문자까지 정확히 일치해야 진행한다(불일치/취소/EOF는 전부 중단으로 처리 — fail-closed).

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# 출력 헬퍼 — deploy.ps1과 동일한 색상/로그 관례. Start-Transcript가 Write-Host 출력을 그대로
# 로그 파일에도 남기므로 이 함수들만 쓰면 콘솔+로그 양쪽에 기록된다.
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

function Write-Danger {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red -BackgroundColor Black
}

function Stop-ResetWithError {
    param([string]$Message)
    Write-Fail "오류: $Message"
    Write-Fail "DB 초기화를 중단합니다. 상세 로그: $LogFile"
    if ($BackupOk -and $ArchivePath) {
        Write-Fail "참고: 백업 아카이브는 이미 생성되어 있습니다: $ArchivePath"
    }
    exit 1
}

function Test-LastExit {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Stop-ResetWithError "$Description 실패 (종료 코드 $LASTEXITCODE)"
    }
}

function Format-ByteSize {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

$TotalSteps = 8
$ScriptStart = Get-Date

# Set-StrictMode에서 "정의되지 않은 변수" 오류가 나지 않도록 모든 분기 이전에 기본값 초기화.
$VolumeName = "worldtyping_wt-data"
$ContainerName = "worldtyping"
$BackupOk = $false
$ArchivePath = $null
$ArchiveSizeBytes = 0
$WipeOk = $false
$HealthOk = $false
$SmokeOk = $false

if (-not $PSScriptRoot) {
    Write-Fail "오류: PSScriptRoot를 확인할 수 없습니다. reset-db.ps1을 파일로 실행하세요(예: reset-db.cmd 더블클릭)."
    exit 1
}
$SelfhostDir = $PSScriptRoot

# ---------------------------------------------------------------------------
# 로그 파일 준비 + Start-Transcript. 모든 단계 출력을 tooling/selfhost/deploy-logs/에 남긴다
# (.dockerignore/.gitignore에 이미 제외된 디렉터리 — deploy.ps1과 공유).
# ---------------------------------------------------------------------------
$LogDir = Join-Path $SelfhostDir "deploy-logs"
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir ("reset-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

$TranscriptStarted = $false
try {
    Start-Transcript -Path $LogFile -Append | Out-Null
    $TranscriptStarted = $true
} catch {
    Write-Warn "[경고] 로그 파일 기록을 시작하지 못했습니다 ($LogFile): $($_.Exception.Message) — 콘솔 출력만 계속합니다."
}

Push-Location -LiteralPath $SelfhostDir
try {
    Write-Host "==================================================" -ForegroundColor Red
    Write-Danger " WORLD TYPING (TypeTrip) DB 초기화 도구"
    Write-Danger " 대상 볼륨 : $VolumeName (D1 / KV / DO SQLite 전체)"
    Write-Host "==================================================" -ForegroundColor Red
    Write-Danger " 경고: 이 작업은 전체 계정, 플레이 기록, 랭킹, 진행 중인 멀티플레이 방을"
    Write-Danger "       영구적으로 삭제합니다. KV config:* 원격 설정 오버라이드도 함께"
    Write-Danger "       초기화됩니다. 자동 백업을 생성하지만 되돌리려면 수동 복원 절차가"
    Write-Danger "       필요합니다(요약 단계에서 안내)."
    Write-Host "==================================================" -ForegroundColor Red
    if ($DryRun) {
        Write-Host " 모드: DRY RUN (실제 docker 명령 실행 없음)" -ForegroundColor Yellow
        Write-Host "==================================================" -ForegroundColor Red
    }

    # -----------------------------------------------------------------------
    # 안전장치: RESET 확인 입력 (8단계에 포함되지 않는 사전 게이트 — deploy.ps1의 배너/파싱과
    # 동일하게 "[1/8]" 이전에 처리한다).
    # -----------------------------------------------------------------------
    if ($Force) {
        Write-Warn "-Force 지정 — RESET 확인 입력 절차를 건너뜁니다(자동화 모드)."
    } elseif ($DryRun) {
        Write-Warn "[DRY RUN] RESET 확인 입력 절차를 미리보기만 합니다 — 실제 실행에서는 여기서 대소문자까지 정확히 'RESET'을 입력해야 다음 단계로 진행됩니다."
    } else {
        Write-Host ""
        $UserConfirmation = $null
        try {
            $UserConfirmation = Read-Host "계속하려면 대문자로 정확히 RESET 을 입력하세요 (그 외 입력/취소 시 중단)"
        } catch {
            $UserConfirmation = $null
        }
        if ($null -eq $UserConfirmation -or $UserConfirmation -cne "RESET") {
            Write-Fail "확인 문자열이 일치하지 않습니다. DB 초기화를 중단합니다(어떠한 docker 명령도 실행되지 않았습니다)."
            exit 1
        }
        Write-Ok "확인되었습니다. DB 초기화를 진행합니다."
    }

    # -----------------------------------------------------------------------
    # [1/8] 프리플라이트 — docker 데몬 응답 확인 + 대상 볼륨 존재 확인
    # -----------------------------------------------------------------------
    Write-StepHeader 1 $TotalSteps "프리플라이트 확인"

    $EnvPath = Join-Path $SelfhostDir ".env"
    if (Test-Path -LiteralPath $EnvPath) {
        Write-Host "  - .env 파일 확인: OK ($EnvPath)"
    } elseif ($DryRun) {
        Write-Warn "  - [DRY RUN] .env 파일이 없습니다 ($EnvPath) — 실행 시 이 단계에서 중단됩니다(docker compose가 이 파일의 변수 치환을 필요로 합니다)."
    } else {
        Stop-ResetWithError ".env 파일이 없습니다 ($EnvPath). tooling/selfhost/.env.example을 복사해 채운 뒤 다시 실행하세요."
    }

    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker info(데몬 응답) 확인을 생략합니다."
        Write-Host ("  - [DRY RUN] docker volume inspect {0} 확인을 생략합니다." -f $VolumeName)
    } else {
        docker info *> $null
        Test-LastExit "docker info (Docker 데몬 응답 확인 — Docker Desktop이 실행 중인지 확인하세요)"
        Write-Host "  - docker 데몬 응답 확인: OK"

        docker volume inspect $VolumeName *> $null
        if ($LASTEXITCODE -ne 0) {
            Stop-ResetWithError "볼륨 '$VolumeName'을 찾을 수 없습니다. 최초 기동('docker compose up -d app')을 먼저 수행했는지 확인하세요(볼륨이 없으면 초기화할 대상이 없습니다)."
        }
        Write-Host ("  - 볼륨 확인: OK ({0})" -f $VolumeName)
    }
    Write-Ok "-> 프리플라이트 통과"

    # -----------------------------------------------------------------------
    # [2/8] 자동 백업 — busybox tar로 볼륨 전체를 tooling/selfhost/backup/manual/에 스냅샷
    # -----------------------------------------------------------------------
    Write-StepHeader 2 $TotalSteps "자동 백업"

    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ManualBackupDir = Join-Path (Join-Path $SelfhostDir "backup") "manual"
    $ArchiveFileName = "wt-data-$Stamp.tar.gz"
    $ArchivePath = Join-Path $ManualBackupDir $ArchiveFileName

    if ($DryRun) {
        Write-Host ("  - [DRY RUN] 백업 디렉터리 생성 생략: {0}" -f $ManualBackupDir)
        Write-Host ("  - [DRY RUN] docker run --rm -v {0}:/data -v {1}:/backup busybox tar czf /backup/{2} -C /data . (실행 생략)" -f $VolumeName, $ManualBackupDir, $ArchiveFileName)
        Write-Host "  - [DRY RUN] 백업 파일 존재/크기 확인을 생략합니다."
        $BackupOk = $true
    } else {
        New-Item -ItemType Directory -Path $ManualBackupDir -Force | Out-Null
        Write-Host ("  - 백업 대상: {0}" -f $ArchivePath)

        docker run --rm -v "${VolumeName}:/data" -v "${ManualBackupDir}:/backup" busybox tar czf "/backup/$ArchiveFileName" -C /data .
        Test-LastExit "docker run busybox tar (수동 백업)"

        if (-not (Test-Path -LiteralPath $ArchivePath)) {
            Stop-ResetWithError "백업 아카이브가 생성되지 않았습니다: $ArchivePath — 볼륨 초기화를 중단합니다(안전을 위해 백업 확인 전에는 아무것도 지우지 않습니다)."
        }
        $ArchiveSizeBytes = (Get-Item -LiteralPath $ArchivePath).Length
        if ($ArchiveSizeBytes -le 0) {
            Stop-ResetWithError "백업 아카이브 크기가 0바이트입니다: $ArchivePath — 볼륨 초기화를 중단합니다."
        }
        Write-Ok ("  - 백업 확인 완료: {0} ({1})" -f $ArchivePath, (Format-ByteSize $ArchiveSizeBytes))
        $BackupOk = $true
    }
    Write-Ok "-> 자동 백업 완료"

    # -----------------------------------------------------------------------
    # [3/8] app 컨테이너 정지
    # -----------------------------------------------------------------------
    Write-StepHeader 3 $TotalSteps "app 컨테이너 정지"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker compose --profile tunnel stop app (실행 생략)"
    } else {
        docker compose --profile tunnel stop app
        Test-LastExit "docker compose --profile tunnel stop app"
        Write-Host "  - app 컨테이너 정지 완료"
    }
    Write-Ok "-> 정지 완료"

    # -----------------------------------------------------------------------
    # [4/8] 볼륨 내용 삭제 (볼륨 자체는 유지 — compose 참조 보존)
    # -----------------------------------------------------------------------
    Write-StepHeader 4 $TotalSteps "볼륨 내용 삭제"
    $WipeCommandDisplay = 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true'
    if ($DryRun) {
        Write-Host ("  - [DRY RUN] docker run --rm -v {0}:/data busybox sh -c `"{1}`" (실행 생략)" -f $VolumeName, $WipeCommandDisplay)
        Write-Host "  - [DRY RUN] 볼륨 자체는 삭제하지 않습니다(내용물만 비웁니다)."
        $WipeOk = $true
    } else {
        docker run --rm -v "${VolumeName}:/data" busybox sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null || true"
        Test-LastExit "docker run busybox rm -rf /data/* (볼륨 내용 삭제)"
        $WipeOk = $true
        Write-Host "  - 볼륨 내용 삭제 완료(볼륨 자체는 유지됨)"
    }
    Write-Ok "-> 볼륨 내용 삭제 완료"

    # -----------------------------------------------------------------------
    # [5/8] app 컨테이너 재기동 — entrypoint.sh가 빈 볼륨에 마이그레이션을 새로 적용
    # -----------------------------------------------------------------------
    Write-StepHeader 5 $TotalSteps "app 컨테이너 재기동"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] docker compose --profile tunnel start app (실행 생략)"
    } else {
        docker compose --profile tunnel start app
        Test-LastExit "docker compose --profile tunnel start app"
        Write-Host "  - app 컨테이너 재기동 명령 완료(entrypoint.sh가 빈 볼륨에 마이그레이션을 새로 적용합니다)"
    }
    Write-Ok "-> 재기동 완료"

    # -----------------------------------------------------------------------
    # [6/8] 헬스체크 대기 (healthcheck start_period 40s 감안, 최대 180초 폴링)
    # -----------------------------------------------------------------------
    Write-StepHeader 6 $TotalSteps "헬스체크 대기 (최대 180초)"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] 헬스체크 대기를 생략합니다(컨테이너 미조작)."
        $HealthOk = $true
    } else {
        $Deadline = (Get-Date).AddSeconds(180)
        $LastStatus = "unknown"
        while ((Get-Date) -lt $Deadline) {
            $StatusRaw = docker inspect --format "{{.State.Health.Status}}" $ContainerName 2>$null
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
            Stop-ResetWithError "180초 내에 $ContainerName 컨테이너가 healthy 상태가 되지 못했습니다(마지막 상태: $LastStatus). 'docker compose logs app'으로 원인(마이그레이션 실패 등)을 확인하세요. 백업 아카이브는 보존되어 있습니다: $ArchivePath"
        }
    }
    Write-Ok "-> 헬스체크 통과"

    # -----------------------------------------------------------------------
    # [7/8] 스모크 테스트 — 로컬 헬스 엔드포인트
    # -----------------------------------------------------------------------
    Write-StepHeader 7 $TotalSteps "스모크 테스트"
    if ($DryRun) {
        Write-Host "  - [DRY RUN] 로컬 헬스 엔드포인트 호출을 생략합니다."
        $SmokeOk = $true
    } else {
        try {
            $LocalResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8790/api/v1/health" -TimeoutSec 15
            if ($LocalResp.StatusCode -eq 200) {
                $SmokeOk = $true
                Write-Ok "  - 로컬(http://127.0.0.1:8790/api/v1/health) 200 OK"
            } else {
                Write-Warn "  - 로컬 헬스 응답 코드 비정상: $($LocalResp.StatusCode)"
            }
        } catch {
            Write-Fail "  - 로컬(http://127.0.0.1:8790/api/v1/health) 호출 실패: $($_.Exception.Message)"
        }

        if (-not $SmokeOk) {
            Stop-ResetWithError "로컬 헬스체크(http://127.0.0.1:8790/api/v1/health)가 실패했습니다 — 초기화 후 앱이 정상 기동되지 않았습니다. 백업 아카이브는 보존되어 있습니다: $ArchivePath"
        }
    }
    Write-Ok "-> 스모크 테스트 완료"

    # -----------------------------------------------------------------------
    # [8/8] 요약
    # -----------------------------------------------------------------------
    Write-StepHeader 8 $TotalSteps "초기화 요약"

    $Elapsed = (Get-Date) - $ScriptStart
    $ElapsedStr = "{0}분 {1}초" -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds
    $ArchiveSizeStr = if ($DryRun) { "(DRY RUN — 생성되지 않음)" } else { Format-ByteSize $ArchiveSizeBytes }

    Write-Host ""
    Write-Host "================ DB 초기화 요약 ================"
    Write-Host ("  모드            : {0}" -f $(if ($DryRun) { "DRY RUN (실제 변경 없음)" } else { "실행" }))
    Write-Host ("  대상 볼륨       : {0}" -f $VolumeName)
    Write-Host ("  백업 아카이브   : {0}" -f $ArchivePath)
    Write-Host ("  백업 크기       : {0}" -f $ArchiveSizeStr)
    Write-Host "  소요 시간       : $ElapsedStr"
    Write-Host ("  헬스체크        : {0}" -f $(if ($HealthOk) { "OK" } else { "실패" }))
    Write-Host ("  스모크 테스트   : {0}" -f $(if ($SmokeOk) { "OK" } else { "실패" }))
    Write-Host "  로그 파일       : $LogFile"
    Write-Host "=================================================="
    Write-Host ""

    if (-not $DryRun) {
        Write-Host "복원이 필요하면 다음 순서로 진행하세요:"
        Write-Host "  1) docker compose --profile tunnel stop app"
        Write-Host ("  2) docker run --rm -v {0}:/data -v {1}:/backup:ro busybox sh -c `"rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/{2} -C /data`"" -f $VolumeName, $ManualBackupDir, $ArchiveFileName)
        Write-Host "  3) docker compose --profile tunnel start app"
        Write-Host ""
        Write-Warn "참고: 이번 초기화로 KV config:* 원격 설정 오버라이드(등급 컷·안티치트 임계값·배너 등)도 함께 삭제되었습니다. 필요하면 운영 런북(tooling/ops/runbook.md)을 참고해 재적용하세요."
    }

    Write-Ok "DB 초기화가 성공적으로 완료되었습니다."
} finally {
    Pop-Location
    if ($TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
}
