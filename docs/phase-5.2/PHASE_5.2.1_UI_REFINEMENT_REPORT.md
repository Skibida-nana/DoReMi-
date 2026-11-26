# PHASE 5.2.1 — UI/UX REFINEMENT, ABOUT & INTEGRATED USER GUIDE REPORT

- **Project**: DoReMi Desktop (Windows Offline Hi-Res Audio Player) — `kamisamao`
- **Target Version**: `1.0.0-rc.2` (`RELEASE CANDIDATE - PENDING UAT`)
- **Date**: 2026-11-26

---

## 1. Phase 5.2.1A — Library Experience Refinement

### 1.1 Back to Top Button
- **Files created/modified**:
  - [`src/renderer/src/utils/scroll-helpers.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/utils/scroll-helpers.ts)
  - [`src/renderer/src/components/LibraryBackToTopButton.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/components/LibraryBackToTopButton.tsx)
  - [`src/renderer/src/pages/LibraryPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/LibraryPage.tsx)
- **Implementation**:
  - Resolves `<main>` scroll parent dynamically (`findScrollParent`) without altering layout or using `window.scrollTo`.
  - Uses a `passive: true`, `requestAnimationFrame`-throttled scroll listener plus `ResizeObserver` / `contentKey` check; updates React visibility state only when boolean visibility actually changes (`0` re-renders per scroll frame).
  - Adaptive threshold clamped strictly between `420px` and `600px` (`computeBackToTopThresholdPx`), hidden automatically when content fits viewport, near top, or outside Library.
  - Circular `40×40px` (`h-10 w-10`) button positioned `bottom-[114px] right-6 z-[25]` (clear of `MiniPlayer` and strictly underneath `QueueDrawer` / `OverlayPortal` modals), themed with `userAccent.activeHex` / `onAccentText`, `ArrowUp` icon, and tooltip `"Về đầu trang"`. Respects `prefers-reduced-motion` and app `reducedMotion`.

### 1.2 Library Toolbar `+ Tạo playlist`
- **Files created/modified**:
  - [`src/renderer/src/utils/playlist-validation.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/utils/playlist-validation.ts)
  - [`src/renderer/src/components/PlaylistPickerModal.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/components/PlaylistPickerModal.tsx)
  - [`src/renderer/src/pages/LibraryPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/LibraryPage.tsx)
- **Implementation**:
  - Added `+ Tạo playlist` button (`data-testid="library-toolbar-create-playlist-btn"`, `title="Tạo danh sách phát mới"`, `h-9 rounded-full`) at the far right of the second Library toolbar row so it works across **every Library tab** (`Bài hát`, `Album`, `Nghệ sĩ`, `Thư mục`, `Playlist`, `Yêu thích`).
  - Reuses the single `PlaylistPickerModal` + `uiStore.createPlaylist()` + SQLite `playlist-service.ts` pipeline (zero duplicate DB tables or services).
  - Hardened with `submitLockRef` double-click prevention, NFC/NFD Vietnamese case-insensitive duplicate checking, empty/whitespace and `<= 80` char validation, inline error banner on DB/IPC failures, `Esc` shortcut handling, and an explicit `"Thêm N bài hát đang chọn vào playlist mới này"` confirmation checkbox when multi-select is active.

---

