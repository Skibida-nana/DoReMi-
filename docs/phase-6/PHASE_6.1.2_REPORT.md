# DoReMi — Báo cáo Kỹ thuật Phase 6.1.2 (`v1.0.0-rc.4`)
**Critical Remote Playback Recovery, End-to-End Streaming Stabilization, Decoder Compatibility & Real-Device UAT Preparation**

- **Phiên bản**: `1.0.0-rc.4` (`appId: com.losslessplayer.desktop`, `%APPDATA%\Lossless Player`, `SQLite schema v9`)
- **Electron / Runtime**: Electron `45.4.1` · Electron Node `v24.22.3` · Windows x64
- **Trạng thái nghiệm thu**: **AUTOMATED & CHROMIUM E2E COMPLETE — REAL-DEVICE 2-PC LAN UAT PENDING USER**
- **Checkpoint mã nguồn trước khi sửa (RC3)**: [`backups/phase-6.1.1-rc3-checkpoint/`](file:///G:/Source%20code%20DoReMi/backups/phase-6.1.1-rc3-checkpoint/)

---

## 1. Tóm tắt Nguyên nhân gốc (Đã tái hiện trực tiếp trong Electron 45 Chromium)

Sử dụng `BrowserWindow` thực tế của Electron `45.4.1` + Web Audio `AudioContext` (`MediaElementAudioSourceNode`) nối trực tiếp qua `ConnectHostService -> TLS Pinning -> ConnectClientService -> lossless-media://`:

1. **Nguyên nhân gốc 1 — Gây lỗi hàng loạt trên FLAC, WAV, AAC, Seeking & Track Switching**:
   - `CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE = 4` (`connect-api.ts`) và `ResourceBudgetManager.tryEnterHttpRequest` (`host-service.ts`) dùng chung trần `4` request/thiết bị cho cả `/library/tracks/*/artwork` lẫn `/stream/:trackId`.
   - Khi `ServerPage.tsx` hiển thị danh sách bài từ xa với hàng loạt `<img src="lossless-media://remote-artwork/...">`, các ảnh bìa chạy song song chiếm hết `4` slot -> các request `Range` mở bài/tua seek gửi tới `/stream/:trackId` bị Host trả **`HTTP 429 CONCURRENCY_LIMIT` (`Content-Type: application/json`)**.
   - `ConnectClientService.proxyPinnedHostStream()` trước đây chỉ kiểm tra `status === 401 || 403`, còn `429` JSON được trả thẳng vào `<audio>`, khiến Chromium `FFmpegDemuxer` fail ngay với `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`.
2. **Nguyên nhân gốc 2 — Lỗi `ALAC / M4A` (`Có Thể (102112 Version)` 24-bit/48kHz)**:
   - Tái hiện chính xác `mediaError.code=4`, `PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams`.
   - Chromium trong Electron không tích hợp bộ giải mã ALAC; luồng Local dùng `@mgz-dev/alac` (`0.1.1`) WASM chuyển sang seekable PCM WAV, nhưng `resolveRemoteTrackMediaResponse()` truyền thẳng M4A ALAC thô cho `<audio>`.
3. **Các lỗi cộng hưởng đã xử lý đồng bộ**:
   - `openPinnedHttpsRequest()` giữ `timeout: 10_000` sau khi nhận response headers -> Pause > 10s cắt đứt TCP audio stream.
   - `Readable.toWeb(upstream)` thiếu kiểm soát backpressure và không gửi tương quan trace; remote FLAC thiếu lớp sanitize ảo cho tag ID3v2/PICTURE lỗi.
   - `playback-error.ts` gán cứng mọi `DEMUXER_ERROR` thành `ERR_CONTAINER_CORRUPT_HEADER`; `App.tsx` chưa khởi tạo `connectStore` sớm lúc mở app.

---

## 2. Kiến trúc Khắc phục & Các thay đổi Trọng tâm

- **Host Concurrency & DB Upgrade Floor** ([`connect-api.ts`](file:///G:/Source%20code%20DoReMi/src/shared/contracts/connect-api.ts), [`connect-repository.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-repository.ts), [`resource-budget.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/resource-budget.ts), [`host-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-service.ts)):
  - Nâng mặc định lên `16` req/thiết bị & `48` global + áp dụng floor nâng cấp tự động trong `getHostConfig()` cho các DB `v9` cũ (vẫn giữ nguyên trần `maxActiveClients = 3` thiết bị phát đồng thời).
  - Tách riêng lane `'artwork'` khỏi `'default'` (`/stream/*`, `/library/*`) để ảnh bìa không bao giờ cướp slot của luồng âm thanh.
- **Range-Backed Remote ALAC WASM Decoder** ([`remote-alac-decoder.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/remote-alac-decoder.ts), [`alac-decoder.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/alac-decoder.ts)):
  - Tái sử dụng `scanMoovContainer` / `readUint64Safe` / `buildPcmWavHeader`; chỉ đọc `moov` qua Range TLS (cả faststart lẫn `moov`-at-EOF), xây bảng chỉ mục gói tin gọn, và giải mã từng cửa sổ `< 512 KB` qua `@mgz-dev/alac` thành `audio/wav` seekable `200`/`206` (`0` transcode trên Host, RAM tối thiểu, AAC đi thẳng).
- **Client Streaming Resilience & FLAC Compat** ([`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts), [`flac-stream-sanitizer.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/flac-stream-sanitizer.ts), [`ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx)):
  - Disarm idle socket timeout sau header; semaphore artwork `<= 4` + `loading="lazy"`; retry `429 CONCURRENCY_LIMIT`/`503` (2 lần `80/180 ms`); chặn phản hồi `>= 400` / non-audio trước `<audio>`; custom backpressure `ReadableStream`; tái sử dụng `resolveFlacStreamPlanFromSource()` cho FLAC từ xa.
- **Remote Error Taxonomy & Correlation Traces** ([`audio-streaming-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/audio-streaming-service.ts), [`playback-error.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/player/playback-error.ts), [`audio-engine.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/player/audio-engine.ts), [`connect-store.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store.ts), [`App.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/app/App.tsx)):
  - Phân loại chuẩn `ERR_REMOTE_AUTH_FAILED`, `ERR_REMOTE_ACCESS_REVOKED`, `ERR_REMOTE_TRACK_NOT_FOUND`, `ERR_REMOTE_RESOURCE_LIMIT`, `ERR_REMOTE_STREAM_INTERRUPTED`, `ERR_REMOTE_NETWORK_TIMEOUT`, `ERR_REMOTE_RESPONSE_INVALID` và hiển thị Host/Client Stream Traces + nút sao chép trong `ServerPage`.

---

## 3. Kết quả Xác minh Thực tế (Verified sau chỉnh sửa code cuối)

| Hạng mục | Lệnh / Phạm vi | Kết quả quan sát thực tế |
|---|---|---|
| Docs Sync / Codecs / Lint | `docs:sync -- --check`, `codecs:verify`, `tsc --noEmit` | **PASS** (`v1.0.0-rc.4`, `0` lỗi TS, `manifest.json` OK) |
| Production Build | `npm.cmd run build` | **PASS** (`main 535.89 kB` + lazy `codec-manager 122.05 kB`, `preload 16.65 kB`, main renderer `677.38 kB`, lazy `ServerPage 106.36 kB`) |
| Toàn bộ Automated Tests | `npm.cmd run test:electron` (44 tệp, FFmpeg + Foobar2000) | **`203 tests: 203 PASS, 0 FAIL, 0 SKIP`** (`18,902.78 ms`) |
| Chromium + Web Audio E2E | `phase612-remote-playback-e2e.test.ts` (2 suites, 9 kịch bản E2E) | **PASS** (`WAV`, `FLAC+ART20`, `FLAC_ID3`, `AAC_EOF`, `ALAC 16/44.1`, `ALAC 24/48`, `ALAC_EOF`, `PAUSE>10S_RESUME`, `REVOKED_DEVICE_REJECTED`) + **SHA-256 PCM bit-exact parity** Local vs Remote ALAC (`16/44.1`, `24/48`, `24/96`, `moov-EOF`) |
| Performance & Soak Benchmark | `scripts/benchmark-phase612.ts` -> [`phase612-benchmark-latest.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase612-benchmark-latest.json) | Host STANDBY: `0% CPU`, `90.67 MB RSS`; ALAC 24/48 full: `28.1 ms`; Seek Range: `16.9 ms`; 3 Clients song song: `39.4 ms`; 30 switches: `65.0 ms` |
| Windows Packaging & Smoke | `npm.cmd run dist` + `portable` -> `release/v1.0.0-rc.4/` + `smoke:electron` | **PASS** (`NSIS Setup`, `Portable EXE`, `Portable ZIP`, `win-unpacked`, `SHA256SUMS.txt`); Dev & Packaged `DoReMi.exe` Smoke **OK** (`rootChildren=2, diagLogs=1`) |
| Prod Dependency Audit | `npm.cmd audit --omit=dev --json` | **`0` vulnerabilities** (`23` direct/resolved prod packages list, `0` package mới thêm) |
| **Manual 2-PC LAN UAT & `i5-5200U / 8GB`** | Host PC + Windows Laptop Client thật trên LAN/Wi-Fi | **NOT RUN (PENDING USER UAT)** — Thực hiện theo [`PHASE_6.1.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.1.2_WINDOWS_UAT.md) |
