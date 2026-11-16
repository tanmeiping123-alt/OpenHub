@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-server.ps1" -Action Start %*
set "PM_EXIT_CODE=%errorlevel%"
if not "%PM_EXIT_CODE%"=="0" if not defined PM_NO_PAUSE pause
exit /b %PM_EXIT_CODE%
