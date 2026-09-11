@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   Gia V3 — local start
echo ========================================
echo.
echo Canonical DB: %CD%\.data\gia-v3
echo API:  http://localhost:5000
echo Web:  http://localhost:5173
echo Login: admin / admin123
echo.
echo Closing this window will NOT stop the servers.
echo Close the "Gia V3 API" and "Gia V3 Web" windows to stop.
echo.

start "Gia V3 API" cmd /k "cd /d ""%~dp0"" && pnpm.cmd run start:v3"
timeout /t 3 /nobreak >nul
start "Gia V3 Web" cmd /k "cd /d ""%~dp0"" && pnpm.cmd run dev:web"

echo Started.
echo Open http://localhost:5173
endlocal
