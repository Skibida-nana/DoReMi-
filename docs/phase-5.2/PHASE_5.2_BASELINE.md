# DOREMI — PHASE 5.2: BASELINE REPORT

**Thời điểm lập Baseline**: `2026-11-26T03:24+07:00`  
**Môi trường đo kiểm thực tế**:
- **OS / Arch**: Windows 11 Pro `10.0.26200` (`win32 x64`)
- **CPU**: `Intel(R) Core(TM) i5-14600K` (`20` logical threads)
- **RAM**: `31.65 GB`
- **Node.js (Host)**: `v22.12.0` (`modules=127`, `napi=9`)
- **Electron Runtime**: `45.4.1` (`N-API 10`, `better-sqlite3@13.2.0`)
- **External Test Binaries**: FFmpeg/FFprobe (`2026-11-23-git-05c674c913-full_build`), Foobar2000 Encoders (`G:\Soure app\foobar2000\encoders`)
- **Git / Backup Baseline**: Không có `.git`; đã sao lưu toàn bộ source trước Phase 5.2 tại `C:\Users\Admin\.gemini\antigravity\brain\35f21e1e-f014-4295-b49e-34dfb9c533c0\scratch\backup-PHASE-5.2-PRE-HOTFIX`. Bản Portable Phase 5.1 (`release\DoReMi-0.1.0-x64-portable.exe`, `121,831,133` bytes) được giữ nguyên làm bản dự phòng.

---

## 1. Baseline Checks (Sau Phase 5.1, trước chỉnh sửa Phase 5.2)

| Hạng mục | Lệnh | Kết quả thực tế | Ghi chú |
|---|---|---|---|
| TypeScript Check | `npm run lint` (`tsc --noEmit`) | **PASS** (`0` errors) | Sạch |
| Environment Doctor | `npm run doctor` | **PASS** (`0` hard failures, `2` warnings) | Cảnh báo dự kiến do host Node `v22.12.0` N-API 9 < 10 |
| Automated Test Suite | `npm run test:electron` (với `FFMPEG_PATH` + `DOREMI_REAL_CODECS_DIR`) | **178 tests: 178 PASS, 0 FAIL, 0 SKIP** (`4,962.50 ms`) | Bao gồm real FFmpeg + native encoder pack |
| Codec Verification | `npm run codecs:verify` | **OK** (`manifest.json` verified) | Không nhúng binary codec vào `resources/codecs/` |
| Electron GUI Smoke | `npm run smoke:electron` | **PASS** (`packaged=false, electron=45.4.1, rootChildren=2, diagLogs=1`) | Chạy sạch trên Windows |
| Dependency Audit (Prod) | `npm audit --omit=dev --json` | **0 vulnerabilities** (`23` prod deps) | — |
| Dependency Audit (All) | `npm audit --json` | **6 moderate** (`0` high, `0` critical) | Chỉ nằm trong chuỗi devDependency `electron-builder` |

---

## 2. Observation Log (Phase 5.1 Double-Click Library Nav)

- Theo chỉ dẫn Phase 5.2 §4: lỗi thoáng gặp khi double-click điều hướng sang `Library` ở cuối Phase 5.1 **chưa tái hiện lại được** và hiện không còn xuất hiện trong điều kiện bình thường.
- **Trạng thái ghi nhận**: `INTERMITTENT - NOT REPRODUCED`.
- **Nguyên tắc xử lý**: Không tạo hotfix đoán mò hoặc viết lại router/virtualization/scroll restoration khi chưa có bằng chứng code hoặc tái hiện; đưa kịch bản lặp điều hướng + biên ngưỡng (`0, 1, 24, 79, 80, 81, 100, 500, 1000, 5000, 50000`) vào bộ kiểm thử hồi quy Phase 5.2D để xác minh thực nghiệm.

---

## 3. Baseline Discrepancies & Hardening Gaps Cần Xử Lý Trong Phase 5.2

| # | Phát hiện (Source Evidence) | Phân loại | Kế hoạch xử lý |
|---|---|---|---|
| 1 | Chưa có global `uncaughtException` / `unhandledRejection` / `render-process-gone` / `child-process-gone` handlers tập trung trong Main process | **5.2A Stability** | Bổ sung handler an toàn, ghi Diagnostics + crash report cục bộ, khôi phục cửa sổ / cảnh báo không làm treo im lặng |
| 2 | Chưa có SQLite `PRAGMA integrity_check` / `foreign_key_check` & online WAL-safe backup utility (`db.backup()`) | **5.2B Integrity** | Bổ sung `verifyDatabaseIntegrity()` + `backupDatabaseSafely()` + kiểm thử crash/reopen/corruption isolation |
| 3 | Cần audit & regression test cho `BrowserWindow` hardening, CSP, IPC validators, LRC/metadata limits, codec `shell:false`, privacy offline | **5.2C Security** | Kiểm tra thực tế + test tự động chặn URL/scheme/traversal/oversized payload |
| 4 | Mâu thuẫn số liệu tài liệu Phase 5.1 (`16,384` vs `65,536` trong `vietnamese-search.ts`; `rescanLibrary` `2,514.14 ms` có legacy backfill `file_name = NULL`; chưa đo `VERIFY_CONCURRENCY = 2/4/8/16`) | **5.2E / 5.2F** | Đo bộ nhớ & hit-rate thực tế của LRU cache, benchmark steady-state Before vs After và quét song song `2/4/8/16` |
| 5 | Cần gói phát hành `v1.0.0-rc.1` tách biệt (`release/v1.0.0-rc.1/`), `SHA256SUMS.txt`, One-Click QA `.cmd` launchers và tài liệu UAT/Handoff | **5.2G / 5.2H** | Đóng gói Portable EXE, Portable ZIP, NSIS Setup EXE không ghi đè bản Phase 5.1 |
