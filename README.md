# DoReMi Desktop (Windows) — Offline Hi-Res Audio Player

**Designed & Developed by `kamisamao`** · **Version**: `1.0.0-rc.9` (`RELEASE CANDIDATE - PENDING UAT`)

Ứng dụng nghe nhạc Lossless & Hi-Res chạy **100% cục bộ và offline trên Windows PC**, xây dựng bằng **Electron + React + TypeScript + electron-vite + SQLite (`better-sqlite3`) + `@mgz-dev/alac` + `music-metadata` + `electron-builder`**.

- **Offline First & Zero Telemetry**: Không dùng cloud, không đăng nhập, không API Internet, không telemetry, không auto-updater.
- **Audio Integrity First**: Giữ nguyên bit depth / sample rate / số kênh gốc qua `lossless-media://` (`HTTP 206 Byte-Range`) và Web Audio `AudioDspGraph`.
- **Non-Destructive Library**: Không sao chép, di chuyển, chỉnh sửa tag hay xóa file nhạc gốc trừ khi người dùng chủ động xác nhận. Dữ liệu thư viện, playlist, lyrics tùy chỉnh, metadata overrides và lịch sử nghe lưu an toàn trong SQLite WAL tại `%APPDATA%\Lossless Player\library.db`.

> **Tài liệu dành cho Người dùng & AI Coding Agent**:
> - **Hướng dẫn sử dụng đầy đủ (15 chương)**: [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) (hoặc mở trực tiếp trong app tại **Cài đặt → Hướng dẫn sử dụng**).
> - **Nguyên tắc cốt lõi**: [`DOREMI_CORE_PRINCIPLES.md`](./DOREMI_CORE_PRINCIPLES.md) · **Bộ nhớ ngữ cảnh AI**: [`AGENTS.md`](./AGENTS.md), [`.ai-context/CURRENT_STATE.md`](./.ai-context/CURRENT_STATE.md), [`.ai-context/NEXT_TASK.md`](./.ai-context/NEXT_TASK.md).

---

## 1. Kiến trúc & Các phân hệ chính

```text
DoReMi/
├── electron.vite.config.ts              # Build Main, Preload (CJS sandbox), Renderer (React.lazy)
├── electron-builder.yml                 # Đóng gói Windows NSIS Installer, Portable EXE, Portable ZIP
├── package.json                         # v1.0.0-rc.9 & scripts (docs:sync, build, dist, test:electron)
├── docs/
│   ├── USER_GUIDE.md                    # Tự động đồng bộ từ src/shared/user-guide/guide-content.ts
│   ├── phase-5.2/                       # Báo cáo kỹ thuật, UAT checklist & Verification reports
│   └── phase-6/                         # Personal Hybrid Server, Security, Remote HTTPS, Handover & Power/Resource (Phase 6.1–6.5)
├── qa/                                  # One-Click Windows QA Launchers (.cmd)
├── scripts/                             # doctor, sync-user-guide, verify-build, verify-codecs, smoke-electron
├── src/
│   ├── shared/
│   │   ├── contracts/                   # IPC channels, lossless-media:// & /api/v1/ Connect (+ Remote) contracts
│   │   ├── types/                       # Shared DTOs (track, library, playlist, connect, stage5/6, ipc, codec)
│   │   ├── user-guide/                  # Single Source of Truth cho 15 chương User Guide + Search VN
│   │   └── utils/                       # album-sort, smart-shuffle, app-metadata, audio-codec, audio-dsp, natural-sort, playback-controls
│   ├── main/
│   │   ├── index.ts                     # Single-instance, resilient crash handlers, userData DB, strict CSP
│   │   ├── windows/main-window.ts       # Hardened BrowserWindow (contextIsolation, sandbox, nodeIntegration: false)
│   │   ├── database/                    # connection.ts (SQLite WAL + FK), integrity.ts, migrations v1–v10, repos
│   │   ├── services/                    # library, artwork, alac-decoder (WASM), lyrics, playlist, profile, stats
│   │   ├── services/connect/            # Phase 6.1–6.5 Hybrid Server, Security, Funnel, Smart Handover & Power/Resource Management
│   │   ├── services/codec/              # Lớp Codec Engine cô lập (Isolated khỏi Audio Engine & UI mặc định)
│   │   └── ipc/                         # validators.ts & register-ipc.ts
│   ├── preload/index.ts                 # contextBridge API (window.losslessApi)
│   └── renderer/src/
│       ├── app/App.tsx                  # Route lazy-loading + AppErrorBoundary + OverlayHostProvider
│       ├── features/about/              # AboutSection.tsx (kamisamao, thông tin runtime & decoder)
│       ├── features/user-guide/         # UserGuideSection.tsx (15 chương offline + tìm kiếm tiếng Việt)
│       ├── pages/                       # Home, Library, NowPlaying, AudioLab, ServerPage, Settings...
│       ├── player/audio-engine.ts       # HTMLAudioElement + Web Audio AudioDspGraph (Local + Remote Adapter)
│       └── stores/                      # library-store.ts, player-store.ts, connect-store.ts, ui-store.ts
└── tests/                               # Bộ kiểm thử node:test chạy trên runtime Electron
```

