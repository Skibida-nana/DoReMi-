# KNOWN_ISSUES.md — Theo dõi lỗi, Tồn đọng & Chống Regression

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Toàn bộ Phase 5.1, Phase 5.2 & Phase 5.2.1 trên Windows (`win32 x64`, Electron `45.4.1`).
- **Source References**: `docs/phase-5.2/PHASE_5.2_KNOWN_ISSUES.md`, `docs/phase-5.2/PHASE_5.2.1_DOCUMENTATION_SYNC_REPORT.md`
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

## 1. Trạng thái các vấn đề / quan sát hiện tại (`OBS-*` / `ISS-OPEN-*`)

| Issue ID | Mô tả & Root Cause | Status | Files / Phạm vi | Hướng xử lý tiếp theo |
|---|---|---|---|---|
| `OBS-51-01` | Sự cố double-click điều hướng `Library` thoáng gặp cuối Phase 5.1 (không tái hiện lại được). | `INTERMITTENT - NOT REPRODUCED` | `LibraryPage.tsx`, `use-windowed-slice.ts`, `queue-virtualization.ts` | Giữ nguyên trạng thái theo nguyên tắc trung thực; đã có test clamping biên `0..50,000`. |
| `ISS-OPEN-03` | `resources/codecs/` chỉ giữ `manifest.json` (`expectedSha256: null`), không bundle nhị phân bên thứ ba để bảo đảm tuân thủ bản quyền GPL/LGPL/Proprietary. | `BY_DESIGN` | `resources/codecs/manifest.json`, `scripts/verify-codecs.mjs`, `THIRD_PARTY_NOTICES.md` | Trung thực hiển thị `Isolated` trong `Giới thiệu` & `Hướng dẫn sử dụng`; hỗ trợ kiểm tra on-demand tùy chọn. |
| `ISS-OPEN-07` | Host Node `v22.12.0` (`N-API 9`) không load được `better-sqlite3@13.2.0` (`N-API 10`); đã có preflight guard. | `MITIGATED` | `scripts/run-tests-node.mjs`, `package.json` | Luôn dùng `npm.cmd run test:electron`. |
| `ISS-OPEN-ENV-SYMLINK` | Trong môi trường sandbox Windows không elevation, 2 bài test tạo kernel symlink/junction (`Phase 4.5C`) tự động `SKIP` do `EPERM` (test mô phỏng `FsPathSafetyOps` vẫn chạy PASS). | `PLATFORM_ENV_SKIP` | `tests/phase45-codec-security.test.ts` | Có thể chạy không giới hạn quyền tạo symlink nếu cần xác nhận kernel OS link trực tiếp. |
| `ISS-IPC-BACKUP-UI` | Lõi WAL-safe `createDatabaseSnapshotBackup` & `restoreDatabaseBackupSafely` đã hoàn chỉnh; chưa gắn UI Backup/Restore mới trong Settings để giữ gọn phạm vi RC. | `CORE_READY / UI_DEFERRED` | `src/main/database/integrity.ts`, `USER_DATA_AND_BACKUP.md` | Bổ sung UI Settings ở bản bảo trì hoặc Phase 6 nếu user yêu cầu. |
| `ISS-UAT-GUI` | Cần người dùng kiểm thử trực quan các bổ sung Phase 5.2.1 & vận hành thực tế trên Windows qua `v1.0.0-rc.2`. | `PENDING_USER_UAT` | `release/v1.0.0-rc.2/*`, `qa/*.cmd`, `docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md` | User mở `qa/DoReMi-QA-Launch.cmd` / `DoReMi-1.0.0-rc.2-x64-portable.exe` và xác nhận. |

---

## 2. Lỗi đã khắc phục ở Phase 5.2 & 5.2.1 *(Cấm regression)*

| Issue ID | Hạng mục & Vấn đề gốc | Fix Summary | Bằng chứng & Tests | Phase |
|---|---|---|---|---|
| `ISS-FIX-521B` | Chuyển `Focus Vinyl -> Standard/Lyrics` làm Sidebar bật lại 3s (`standard-idle`) và dịch nút `"Quay lại"` +76px sang phải. | Thêm `resolveSidebarRevealedOnTransition()` + `resolveNextNowPlayingModePatch()` giữ Sidebar ẩn đồng nhất trong `now-playing`, chỉ khôi phục khi rời trang player. | `tests/phase521-ui-guide-sync.test.ts` | Phase 5.2.1B |
| `ISS-FIX-52A` | Thiếu handler `uncaughtException`, `unhandledRejection`, `render-process-gone`, `child-process-gone` và React ErrorBoundary. | Bổ sung `runtime-resilience.ts` + `main/index.ts` + `AppErrorBoundary.tsx`. | `tests/phase52-stability-integrity.test.ts`, `smoke:electron` | Phase 5.2A |
| `ISS-FIX-52B` | Chưa kiểm `PRAGMA integrity_check` / `foreign_key_check` khi mở DB và chưa có SQLite Online Backup. | Bổ sung `database/integrity.ts`, `verifyDatabaseIntegrity()`, `wal_checkpoint(PASSIVE)`. | `tests/phase52-stability-integrity.test.ts` | Phase 5.2B |
| `ISS-FIX-52D` | `computeQueueWindowSlice()` chưa kẹp `scrollOffsetPx <= maxScrollPx` khi danh sách thu hẹp. | Kẹp `clampedScroll <= maxScrollPx` và `startIndex <= endIndex`. | `tests/phase52-security-regression.test.ts` | Phase 5.2D |
