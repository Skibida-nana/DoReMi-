# FEATURE_STATUS.md — Trạng thái chức năng DoReMi

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Cập nhật sau hoàn tất Phase 5.2.1 (`5.2.1A → 5.2.1E`).
- **Source References**: `src/main/*`, `src/renderer/src/*`, `src/shared/*`, `docs/`, `qa/*`, `tests/*`
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

| Feature ID | Tên chức năng | Phase | Backend / Logic | Runtime Integration | UI Status | Automated / Smoke Test | User Hardware UAT | Files liên quan & Hạn chế |
|---|---|---|---|---|---|---|---|---|
| `FEAT-521A-LIB-REFINEMENT` | Nút nổi `"Về đầu trang"` + Toolbar `+ Tạo playlist` mọi tab Library | Phase 5.2.1A | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` | `PASSED` (`phase521-ui-guide-sync`, ASAR verified) | `PENDING_USER_UAT` | `LibraryBackToTopButton.tsx`, `scroll-helpers.ts`, `PlaylistPickerModal.tsx`, `playlist-validation.ts`, `LibraryPage.tsx` |
| `FEAT-521B-FOCUS-SIDEBAR` | Đồng nhất ẩn Sidebar khi chuyển `Focus Vinyl ↔ Standard/Lyrics` | Phase 5.2.1B | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` | `PASSED` (`phase521-ui-guide-sync`, Phase 4 tests preserved) | `PENDING_USER_UAT` | `animation-policy.ts`, `Sidebar.tsx`, `ui-store.ts` |
| `FEAT-521C-ABOUT-IDENTITY` | Trang `Giới thiệu` (`kamisamao`, câu chuyện, runtime/SQLite/decoder info, optional probe) | Phase 5.2.1C | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` (`React.lazy`) | `PASSED` (`phase521-ui-guide-sync`, ASAR verified) | `PENDING_USER_UAT` | `AboutSection.tsx`, `app-metadata.ts`, `connection.ts`, `register-ipc.ts` |
| `FEAT-521D-USER-GUIDE` | Hướng dẫn sử dụng 15 chương offline + search tiếng Việt đồng bộ `docs/USER_GUIDE.md` | Phase 5.2.1D | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` (`React.lazy`) | `PASSED` (`docs:sync -- --check`, `phase521-ui-guide-sync`, ASAR verified) | `PENDING_USER_UAT` | `src/shared/user-guide/*`, `UserGuideSection.tsx`, `SettingsPage.tsx`, `scripts/sync-user-guide.mjs` |
| `FEAT-STAB-RESILIENCE` | Global Exception Handlers, Crash Log Rotation (`<=512KB`), Renderer Recovery & React `AppErrorBoundary` | Phase 5.2A | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` | `PASSED` (`phase52-stability-integrity`, `smoke:electron`) | `PENDING_USER_UAT` | `main/index.ts`, `runtime-resilience.ts`, `AppErrorBoundary.tsx`, `App.tsx` |
| `FEAT-DATA-INTEGRITY` | Startup `PRAGMA integrity_check` + `foreign_key_check`, Exit WAL Checkpoint, SQLite Online `db.backup()` | Phase 5.2B | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `CORE_READY` | `PASSED` (`phase52-stability-integrity`) | `PENDING_USER_UAT` | `database/integrity.ts`, `database/connection.ts` |
| `FEAT-SEC-PRIVACY` | `sandbox:true`, `contextIsolation:true`, CSP, Protocol UUID Guard, IPC/CLI Validators, `0` Network/Telemetry, `0` Prod CVEs | Phase 5.2C | `IMPLEMENTED_TESTED` | `RUNTIME_ACTIVE` | `INTEGRATED` | `PASSED` (`phase52-security-regression`, `npm audit --omit=dev`) | `PENDING_USER_UAT` | `main-window.ts`, `media-protocol.ts`, `validators.ts`, `cli-audio-args.ts` |
| `FEAT-CODEC-ISOLATION-MATRIX` | Cô lập `0` UI imports + Lazy On-demand About probe | Phase 4.5.1 / 5.2.1C | `IMPLEMENTED_TESTED` | `ISOLATED` | `OPTIONAL_PROBE_ONLY` | `PASSED` (`codec-real-integration`, `phase521-ui-guide-sync`) | `PENDING_USER_UAT` | `src/main/services/codec/*`, `out/main/chunks/codec-manager-*.js` |
| `FEAT-WIN-RC2-QA` | Đóng gói `v1.0.0-rc.2` tách biệt (`Portable EXE/ZIP`, `NSIS Setup`, `SHA256SUMS.txt`) + Bộ 4 `qa/*.cmd` | Phase 5.2.1E | `IMPLEMENTED_TESTED` | `PACKAGED` | `N/A` | `PASSED` (Packaged `smoke:electron`, ASAR check) | `PENDING_USER_UAT` | `release/v1.0.0-rc.2/*`, `qa/*.cmd`, `docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md` |
