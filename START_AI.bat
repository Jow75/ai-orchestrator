@echo off
rem ============================================================
rem  START_AI.bat - double-click launcher for AI-Orchestrator
rem
rem  Starts (or resumes) supervision of the default project.
rem  Pass a project name to supervise a specific project:
rem      START_AI.bat my-project
rem ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH. Install Node.js 18+ and try again.
    pause
    exit /b 1
)

node "%~dp0bin\ai-orchestrator.js" start %*

if errorlevel 1 (
    echo.
    echo AI-Orchestrator exited with an error. See the message above and logs\.
    pause
)