---

## 2. Âm thanh & Bộ giải mã thực tế

| Định dạng | Cơ chế giải mã thực tế | Ghi chú kỹ thuật |
|---|---|---|
| **FLAC** | Chromium Media Pipeline + `flac-stream-sanitizer` | Sạch header/metadata ảo khi stream qua `lossless-media://`, không chạm file gốc |
| **ALAC (`.m4a`)** | `@mgz-dev/alac` (`v0.1.1` WebAssembly) | Giải mã on-demand sang PCM WAV stream (`HTTP 206` seekable), không cần FFmpeg ngoài |
| **WAV, MP3, AAC, OGG, Opus** | Chromium Media Pipeline | Hỗ trợ trực tiếp với HTTP Byte-Range seeking |
| **DSP & Audio Lab** | Web Audio `AudioDspGraph` | Preamp, Auto Headroom, ReplayGain, 10-Band Graphic EQ, 8-Band Parametric EQ, FFT Spectrum |
| **Codec Engine ngoài** | **Isolated (`0` UI imports mặc định)** | Không đóng gói FFmpeg/binary bên thứ ba trong bản phân phối mặc định |

---

## 3. Yêu cầu môi trường & Lệnh phát triển trên Windows

### Chuẩn bị (chỉ cần nếu tự build từ mã nguồn)
- **Windows 10/11 (64-bit)** và **Node.js 22 LTS (`>= 22.12.0`)** — xem thêm [`SYSTEM_REQUIREMENTS.md`](./SYSTEM_REQUIREMENTS.md).

### Các lệnh `npm` chính

| Lệnh | Mục đích |
|---|---|
| `npm install` | Cài dependencies theo `package-lock.json` |
| `npm run doctor` | Kiểm tra Node, Electron, native addon `better-sqlite3` & runtime |
| `npm run dev` | Chạy ứng dụng desktop Windows Electron ở chế độ phát triển |
| `npm run docs:sync` | Tạo/cập nhật [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) từ nội dung tích hợp trong app (`-- --check` để kiểm tra đồng bộ) |
| `npm run lint` | Kiểm tra kiểu TypeScript (`tsc --noEmit`) |
| `npm run codecs:verify` | Kiểm tra schema `resources/codecs/manifest.json` |
| `npm run test:electron` | Chạy toàn bộ bộ kiểm thử tự động trên runtime Electron |
| `npm run build` | Build Main, Preload, Renderer vào `out/` và xác minh (`verify-build.mjs`) |
| `npm run smoke:electron` | Chạy Electron GUI Smoke Test với profile tạm cô lập (`-- --exe <path>` cho bản đóng gói) |
| `npm run dist:nsis` / `dist:portable` | Đóng gói bộ cài NSIS, Portable EXE & Portable ZIP |

> **Lưu ý trên PowerShell**: Nếu PowerShell chặn `npm.ps1` theo chính sách ExecutionPolicy, hãy chạy qua `npm.cmd`.

---

## 4. Đóng gói, Dữ liệu Người dùng & QA

- **Hướng dẫn cài đặt & xác minh SHA-256**: [`WINDOWS_INSTALLATION_GUIDE.md`](./WINDOWS_INSTALLATION_GUIDE.md)
- **Dữ liệu & Sao lưu SQLite (`%APPDATA%\Lossless Player`)**: [`USER_DATA_AND_BACKUP.md`](./USER_DATA_AND_BACKUP.md)
- **Checklist nghiệm thu UAT Windows**: [`docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md`](./docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md)
- **One-Click QA Launchers**: Mở trực tiếp các file `.cmd` trong thư mục [`qa/`](./qa/) (`Launch`, `SmokeTest`, `Performance`, `SoakTest`).
