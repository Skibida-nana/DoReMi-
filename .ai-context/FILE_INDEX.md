# FILE_INDEX.md — Bản đồ điều hướng Source Code DoReMi

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Hoàn tất Phase 5.1, Phase 5.2 & Phase 5.2.1 (`v1.0.0-rc.2`).
- **Source References**: `src/`, `qa/`, `scripts/`, `tests/`, `docs/`, `RELEASE_NOTES.md`, `CHANGELOG.md`, `PHASE_6_HANDOFF.md`
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

## 1. Main Lifecycle, Resilience, Runtime Info & Packaging
- **`src/main/index.ts`**, **`src/main/utils/runtime-resilience.ts`**: Global `uncaughtException`, `unhandledRejection`, `render-process-gone` (`15s` cooldown), `child-process-gone`, bounded `logs/main-crash.log` (`<= 512 KB`), strict production CSP, `%APPDATA%\Lossless Player` (`src/main/utils/user-data-path.ts`).
- **`src/main/windows/main-window.ts`**: Hardened `BrowserWindow` (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `setWindowOpenHandler`, `will-navigate`).
- **`src/main/ipc/register-ipc.ts`**, **`src/main/ipc/validators.ts`**, **`src/preload/index.ts`**: Strict UUID validation, dynamic `AppRuntimeInfo` (incl. `sqliteVersion`, `chromeVersion`, `nodeVersion`, `v8Version`, `releaseChannel`), optional on-demand lazy `APP_PROBE_CODECS`, CLI audio args sanitizer.

## 2. Database, Data Integrity & Offline Services
- **`src/main/database/connection.ts`**, **`src/main/database/integrity.ts`**, **`src/main/database/migrations.ts`** (`v1–v8`): WAL + FK, `sqliteVersion` query on open, `verifyDatabaseIntegrity()`, exit `wal_checkpoint(PASSIVE)`, SQLite Online Backup.
- **`src/main/services/*`**: `library-service.ts`, `artwork-service.ts`, `audio-stream-handler.ts`, `alac-decoder.ts` (`@mgz-dev/alac 0.1.1`), `profile-service.ts`, `lyrics-service.ts`, `playlist-service.ts`, `statistics-service.ts`, `diagnostics-service.ts`.
- **`src/main/services/codec/*`**: Isolated Codec Engine (`0` startup/UI imports; split to lazy main chunk `codec-manager-*.js` if requested via optional About probe).

## 3. Shared Metadata & Integrated User Guide (`src/shared/`)
- **`src/shared/utils/app-metadata.ts`**: `resolveReleaseChannel()`, `DOREMI_DEVELOPER_HANDLE = 'kamisamao'`, `DOREMI_DESIGN_SLOGAN`.
- **`src/shared/user-guide/{guide-types,guide-content,guide-search,guide-markdown}.ts`**: Single Source of Truth for 15 User Guide chapters, Vietnamese accent-aware & unaccented search, Markdown renderer (`docs/USER_GUIDE.md`).

## 4. Renderer UI, Refinement & Optimization
- **`src/renderer/src/app/App.tsx`**, **`AppErrorBoundary.tsx`**: Lazy route splitting + view-level error isolation preserving `MiniPlayer`.
- **`src/renderer/src/pages/LibraryPage.tsx`**, **`components/LibraryBackToTopButton.tsx`**, **`utils/scroll-helpers.ts`**, **`components/PlaylistPickerModal.tsx`**, **`utils/playlist-validation.ts`**: Back to Top (`ArrowUp`), toolbar `+ Tạo playlist` across tabs, NFC duplicate & selection confirmation.
- **`src/renderer/src/components/Sidebar.tsx`**, **`utils/animation-policy.ts`**, **`stores/ui-store.ts`**: Unified Focus Player sidebar auto-hide (`resolveSidebarRevealedOnTransition`).
- **`src/renderer/src/pages/SettingsPage.tsx`**, **`features/about/AboutSection.tsx`**, **`features/user-guide/UserGuideSection.tsx`**: Lazy-loaded `Giới thiệu` & `Hướng dẫn sử dụng` sections.
- **Protected Audio & Core Views**: `audio-engine.ts`, `audio-dsp.ts`, `player-store.ts`, `playback-queue.ts`, `NowPlayingPage.tsx`, `AudioLabPage.tsx`, `HomePage.tsx`.

## 5. Tests, Scripts & QA Launchers
- **Tests Phase 5.2.1**: `tests/phase521-ui-guide-sync.test.ts` (total 40 test files, `191` test cases).
- **Sync & Verification Scripts**: `scripts/sync-user-guide.mjs` (`npm run docs:sync`), `doctor.mjs`, `verify-codecs.mjs`, `verify-build.mjs`, `smoke-electron.mjs`, `run-tests-electron.mjs`.
- **One-Click QA & Release**: `qa/DoReMi-QA-*.cmd`, `docs/USER_GUIDE.md`, `docs/phase-5.2/PHASE_5.2.1_*_REPORT.md`, `release/v1.0.0-rc.2/*` (preserving `release/v1.0.0-rc.1/*`).
