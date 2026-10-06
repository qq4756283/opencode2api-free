@echo off
REM Trigger GitHub Actions docker-hub workflow to build and push opencode-gate.
REM Windows PowerShell 5.1 blocks .ps1 under the default Restricted policy,
REM so this wrapper passes a one-shot -ExecutionPolicy Bypass.
REM The machine-wide execution policy is NOT modified.
REM
REM   trigger-build.cmd
REM   trigger-build.cmd -TimeTag none
REM   trigger-build.cmd -RepoUrl https://github.com/spfnas/opencode2api-free.git
REM   trigger-build.cmd -Tags latest,dev -Platforms linux/amd64
setlocal

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0trigger-build.ps1" %*
exit /b %ERRORLEVEL%
