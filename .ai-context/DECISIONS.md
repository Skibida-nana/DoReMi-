# DECISIONS.md — Bộ nhớ Quyết định Kỹ thuật (ADR)

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Bổ sung `ADR-041` cho Phase 5.2.1 (`5.2.1A–E`), bảo toàn `ADR-001..040`, Audio Engine, SQLite integrity, Codec isolation và UI baseline.
- **Source References**: `src/renderer/src/components/{LibraryBackToTopButton,PlaylistPickerModal,Sidebar}.tsx`, `src/renderer/src/features/{about/AboutSection,user-guide/UserGuideSection}.tsx`, `src/shared/user-guide/*`, `scripts/sync-user-guide.mjs`
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

| ID | Tiêu đề | Quyết định & Lý do | Hệ quả & Phạm vi | Status / Phase |
|---|---|---|---|---|
| `ADR-001..040` | *(Kế thừa từ Phase 02–Phase 5.2)* | Music Player First, Offline First, SQLite WAL + `PRAGMA integrity_check` + `db.backup()`, Runtime Resilience, AudioDspGraph & ALAC WASM, Phase 4.4 Editorial/Focus UI, Codec Engine Isolation (`shell: false`, PE/Trust checks, real encoders), `0` network/telemetry. | Giữ nguyên hiệu lực 100%. | `ACTIVE` |
| `ADR-041` | **Unified Focus Sidebar Transition, Single-Source Offline User Guide, Truthful About Runtime Info & Library Toolbar Refinements** | **(1) Library Refinements (`5.2.1A`)**: Dùng `<main>` scroll container passive rAF listener (`LibraryBackToTopButton`) với ngưỡng adaptive `420–600px` (`prefers-reduced-motion` compliant) và đặt nút `+ Tạo playlist` trên toolbar mọi tab, tái sử dụng `PlaylistPickerModal` + `playlist-validation.ts`. **(2) Unified Focus Sidebar (`5.2.1B`)**: Giữ nguyên `resolveSidebarAutoHideMode()` và bổ sung `resolveSidebarRevealedOnTransition()` để chuyển `Focus Vinyl ↔ Standard/Lyrics` không bật lại Sidebar 3s. **(3) Truthful About & Optional Codec Probe (`5.2.1C`)**: Hiển thị `kamisamao`, `app.getVersion()` động, `sqlite_version()`, Chromium + `@mgz-dev/alac 0.1.1`; cô lập `CodecManager` qua dynamic `import()` chỉ chạy khi user click kiểm tra thủ công. **(4) Integrated Guide Sync (`5.2.1D–E`)**: 15 chương chia sẻ duy nhất giữa `UserGuideSection.tsx` (lazy) và `docs/USER_GUIDE.md` qua `scripts/sync-user-guide.mjs`. | Hoàn thiện RC2 `v1.0.0-rc.2` (`675.38 kB` main renderer, `189/191` test PASS, `0` FAIL, `0` prod CVEs) sẵn sàng Windows UAT. | `ACTIVE` (Phase 5.2.1) |
