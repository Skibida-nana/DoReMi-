# PROJECT_CONTEXT.md — Tổng quan dự án DoReMi

- **Last Updated**: 2026-11-25T15:20:00+07:00
- **Last Verified Checkpoint**: `PHASE-4-ADAPTIVE-EDITORIAL-UI-20261125`
- **Verification Scope**: Cập nhật sau hoàn tất triển khai & kiểm chứng tự động Phase 4 (`4A`–`4N`).
- **Source References**: `package.json`, `DOREMI_CORE_PRINCIPLES.md`, `electron-builder.yml`, `.github/workflows/build-windows.yml`, `scripts/*`
- **Verification Status**: `IMPLEMENTED_AWAITING_USER_UAT`

---

## 1. Định danh & Tầm nhìn
- **Project Name**: **DoReMi** (`package.json` name: `lossless-player`, `electron-builder.yml` productName: `DoReMi`, version: `0.1.0`)
- **Project Purpose**: Ứng dụng nghe nhạc lossless cá nhân chạy **100% cục bộ và offline trên Windows**, giàu khả năng cá nhân hóa, không quảng cáo, không subscription, không paywall, không bắt buộc đăng nhập hay server.
- **Development Philosophy**:
  - **Music Player First**: Trình phát nhạc là trung tâm; Native Codec Engine, Converter, Analyzer chỉ là công cụ phụ trợ tùy chọn.
  - **Audio Quality First**: Bảo toàn nguyên bản bit depth, sample rate, số kênh; minh bạch kỹ thuật tuyệt đối (không giả `Bit-Perfect` hay `verified-lossless`).
  - **Personalization First & Progressive Disclosure**: Giữ thẩm mỹ Home, Editorial Gallery 7 thẻ, Typography, Themes, Custom Fonts/Background; UI cơ bản gọn nhẹ, tùy chọn sâu ẩn trong tầng nâng cao.
  - **Offline First & Privacy First**: Mọi thư viện SQLite, artwork cache, lyrics, profile, thống kê lưu cục bộ tại `userData` (`Lossless Player` legacy dir được giữ nguyên khi đóng gói qua `src/main/utils/user-data-path.ts`).

## 2. Hệ điều hành & Phần cứng mục tiêu *(Mục tiêu thiết kế & kiểm thử — chưa benchmark)*
- **Target OS**: Windows 10/11 64-bit (`x64`), không cần cài sẵn Node.js hay công cụ ngoài ở bản phát hành.
- **Target Hardware**: Laptop Intel Core U / AMD Ryzen U tiết kiệm điện, RAM 8GB DDR4, GPU tích hợp (iGPU), SSD hoặc HDD, dùng pin thường xuyên, không phụ thuộc GPU rời.
- **Resource Discipline**: Lazy initialization cho Codec Engine, `concurrency = 1` mặc định (`Power Saving`), streaming hash/I/O giới hạn RAM, ưu tiên tuyệt đối cho luồng phát nhạc.

## 3. Technology Stack & Môi trường
- **Runtime**: Electron `^45.4.1`, React `^19.0.1`, TypeScript `^7.0.2` (`strict: true`, `noEmit`), Vite `^8.3.0`, `electron-vite ^6.0.0`, Tailwind CSS `^4.3.3` (`@tailwindcss/vite`).
- **Local Data & Audio**: `better-sqlite3 ^13.2.0` (WAL + `foreign_keys = ON`), `music-metadata ^12.8.0`, `@mgz-dev/alac ^0.1.1` (built-in ALAC WASM), `@fontsource/poppins ^5.3.0`, `lucide-react ^0.546.0`.
- **Testing System**: Node.js built-in test runner qua `tsx --test tests/*.test.ts` (`npm test`, không có framework test ngoài).
- **Build & Packaging System**:
  - `electron-vite build` xuất ra `out/main/index.js`, `out/preload/index.cjs` (CJS sandboxed), `out/renderer/index.html`.
  - `vite --config vite.config.ts` dùng cho Web Preview UI trên cổng 3000 (chạy qua `scripts/dev.mjs` khi headless Linux hoặc truyền `--port`/`--host`).
  - `electron-builder.yml` đóng gói `release/` gồm NSIS Setup EXE + Portable ZIP (`asar: true`, `asarUnpack: node_modules/better-sqlite3/**`, `publish: null`).
  - `.github/workflows/build-windows.yml` hỗ trợ `workflow_dispatch` build Windows x64 + smoke-test `better-sqlite3` trong `DoReMi.exe`.

## 4. Roadmap chính thức (không nhầm với Phase 8 lịch sử của Library Management)
- **Phase 01**: Recovery & Source Code Audit — *Completed*
- **Phase 02**: Music Player First & Core Development Principles — *Completed*
- **Phase 03A**: Codec Manager, Security & Registry — *Completed (báo cáo Phase 03)*
- **Phase 03B**: Audio Quality, Processing Stability & Resource Management — *Completed (báo cáo Phase 03)*
- **Phase 03.5**: AI Project Memory & Context Optimization — *Completed*
- **Phase 1 (Stabilization — 1A..1E)**: Build Stability, Audio Compatibility, Diagnostics/Unicode, Windows Packaging & Regression — *Completed (`PHASE-1-UAT-STABLE-BASELINE-20261125`)*
- **Phase 2 (`2A..2G`)**: Unified Playback Controls, Shuffle, Repeat, Auto Next & Queue Management — *Completed*
- **Phase 3 (`3A..3L`)**: Library Management, SQLite Playlists, Data Integrity, Folder View & Transport Layout Sample 2 (`once`/`twice` Repeat) — *Code Complete, Pending GUI UAT (`PHASE-3-LIBRARY-PLAYLIST-REPLAY-20261125`)*
- **Phase 4 (`4A..4N`)**: Adaptive Artwork Design, Dual-Tone Editorial Now Playing (Ref B), Radial Minimalist Focus Vinyl (Ref A), Bidirectional Transition, Global Vietnamese/CJK Typography & UI Polish — *Implemented — Awaiting User UAT (`PHASE-4-ADAPTIVE-EDITORIAL-UI-20261125`)*
- **Phase 05**: Testing, Packaging & Personal Stable Release *(bản **DoReMi Personal Edition** ổn định cho Windows trước khi làm Server Connection)*
- **Phase 06**: Personal Server Connection *(tùy chọn, sau khi bản cá nhân ổn định)*
- **Phase 07**: Advanced Listening Experience
- **Phase 08**: Comprehensive Performance Optimization *(khác với Phase 8 lịch sử của tính năng Library Management)*
- **Phase 09**: Final Release

## 5. Giới hạn hiện tại
- Codec Engine & Default Encoder Pack chưa nối IPC/Preload/UI và chưa có binary Windows thật trong `resources/codecs/`.
- Các kiểm thử desktop Windows thật (`Pending Desktop Verification`) và benchmark laptop dòng U chưa thực hiện trong môi trường sandbox.
- Hệ thống Project Memory (`AGENTS.md`, `.ai-context/*`) chỉ phục vụ phát triển, **không được ứng dụng đọc khi chạy**.
