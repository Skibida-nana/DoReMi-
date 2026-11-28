@echo off
setlocal EnableExtensions
pushd "%~dp0.."

title DoReMi v1.0.0-rc.9 - QA Full Regression & Soak Suite

if exist "D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64\node.exe" (
  set "PATH=D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64;%PATH%"
)
if exist "D:\Dowload\FFmpeg\ffmpeg-2026-11-23-git-05c674c913-full_build\bin\ffmpeg.exe" (
  set "PATH=D:\Dowload\FFmpeg\ffmpeg-2026-11-23-git-05c674c913-full_build\bin;%PATH%"
  set "FFMPEG_PATH=D:\Dowload\FFmpeg\ffmpeg-2026-11-23-git-05c674c913-full_build\bin\ffmpeg.exe"
  set "FFPROBE_PATH=D:\Dowload\FFmpeg\ffmpeg-2026-11-23-git-05c674c913-full_build\bin\ffprobe.exe"
)
if exist "G:\Soure app\foobar2000\encoders\flac.exe" (
  set "DOREMI_REAL_CODECS_DIR=G:\Soure app\foobar2000\encoders"
)

if not exist "qa\logs" mkdir "qa\logs"
set "LOG_FILE=qa\logs\soak-latest.log"

echo ============================================================ > "%LOG_FILE%"
echo DoReMi QA Full Regression & Soak Test - %DATE% %TIME% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

echo === [1/2] Chay toan bo Electron Automated Test Suite ===
call npm.cmd run test:electron >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo === [2/2] Chay Stress & Memory Stability Benchmark ===
node scripts\run-stress-phase52.mjs >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :fail

echo.
echo [PASS] Toan bo QA Full Test Suite & Soak Benchmark da PASS! Log: %LOG_FILE%
echo.
pause
popd
exit /b 0

:fail
echo.
echo [FAIL] Co ca kiem thu that bai! Xem chi tiet trong: %LOG_FILE%
type "%LOG_FILE%"
echo.
pause
popd
exit /b 1
