@echo off
rem Re-parse LM Studio logs, start the dashboard server in its own window, open the browser.
cd /d "%~dp0"
node parse.mjs
if errorlevel 1 pause & exit /b 1
start "LM Studio Token Dashboard (Ctrl+C to stop)" cmd /k node server.mjs %1
timeout /t 2 >nul
start "" http://localhost:8787
