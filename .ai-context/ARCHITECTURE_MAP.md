# ARCHITECTURE_MAP.md — Bản đồ kiến trúc thực tế DoReMi

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Kiến trúc thực tế **Audio Engine (`RUNTIME_ACTIVE`)**, **Codec Engine (`ISOLATED` + lazy main chunk)**, SQLite schema `v8`, và **Single Source of Truth User Guide / About Runtime Metadata**.
- **Source References**: `src/shared/utils/{audio-codec,app-metadata}.ts`, `src/shared/user-guide/*`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/utils/{animation-policy,scroll-helpers,playlist-validation}.ts`
- **Verification Status**: `VERIFIED_CURRENT`

---

## 1. Phân loại trạng thái tích hợp thực tế
- **Đang hoạt động (`RUNTIME_ACTIVE`)**: Core Electron/SQLite `v1–v8`, `verifyDatabaseIntegrity()`, `RuntimeResilience`, FLAC Sanitizer, `@mgz-dev/alac 0.1.1` WASM + `resolveMp4AudioMetadataOverride`, `AudioDspGraph`, `PlaybackQueueController`, Virtualized Queue & Library (`LibraryBackToTopButton` + toolbar `+ Tạo playlist`), Unified Focus Player (`Focus Vinyl ↔ Standard/Lyrics`), Multiline Radial Lyrics, Global `OverlayHostProvider`, Lazy-loaded `AboutSection` & 15-chapter `UserGuideSection`.
- **Cô lập có chủ đích (`ISOLATED` Backend)**: Toàn bộ Codec Engine (`src/main/services/codec/*`) — `0` static import từ Renderer, `src/main/audio`, `src/main/ipc/register-ipc.ts`, hay `src/main/index.ts`; tách thành lazy chunk `codec-manager-*.js` chỉ nạp khi người dùng bấm kiểm tra tùy chọn trong Settings → Giới thiệu.
- **Kế hoạch sau UAT (`PLANNED`)**: Duyệt nhãn `v1.0.0` Stable & Phase 6 tùy chọn (`PHASE_6_HANDOFF.md`).
