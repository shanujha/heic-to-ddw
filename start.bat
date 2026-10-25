@echo off
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js was not found. Install Node.js 20.9 or newer from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
node server.js
pause
