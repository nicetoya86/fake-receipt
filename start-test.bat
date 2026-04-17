@echo off
title Yeoshin Receipt Guard - Test Server

set PORT=8787
set TEST_URL=http://localhost:%PORT%/test/

echo.
echo  ========================================
echo   Yeoshin Receipt Guard - Test Server
echo  ========================================
echo.

:: Check Python
echo [1/3] Checking Python...
python --version > nul 2>&1
if %errorlevel% == 0 goto :check_port

python3 --version > nul 2>&1
if %errorlevel% == 0 (
  set PYTHON_CMD=python3
  goto :check_port
)

echo  ERROR: Python not found.
echo.
echo  Options:
echo    1) Install Python: https://www.python.org/downloads/
echo    2) Run manually: python -m http.server %PORT%
echo    3) Node.js: npx http-server . -p %PORT%
echo.
pause
exit /b 1

:check_port
if not defined PYTHON_CMD set PYTHON_CMD=python

:: Check port
echo [2/3] Checking port %PORT%...
netstat -ano | findstr ":%PORT% " > nul 2>&1
if %errorlevel% == 0 (
  echo  Port %PORT% in use, switching to 8788...
  set PORT=8788
  set TEST_URL=http://localhost:%PORT%/test/
)
echo  Port %PORT% OK

:: Start server
echo [3/3] Starting HTTP server...
echo.
echo  ----------------------------------------
echo   URL : http://localhost:%PORT%/test/
echo   Stop: Ctrl+C in this window
echo  ----------------------------------------
echo.
echo  Extension load steps:
echo    1. Open chrome://extensions/
echo    2. Enable Developer mode
echo    3. Click "Load unpacked"
echo    4. Select the yeoshin-receipt-guard\ folder
echo.

start "" cmd /c "timeout /t 2 > nul && start chrome %TEST_URL% 2>nul || start msedge %TEST_URL% 2>nul || start %TEST_URL%"

%PYTHON_CMD% -m http.server %PORT%
