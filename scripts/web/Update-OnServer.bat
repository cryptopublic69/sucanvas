@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-OnServer.ps1"
set "SUCANVAS_UPDATE_EXIT=%ERRORLEVEL%"
echo.
if "%SUCANVAS_UPDATE_EXIT%"=="0" (
  echo Update complete. Start SuCanvas with your existing service switch.
) else (
  echo Update failed. Check the message above and the logs folder.
)
pause
exit /b %SUCANVAS_UPDATE_EXIT%
