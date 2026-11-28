# TEST_MATRIX.md — Bản đồ Kiểm thử DoReMi

- **Last Updated**: 2026-11-28T21:16+07:00
- **Last Verified Checkpoint**: `PHASE-6.5-RESOURCE-POWER-MANAGEMENT-RC9-20261128`
- **Verification Scope**: Xác minh tự động sau hoàn tất Phase 6.5 (`v1.0.0-rc.9`) trên Windows 11 (`win32 x64`, Electron `45.4.1`, Electron Node `v24.22.3`, CPU `20` logical CPUs).
- **Source References**: `tests/*.test.ts`, `tests/phase65-*.test.ts`, `scripts/{benchmark-phase65,soak-phase65}.ts`, `scripts/{verify-windows-power-phase65,verify-packaged-rc9}.mjs`, `docs/phase-6/PHASE_6.5_REPORT.md`
- **Verification Status**: `RELEASE CANDIDATE - AUTOMATED RESOURCE, POWER & SOAK VERIFIED · PACKAGED RC.9 VERIFIED · PHYSICAL COMBINED UAT PENDING`

---

## 1. Kết quả kiểm thử mới nhất (`Phase 6.5 RC9 Verification`)

| Group ID | Mô tả & Phạm vi | Lệnh / Files | Trạng thái | Kết quả chi tiết & Bằng chứng |
|---|---|---|---|---|
| `TG-ENV-LINT-SYNC-BUILD` | TS Typecheck, Codec Manifest, User Guide Sync, Audit & Production Build | `audit --omit=dev` + `docs:sync -- --check` + `codecs:verify` + `lint` + `build` | **PASS** | `npm audit`: `0` vulnerabilities (`53` prod deps, `0` new deps); `tsc`: `0` lỗi; `docs:sync`: `OK` (`v1.0.0-rc.9`); `build`: `0` warnings (`main 795.99 kB` + `codec-manager 122.05 kB`, `preload 19.66 kB`, main renderer `677.38 kB` (`+0 kB`) + `ServerPage 400.69 kB`) |
| `TG-FULL-ELECTRON` | Toàn bộ **55 tệp** `tests/*.test.ts` (với FFmpeg trên `PATH` + Foobar2000 encoders) | `npm.cmd run test:electron` (ngoài sandbox) | **PASS (`232 / 232`)** | **`232 PASS, 0 FAIL, 0 SKIP`** (`19,997.86 ms`) |
| `TG-P65-POWER` | Toàn bộ **22 kịch bản** máy trạng thái nguồn điện (`follow-system`, `keep-awake-streaming` + `45s` grace, `keep-awake-host-on`, thu hồi thiết bị nhả tức thì, chặn `401`, pin, lưu bền vững & `suspend`/`resume` fail-closed) + kiểm chứng Electron `powerSaveBlocker` thực tế | `tests/phase65-power-management.test.ts` + `scripts/verify-windows-power-phase65.mjs` | **PASS (`2 / 2` + OS Probe)** | `isStartedWhileActive: true`, `isStoppedAfterRelease: true`, `displaySleepAllowedNormally: true` (`qa/logs/phase65-windows-power-verification.json`) |
| `TG-P65-LIFECYCLE` | Vòng đời `STOPPED/STANDBY/ACTIVE`, `ScopedHttpsAgentPool` cách ly, đóng file handle trên `206`/`416`/abort/sweep, tạm dừng `>30s`, gộp artwork/lyrics, khóa `sourceRevision` FLAC, giải phóng WASM ALAC & đối chiếu PCM `16/24/96` + `EOF moov` | `tests/phase65-resource-lifecycle.test.ts` | **PASS (`2 / 2`)** | `openFileHandlesDelta = 0`, `agentCount = 0` khi ngắt, SHA-256 PCM khớp 100% |
| `TG-P65-BENCHMARK` | Đo đối chứng **Trước (`rc.8`) vs Sau (`rc.9`)** trên **25 kịch bản** tiêu chuẩn | `scripts/benchmark-phase65.ts --phase before/after` | **PASS (`25 / 25`)** | LAN TCP `-64.8%` (`108 -> 38`), Remote TLS `-81.5%` (`108 -> 20`), SQLite writes `-93.9%` (`165 -> 10`), `finalPostShutdownRssMb: 117.38 -> 108.88 MB` |
| `TG-P65-SOAK` | Kiểm thử ổn định liên tục qua 5 giai đoạn tải (`A..E`) kèm giữ luồng **tạm dừng mở `31,5 giây`** rồi phát tiếp | `scripts/soak-phase65.ts --minutes 2.5` -> `qa/logs/phase65-sustained-stability.json` | **PASS (`118.93s`)** | `16.71 MB` đã truyền, `errorCount = 0`, `rssEnd = 94.64 MB`, `heapEnd = 18.54 MB`, `arrayBuffersMb = 0` |
| `TG-PACKAGING-SMOKE-RC9` | Đóng gói `Portable EXE`, `Portable ZIP`, `NSIS Setup`, `win-unpacked`, `SHA256SUMS.txt` + GUI Smoke + 2-Boot Packaged `<audio>` & Power Functional Verification | `electron-builder` + `smoke:electron` + `scripts/verify-packaged-rc9.mjs` | **PASS** | Artifacts tại `release/v1.0.0-rc.9/`, bảo toàn `rc.1`..`rc.8`; thực thi trực tiếp `DoReMi.exe` xác minh Local/Remote `<audio>`, 3 chế độ nguồn điện & lưu bền vững qua khởi động lại |
| `TG-PHYSICAL-COMBINED-UAT` | Nghiệm thu `12` mục ưu tiên nhanh + `72` mục chi tiết Nhóm A–G (gộp rà soát thực địa Phase 6.3–6.5) | `docs/phase-6/PHASE_6.5_WINDOWS_UAT.md` | **PENDING PHYSICAL ENV** | Thực hiện thực địa theo hướng dẫn UAT và sổ `PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md` |
