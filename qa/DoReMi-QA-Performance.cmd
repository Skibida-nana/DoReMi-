@echo off
setlocal EnableExtensions
pushd "%~dp0.."

title DoReMi v1.0.0-rc.9 - QA Performance & Resource Benchmark

if exist "D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64\node.exe" (
  set "PATH=D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64;%PATH%"
)
if not exist "qa\logs" mkdir "qa\logs"
set "OUT_JSON=qa\logs\performance-latest.json"

echo === DoReMi QA Performance & Scale Benchmark ===
echo (Chay hoan toan trong %%TEMP%%, khong cham du lieu nguoi dung)
echo.

node scripts\run-stress-phase52.mjs > "%OUT_JSON%"
if errorlevel 1 (
  echo [FAIL] Benchmark that bai!
  type "%OUT_JSON%"
  pause
  popd
  exit /b 1
)

echo [PASS] Da hoan tat benchmark. Ket qua JSON duoc luu tai: %OUT_JSON%
echo.
type "%OUT_JSON%"
echo.
pause
popd
exit /b 0
