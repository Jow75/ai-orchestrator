@echo off
rem ============================================================
rem  START_SERVICE.bat - double-click launcher for the Core Service
rem
rem  Brings up the always-on service that answers your phone: the
rem  API, the Telegram operator console, the scheduler, and the
rem  supervision of any running missions.
rem
rem  Safe to double-click at any time. If the service is already
rem  running it says so and changes nothing - it never starts a
rem  second one. (Two services both claim the Telegram poll, and
rem  the symptom is a console that answers every other message.)
rem
rem  For it to come back on its own after a reboot, run once:
rem      node bin\ai-orchestrator.js daemon install
rem ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH. Install Node.js 18+ and try again.
    pause
    exit /b 1
)

node "%~dp0bin\ai-orchestrator.js" daemon ensure

if errorlevel 1 (
    echo.
    echo The Core Service could not be started. See the message above and logs\.
    pause
    exit /b 1
)

echo.
echo You can close this window - the service keeps running.
timeout /t 8 >nul
