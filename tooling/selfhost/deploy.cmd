@echo off
chcp 65001 >nul
rem spec: WT-DEPLOY-TOOL
rem WORLD TYPING (TypeTrip) one-click deploy entry point.
rem Double-click this file to redeploy https://worldtyping.leaderpark.net from the latest main.
rem All step-by-step Korean-language output lives in deploy.ps1 (UTF-8 w/ BOM) -- keep this
rem launcher ASCII-only. Mixing non-ASCII text into a .cmd file is fragile across codepages
rem (garbled/misparsed lines have been observed) even with chcp switched to UTF-8 (65001).
rem Pass-through args are supported, e.g.:
rem   deploy.cmd -DryRun
rem   deploy.cmd -SkipPull
rem   deploy.cmd -Ref v1.2.3
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %EXITCODE%
