# DOREMI — PHASE 5.2: IMPLEMENTATION PLAN (`5.2A → 5.2H`)

**Mục tiêu tổng thể**: Hoàn thiện độ ổn định, toàn vẹn dữ liệu, bảo mật/riêng tư offline, kiểm thử hồi quy & chịu tải cho **DoReMi Windows Music Player Standalone**, tiến tới bản **Release Candidate (`1.0.0-rc.1`, trạng thái `RELEASE CANDIDATE - PENDING UAT`)** mà không viết lại UI/Playback hoặc mở rộng sang Phase 6 Server.

---

## Lộ trình tuần tự & Quality Gates

1. **Phase 5.2A — Stability Engineering**:
   - Bổ sung lifecycle & exception hardening trong `src/main/index.ts` + helper tái sử dụng: `uncaughtException`, `unhandledRejection`, `webContents` `render-process-gone`, `app` `child-process-gone` / `gpu-info-update`.
   - Rà soát missing files / offline storage / corrupt tags / decode fallback / timer & listener cleanup.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2A_STABILITY_REPORT.md`.

2. **Phase 5.2B — Data Integrity & Recovery**:
   - Bổ sung `verifyDatabaseIntegrity(db)` (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`) và `createDatabaseSnapshotBackup(db, destinationPath)` dùng SQLite Online Backup API (`better-sqlite3` `.backup()`), an toàn với WAL và Unicode path.
   - Đảm bảo kiểm tra & lưu vết integrity khi khởi động/smoke, xác minh `pruneOrphanedMediaFiles()`, cache invalidation khi sửa/xóa artwork/lyrics/override/playlist, và `userData` (`%APPDATA%\Lossless Player`).
   - Tài liệu: `docs/phase-5.2/PHASE_5.2B_DATA_INTEGRITY_REPORT.md`.
   - **Quality Gate A**: `npm run lint` + `npm run test:electron` (bao gồm `tests/phase52-stability-integrity.test.ts`).

3. **Phase 5.2C — Security & Privacy Hardening**:
   - Kiểm tra đầy đủ cấu hình `BrowserWindow`, CSP, `setWindowOpenHandler`, `will-navigate`, `lossless-media://` protocol & range parsing, IPC validators (`MAX_BATCH_IDS`, path traversal, untrusted media/LRC/avatar size limits), Codec Engine `shell:false` & Trust Policy, `npm audit` report, xác minh `0` kết nối mạng.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2C_SECURITY_PRIVACY_REPORT.md`.

4. **Phase 5.2D — Full Regression Testing**:
   - Bổ sung bộ test hồi quy toàn diện `tests/phase52-security-regression.test.ts` phủ playback/queue/shuffle, audio fidelity (FLAC, 24-bit ALAC), Library virtualization boundaries (`0, 1, 24, 79, 80, 81, 100, 500, 1000, 5000, 50000`) & repeated navigation clamping / `useWindowedListSlice` truth table, Unicode NFC/Vietnamese/CJK search & lyrics, themes/custom fonts/background/profile.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2D_REGRESSION_REPORT.md`.
   - **Quality Gate B**: `npm run lint` + `npm run test:electron` (`0` fail) + `npm run codecs:verify`.

5. **Phase 5.2E — Hardware Compatibility & Final Resource Optimization**:
   - Đo chi phí bộ nhớ & hit-rate thực tế của `vietnamese-search.ts` (`65_536` cache entries vs `16_384`), tài liệu hóa thống nhất sự thật code vs docs.
   - Audit resource footprint idle/load, GPU blur backdrop toggle, lazy loading Codec Engine, laptop 8GB RAM compatibility.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2E_HARDWARE_RESOURCE_REPORT.md`.

6. **Phase 5.2F — Stress Testing & Final Benchmark**:
   - Tạo `scripts/stress-benchmark-phase52.ts` & `scripts/run-stress-phase52.mjs` (tái lập trên temp dir):
     - Steady-state rescan benchmark (`Before/Non-fast-path` vs `After` khi `file_name` đã đủ) + quét song song `VERIFY_CONCURRENCY = 2, 4, 8, 16`.
     - Scale `100 → 50,000` tracks, repeated queue/shuffle/navigation stress loops, leak check heap/handles sau settle.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2F_STRESS_TEST_REPORT.md` & `docs/phase-5.2/PHASE_5.2_FINAL_BENCHMARK.md`.
   - **Quality Gate C**: Hoàn tất benchmark & kiểm thử chịu tải sạch, `0` regression.

7. **Phase 5.2G — Windows Build & Packaging**:
   - Kiểm tra cấu hình `electron-builder`, dependency & license inventory (`THIRD_PARTY_NOTICES.md`), tối ưu artifact sạch.
   - Đóng gói Release Candidate (`1.0.0-rc.1`) vào thư mục tách biệt `release/v1.0.0-rc.1/` (Portable EXE, Portable ZIP, NSIS Setup EXE + `SHA256SUMS.txt`), **không ghi đè** `release/DoReMi-0.1.0-x64-portable.exe`.
   - Chạy `npm run verify:build`, `npm run smoke:electron` (cả unpack lẫn packaged `.exe`), `npm run codecs:verify`.
   - Tài liệu: `docs/phase-5.2/PHASE_5.2G_BUILD_PACKAGING_REPORT.md`.
   - **Quality Gate D**: Build & smoke packaged app thành công, `SHA256SUMS.txt` khớp hoàn toàn.

8. **Phase 5.2H — Release Candidate, One-Click QA Launchers, Docs & Handoff**:
   - Tạo bộ One-Click QA launchers trong `qa/` (`DoReMi-QA-Launch.cmd`, `DoReMi-QA-SmokeTest.cmd`, `DoReMi-QA-Performance.cmd`, `DoReMi-QA-SoakTest.cmd`), tự động giải quyết `PATH` và cô lập `userData` sang `%TEMP%` khi test.
   - Xuất tài liệu phát hành (`RELEASE_NOTES.md`, `CHANGELOG.md`, `SYSTEM_REQUIREMENTS.md`, `WINDOWS_INSTALLATION_GUIDE.md`, `USER_DATA_AND_BACKUP.md`, `THIRD_PARTY_NOTICES.md`, `PHASE_6_HANDOFF.md`) và bộ báo cáo `docs/phase-5.2/PHASE_5.2{H_RELEASE_REPORT,_WINDOWS_UAT,_KNOWN_ISSUES,_FINAL_REPORT}.md`.
   - Cập nhật `.ai-context/*` nhất quán.
   - **Quality Gate E**: Toàn bộ kiểm tra sau edit cuối PASS, trạng thái phát hành trung thực `RELEASE CANDIDATE - PENDING UAT`.
