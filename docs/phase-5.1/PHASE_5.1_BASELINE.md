# DOREMI — PHASE 5.1: BASELINE MEASUREMENTS (BEFORE OPTIMIZATION)

**Thời điểm đo**: `2026-11-25T19:33:16.259Z` (tương ứng `2026-11-26T02:33+07:00`)  
**Môi trường đo**:
- **OS / Arch**: `win32 x64` (Windows 11 Pro `10.0.26200`)
- **CPU**: `Intel(R) Core(TM) i5-14600K` (`20` logical cores)
- **RAM**: `31.65 GB`
- **Runtime**: Electron `45.4.1` (`ELECTRON_RUN_AS_NODE=1`, Node `v24.22.3` ABI; workspace Node `v22.12.0`)
- **Công cụ đo tái lập**: [`scripts/run-benchmark-phase51.mjs`](file:///g:/Source%20code%20DoReMi/scripts/run-benchmark-phase51.mjs) → [`scripts/benchmark-phase51.ts`](file:///g:/Source%20code%20DoReMi/scripts/benchmark-phase51.ts) (dữ liệu tổng hợp trong `%TEMP%`, hoàn toàn không chạm DB người dùng).

> **Lưu ý trung thực môi trường Sandbox**: Các chỉ số CLI/Headless Node-Electron, SQLite, Algorithm, Disk Scan và Production Build được đo trực tiếp bằng tool thật. Các chỉ số yêu cầu cửa sổ GUI/GPU thật hoặc Electron Renderer sống (First Paint ms, Idle/Playing Task Manager RAM, GPU % khi Blur 60fps, Live DevTools Profiler) được ghi nhận rõ trạng thái `BLOCKED (Headless Sandbox)` để xác minh bổ sung trong Windows UAT ngoài sandbox.

---

## 1. Baseline Quality & Build Check (Pre-Optimization)

| Kiểm tra | Lệnh thực thi | Kết quả Baseline | Ghi chú |
|---|---|---|---|
| TypeScript Check | `npm run lint` (`tsc --noEmit`) | **PASS (0 errors)** | Baseline sạch |
| Automated Tests | `npm run test:electron` | **158 tests: 152 PASS, 0 FAIL, 6 SKIP** (`3,824.15 ms`) | 6 skip do sandbox `EPERM` symlink & thiếu `FFMPEG_PATH` env |
| Codec Verification | `npm run codecs:verify` | **OK** (`manifest.json` verified) | Không có binary `.exe` trong `resources/codecs/` |
| Production Build | `npm run build` | **PASS** (`verify-build` OK) | Xem chi tiết dung lượng bundle bên dưới |
| Electron GUI Smoke | `npm run smoke:electron` | **BLOCKED (Sandbox)** | Exit `2147483651` từ Phase 4.5.1 trong sandbox không GUI/GPU |

### Dung lượng Production Bundle Baseline (`npm run build`)

| Artifact | Kích thước | Chi tiết |
|---|---|---|
| `out/main/index.js` | `319.44 kB` | `42` modules (`vite built in 65ms`) |
| `out/preload/index.cjs` | `10.95 kB` | `3` modules (`vite built in 10ms`) |
| `out/renderer/index.html` | `0.83 kB` | — |
| `out/renderer/assets/index-pk6wDWkG.css` | `126.02 kB` | Single CSS bundle |
| `out/renderer/assets/index-DHD-ow8A.js` | **`1,743.17 kB`** | **Single monolithic JS chunk (`1,734` modules, built in `310ms`)** |

---

## 2. Startup, Profile & Codec Discovery Baseline

| Hạng mục | Chỉ số Baseline | Ghi chú |
|---|---|---|
| Cold SQLite Open + 8 Migrations | `14.54 ms` | Tạo mới temp DB với WAL + FK + schema v8 |
| Warm SQLite Re-open | `1.59 ms` | DB đã có schema v8 |
| `ProfileService` (`getProfile` + `getPreferences` × 200) | `8.33 ms` | Có synchronous `fs.existsSync` + `db.prepare` mỗi call |
| `CodecManager.getInventory()` (Cold) | `7.79 ms` | Isolated lazy discovery |
| `CodecManager.getInventory()` (Warm cached) | `0.00 ms` | Cache hit trong phiên |

---

## 3. Large Library Scale Baseline (`100 → 50,000` tracks SQLite + Artwork)

| Scale (tracks) | `TrackRepo.findAll()` (ms) | `ArtworkService.enrichTracks()` (ms) | `LibraryService.getSnapshot()` (ms) | Vietnamese Search (ms) | `naturalCompare` Sort (ms) | Heap Delta (MB) | Process RSS (MB) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| **100** | `0.54` | `6.75` | `5.52` | `0.57` | `0.26` | `0.78` | `82.98` |
| **1,000** | `3.06` | `52.16` | `51.86` | `4.01` | `2.10` | `2.17` | `93.27` |
| **5,000** | `14.92` | `242.38` | `250.24` | `13.63` | `9.36` | `14.40` | `128.14` |
| **10,000** | `39.62` | `464.76` | `507.47` | `29.36` | `18.38` | `26.58` | `188.20` |
| **50,000** | `265.21` | **`3,358.16`** | **`3,578.66`** | `150.09` | `134.39` | `120.96` | `332.73` |

> **Phát hiện số liệu**: `ArtworkService.enrichTracks()` chiếm **~93.8%** tổng thời gian `getSnapshot()` ở 50,000 bài (`3,358.16 ms / 3,578.66 ms`) do lặp `fsSync.existsSync()` trên mỗi track!

---

## 4. Incremental Rescan Baseline (1,000 stub `.flac` files trên ổ đĩa thật)

| Chỉ số | Kết quả Baseline | Phân tích |
|---|---|---|
| `rescanLibrary()` trên `1,000` file **không thay đổi** | **`2,514.14 ms`** (`~2.51 s`) | `updatedCount = 1000` dù file không đổi nội dung vì `rescanLibrary` đưa tất cả file qua `importFiles` và thiếu fast-path skip trước khi dựng payload / IPC |

---

## 5. Playback Queue Scale Baseline (`100 → 5,000` tracks)

| Queue Size | `startContext()` (ms) | `setShuffle(true)` (ms) | `setShuffle(false)` Restore (ms) | `advanceManualNext()` × 50 (ms) | Heap Delta (MB) |
|---:|---:|---:|---:|---:|---:|
| **100** | `0.28` | `0.44` | `0.06` | `0.73` | `0.63` |
| **500** | `0.22` | `0.40` | `0.10` | `0.68` | `2.26` |
| **1,000** | `0.03` | `0.25` | `0.09` | `1.13` | `4.67` |
| **5,000** | `0.26` | `1.30` | `0.73` | `6.83` | `0.00` |

> **Nhận xét**: Thuật toán nội tại của `PlaybackQueueController` (`Fisher-Yates` + context restoration) đã rất nhanh (`<= 1.3 ms` ở 5,000 tracks); điểm nghẽn queue nếu có nằm ở **UI rendering / `trackMap` lookup** chứ không ở controller lõi.

---

## 6. UI Algorithms Baseline (Lyrics, Adaptive Artwork, Radial Layout, Virtualization)

| Benchmark | Kết quả Baseline | Ghi chú |
|---|---:|---|
| `parseLrcContent` + `groupTimedLyricLines` (120 lines × 100) | `11.33 ms` | `~0.11 ms` / lần |
| `findActiveLyricGroupIndex` + `getActiveLyricIndex` × 10,000 ticks | `2.55 ms` | Có thể binary-search nếu lyrics dài, nhưng $O(N)$ với ~120 dòng đang rất nhanh |
| `extractAdaptiveArtworkThemeFromRgbaPixels` (64×64 RGBA × 200) | `127.50 ms` | `~0.64 ms` / ảnh (chưa tính canvas blur/decode ở DOM) |
| `computeFocusRadialLayout` + `computeQueueWindowSlice(5000)` × 5,000 | `11.82 ms` | Thuật toán layout thuần rất nhẹ (`~2.4 µs/lần`) |
| `compareUnicodeText` (2,000 lần) | `2.20 ms` | `Intl.Collator` reuse tốt |

---

## 7. Chỉ số Runtime GUI/GPU Chưa Đo Được Trong Sandbox

| Chỉ số | Trạng thái Baseline | Lý do & Cách xác minh |
|---|---|---|
| Window Cold First Paint / Splash-to-Interactive (ms) | `BLOCKED (Headless Sandbox)` | Sandbox không có Desktop Session / GPU surface (`smoke:electron` exit `2147483651`) |
| Live Renderer Commit Time & React Flamegraph (`timeupdate` 4Hz) | `BLOCKED (Headless Sandbox)` | Kiểm chứng bằng React render-count tests + Windows Manual UAT checklist |
| Windows Task Manager Private Working Set (Idle vs Playing vs 10k Library) | `BLOCKED (Headless Sandbox)` | Đưa vào [`PHASE_5.1_WINDOWS_UAT.md`](file:///g:/Source%20code%20DoReMi/docs/phase-5.1/PHASE_5.1_WINDOWS_UAT.md) |
| GPU % khi Focus Vinyl Blur + Vinyl Spin 60fps | `BLOCKED (Headless Sandbox)` | Đưa vào Windows UAT Checklist |
