@echo off
setlocal EnableExtensions
pushd "%~dp0.."

title DoReMi v1.0.0-rc.2 - QA Launcher

echo ============================================================
echo   DoReMi Windows v1.0.0-rc.2 - Release Candidate Launcher
echo ============================================================
echo.
set "RC_PORTABLE=%CD%\release\v1.0.0-rc.2\DoReMi-1.0.0-rc.2-x64-portable.exe"
set "RC_UNPACKED=%CD%\release\v1.0.0-rc.2\win-unpacked\DoReMi.exe"

set "TARGET_EXE="
if exist "%RC_UNPACKED%" set "TARGET_EXE=%RC_UNPACKED%"
if not defined TARGET_EXE if exist "%RC_PORTABLE%" set "TARGET_EXE=%RC_PORTABLE%"

if not defined TARGET_EXE (
  echo [FAIL] Khong tim thay ban dong goi RC2 trong release\v1.0.0-rc.2\
  echo        Vui long chay Build Release Candidate truoc.
  pause
  popd
  exit /b 1
)

echo Chon che do khoi chay:
echo   [1] Che do QA co lap (%TEMP%\DoReMi-QA-UserData) - Khong cham thu vien that (Mac dinh sau 8s)
echo   [2] Che do thu vien that (%APPDATA%\Lossless Player) - CANH BAO: se doc/ghi du lieu ca nhan cua ban
echo.
choice /C 12 /N /T 8 /D 1 /M "Nhap lua chon [1/2]: "
set "MODE=%errorlevel%"

if "%MODE%"=="2" (
  echo.
  echo [WARN] Dang mo DoReMi bang thu vien nguoi dung that: %APPDATA%\Lossless Player
  start "" "%TARGET_EXE%"
) else (
  set "ISO_DIR=%TEMP%\DoReMi-QA-UserData"
  if not exist "%ISO_DIR%" mkdir "%ISO_DIR%"
  echo.
  echo [INFO] Dang mo DoReMi trong ho so co lap: %ISO_DIR%
  start "" "%TARGET_EXE%" "--user-data-dir=%ISO_DIR%"
)

echo [PASS] Da gui lenh khoi chay: %TARGET_EXE%
popd
exit /b 0
