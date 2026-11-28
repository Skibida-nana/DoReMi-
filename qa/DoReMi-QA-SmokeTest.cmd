@echo off
setlocal EnableExtensions
pushd "%~dp0.."

title DoReMi v1.0.0-rc.9 - QA Smoke & Integrity Check

if exist "D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64\node.exe" (
  set "PATH=D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64;%PATH%"
)
if not exist "qa\logs" mkdir "qa\logs"
set "LOG_FILE=qa\logs\smoke-latest.log"

echo ============================================================ > "%LOG_FILE%"
echo DoReMi QA Smoke Check - %DATE% %TIME% >> "%LOG_FILE%"
echo Workspace: %CD% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

echo === DoReMi QA Smoke & Integrity Check ===
echo (Su dung ho so co lap trong %%TEMP%%, khong cham thu vien that)
echo.

echo [1/6] Kiem tra moi truong (doctor)...
call npm.cmd run doctor >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo [2/6] Kiem tra manifest codec (codecs:verify)...
call npm.cmd run codecs:verify >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo [3/6] Kiem tra dong bo User Guide (docs:sync -- --check)...
call npm.cmd run docs:sync -- --check >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo [4/6] Kiem tra TypeScript (lint)...
call npm.cmd run lint >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo [5/6] Kiem tra production build (verify:build)...
call npm.cmd run verify:build >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo [6/6] Khoi chay Electron Smoke Test (unpacked & packaged RC9)...
call npm.cmd run smoke:electron >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

if exist "release\v1.0.0-rc.9\win-unpacked\DoReMi.exe" (
  call npm.cmd run smoke:electron -- --exe "release\v1.0.0-rc.9\win-unpacked\DoReMi.exe" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto :fail
)

echo.
echo [PASS] Tat ca cac buoc QA Smoke Test da PASS. Xem log chi tiet tai: %LOG_FILE%
echo.
pause
popd
exit /b 0

:fail
echo.
echo [FAIL] Co buoc kiem tra bi loi. Xem log chi tiet tai: %LOG_FILE%
type "%LOG_FILE%"
echo.
pause
popd
exit /b 1
