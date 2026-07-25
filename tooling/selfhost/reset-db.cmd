@echo off
chcp 65001 >nul
rem spec: WT-DBRESET-TOOL
rem WORLD TYPING (TypeTrip) one-click DB reset entry point.
rem DESTRUCTIVE: double-clicking this wipes ALL data (accounts, runs, leaderboards, rooms) in
rem the worldtyping_wt-data Docker volume after taking an automatic backup, then restarts the
rem app container so entrypoint.sh re-applies migrations from empty. reset-db.ps1 requires typing
rem RESET to confirm unless -Force is passed.
rem All step-by-step Korean-language output lives in reset-db.ps1 (UTF-8 w/ BOM) -- keep this
rem launcher ASCII-only. Mixing non-ASCII text into a .cmd file is fragile across codepages
rem (garbled/misparsed lines have been observed) even with chcp switched to UTF-8 (65001).
rem Pass-through args are supported, e.g.:
rem   reset-db.cmd -DryRun
rem   reset-db.cmd -Force
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-db.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %EXITCODE%
