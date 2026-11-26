# TEST_MATRIX.md — Bản đồ Kiểm thử DoReMi

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Xác minh tự động sau chỉnh sửa code cuối Phase 5.2.1 (`5.2.1A → 5.2.1E`) trên Windows 11 (`win32 x64`, Electron `45.4.1`, Node `v22.12.0`).
- **Source References**: `tests/*.test.ts`, `scripts/*`, `docs/phase-5.2/PHASE_5.2.1_DOCUMENTATION_SYNC_REPORT.md`
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

## 1. Kết quả kiểm thử mới nhất (`Phase 5.2.1 Verification`)

| Group ID | Mô tả & Phạm vi | Lệnh / Files | Trạng thái | Kết quả chi tiết & Bằng chứng |
|---|---|---|---|---|
| `TG-ENV-LINT-SYNC-BUILD` | Environment, TS, Codecs Manifest, User Guide Sync & Build | `doctor` + `lint` + `codecs:verify` + `docs:sync -- --check` + `build` | **PASS** | `doctor`: `0` hard fail; `tsc`: `0` lỗi; `codecs:verify`: `OK`; `docs:sync`: `OK`; `main 336.24 kB`, `preload 11.11 kB`, main JS `675.38 kB` |
| `TG-FULL-ELECTRON` | Toàn bộ **40 tệp** `tests/*.test.ts` (kèm FFmpeg + Foobar2000) | `npm.cmd run test:electron` | **PASS (`189 / 191`)** | `189 PASS, 0 FAIL, 2 SKIP` (`6,252.32 ms`; 2 skip là `Phase 4.5C` OS symlink/junction `EPERM` do sandbox Windows không elevation) |
| `TG-SMOKE-DEV-RC2` | GUI Startup Smoke (Unpacked Dev & Packaged RC2) | `smoke:electron` & `--exe release\v1.0.0-rc.2\win-unpacked\DoReMi.exe` | **PASS** | Cả dev (`packaged=false`) và RC2 (`packaged=true`) đều trả `rootChildren=2, diagLogs=1` |
| `TG-ASAR-ASSETS` | Xác minh bundle `app.asar` & `resources/codecs/` | Node check trên `release/v1.0.0-rc.2/win-unpacked/resources/` | **PASS** | `hasUserGuideChunk=true`, `hasAboutChunk=true`, `hasLibraryBackToTop=true`, `hasAuthor=true`, `codecsDir=manifest.json` |
| `TG-SEC-AUDIT` | Cô lập Codec Engine & Prod CVE Audit | `phase52-security-regression`, `phase521-ui-guide-sync`, `npm audit --omit=dev` | **PASS** | `0` import tĩnh `CodecManager`; `0` lỗ hổng trên 23 prod deps |
| `TG-DESKTOP-UAT` | Nghiệm thu tương tác UI Desktop RC2 bởi người dùng | [`PHASE_5.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md) | **PENDING UAT** | Dùng `qa/DoReMi-QA-Launch.cmd` hoặc `release/v1.0.0-rc.2/DoReMi-1.0.0-rc.2-x64-portable.exe` |