## 2. Phase 5.2.1B — Unified Focus Player Layout
- **Files modified**:
  - [`src/renderer/src/utils/animation-policy.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/utils/animation-policy.ts)
  - [`src/renderer/src/components/Sidebar.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/components/Sidebar.tsx)
  - [`src/renderer/src/stores/ui-store.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/ui-store.ts)
- **Root Cause & Fix**:
  - Previously, switching inside `route === 'now-playing'` from `'focus'` (`focus-immediate`) back to `'standard'` (`standard-idle`) triggered a 3-second Sidebar reveal timer and set `nowPlayingSidebarRevealed: true`, shifting `"Quay lại"` +76px right.
  - Preserved `resolveSidebarAutoHideMode` (`'none' | 'standard-idle' | 'focus-immediate'`) for backward compatibility with Phase 4 tests, and added `resolveSidebarRevealedOnTransition()` + `resolveNextNowPlayingModePatch()`. Transitions between `'focus-immediate'` and `'standard-idle'` inside `now-playing` keep the Sidebar hidden uniformly (`revealed: false, scheduleHideMs: null`), while entering from outside (`'none' -> 'standard-idle'`) keeps orientation reveal and leaving (`-> 'none'`) restores fixed Sidebar cleanly. `Alt+M` and 12px left-edge hover remain untouched.

---

## 3. Phase 5.2.1C — About & Developer Identity
- **Files created/modified**:
  - [`src/shared/utils/app-metadata.ts`](file:///G:/Source%20code%20DoReMi/src/shared/utils/app-metadata.ts)
  - [`src/shared/types/library.ts`](file:///G:/Source%20code%20DoReMi/src/shared/types/library.ts), [`src/shared/contracts/channels.ts`](file:///G:/Source%20code%20DoReMi/src/shared/contracts/channels.ts), [`src/shared/types/ipc.ts`](file:///G:/Source%20code%20DoReMi/src/shared/types/ipc.ts)
  - [`src/main/database/connection.ts`](file:///G:/Source%20code%20DoReMi/src/main/database/connection.ts), [`src/main/index.ts`](file:///G:/Source%20code%20DoReMi/src/main/index.ts), [`src/main/ipc/register-ipc.ts`](file:///G:/Source%20code%20DoReMi/src/main/ipc/register-ipc.ts), [`src/preload/index.ts`](file:///G:/Source%20code%20DoReMi/src/preload/index.ts)
  - [`src/renderer/src/features/about/AboutSection.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/features/about/AboutSection.tsx)
- **Implementation**:
  - Lazy-loaded (`AboutSection-DdQr4ATZ.js`, `27.14 kB`) inside `SettingsPage` (`Giới thiệu`).
  - Displays `DoReMi` (`Offline Windows Hi-Res Audio Player`), exact `Designed & Developed by kamisamao` (no unsolicited personal links), Vietnamese story & design values (`"Built with passion. Designed for music lovers."`), dynamic `app.getVersion()`, dynamic `resolveReleaseChannel()`, Electron/Chromium/Node/V8/SQLite `sqlite_version()`/OS/Arch, accurate Audio Engine (`HTMLAudioElement` + `AudioDspGraph`) & Audio Decoder (`Chromium Media Pipeline` + `@mgz-dev/alac 0.1.1` WASM, Isolated Codec Engine with optional on-demand `"Kiểm tra codec cục bộ"` IPC probe lazy-loading `CodecManager` strictly on click), Third-Party Credits aligned with `THIRD_PARTY_NOTICES.md`, and direct button to open User Guide.

---

## 4. Phase 5.2.1D — Integrated Offline User Guide
- **Files created/modified**:
  - [`src/shared/user-guide/guide-types.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-types.ts)
  - [`src/shared/user-guide/guide-content.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-content.ts)
  - [`src/shared/user-guide/guide-search.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-search.ts)
  - [`src/shared/user-guide/guide-markdown.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-markdown.ts)
  - [`src/renderer/src/features/user-guide/UserGuideSection.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/features/user-guide/UserGuideSection.tsx)
  - [`src/renderer/src/pages/SettingsPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/SettingsPage.tsx)
- **Implementation**:
  - Lazy-loaded (`UserGuideSection-mldOnFKx.js`, `37.46 kB`) under Settings → **Hướng dẫn sử dụng** directly above **Giới thiệu**.
  - Covers **15 structured chapters (`01–15`)** verified against real implementation (`Ch 01` Intro → `Ch 15` FAQ/Troubleshooting, explicitly stating `@mgz-dev/alac` WASM, Isolated Codec Engine, real shortcuts `Alt+M`/`Esc`/`Shift+Click`, `+ Tạo playlist`, `Về đầu trang`, and `%APPDATA%\Lossless Player`).
  - Features fast Table of Contents jump, expand/collapse controls, offline Vietnamese accented + unaccented search, and empty-search state.
