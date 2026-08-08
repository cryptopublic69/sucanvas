@echo off
setlocal

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
set "DEV_EXIT_CODE=%ERRORLEVEL%"

if /I not "%~1"=="--check" (
  if not "%DEV_EXIT_CODE%"=="0" pause
)

exit /b %DEV_EXIT_CODE%
