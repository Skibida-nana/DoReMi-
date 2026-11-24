# DOREMI — PHASE 03 PROGRESS STATUS (FINAL: PHASE 03A + PHASE 03B COMPLETED)

Cập nhật lần cuối: 2026-11-24  
Trạng thái tổng thể: **Phase 03: Completed** (Phase 03A Completed · Phase 03B Completed)  
Giai đoạn kế tiếp: **Phase 03.5 — AI Project Memory System** → **Phase 04 — Complete Native Audio Integration & UI**  
Tài liệu nền tảng: [`DOREMI_CORE_PRINCIPLES.md`](./DOREMI_CORE_PRINCIPLES.md) · [`DOREMI_CODEC_RECOVERY_STATUS.md`](./DOREMI_CODEC_RECOVERY_STATUS.md)

---

## 1. Tổng quan tiến độ Phase 03A & Phase 03B

### Phase 03A — Codec Manager, Security & Registry
| Bước | Nội dung | Trạng thái | Ghi chú |
| :--- | :--- | :--- | :--- |
| **Step A1** | Recovery & Source Verification | **Completed** | Không có thay đổi dở dang; xác nhận không có `.git` repository trong workspace. |
| **Step A2** | Binary Security & Trust | **Completed** | PE/ELF/Mach-O header + CPU arch, Trust Policy, User Consent backend, Dependency check, Streaming SHA-256 + cache. |
| **Step A3** | Registry & Discovery | **Completed** | Đồng bộ 15 file của `foobar2000 Free Encoder Pack 2026-03-13`, Lazy Single-Codec Discovery, Bounded Concurrency (`1`), `allowSystemPathLookup = false`, Codec Fallback. |
| **Step A4** | Import, Rollback & Update Security | **Completed** | Atomic Staging Import, Active-Use Lock, Mutation Mutex, Symlink/Realpath guard, Synchronized Rollback, Pinned-IP Anti-SSRF/Anti-DNS-Rebinding Remote Manifest check. |
| **Step A5** | Phase 03A Unit Tests & Verification | **Completed** | `tests/codec-manager.test.ts` (13/13 Passed), `tsc --noEmit` 0 lỗi, Build Passed, `ISOLATED_OK`. |

### Phase 03B — Audio Quality, Processing Stability & Resource Management
| Bước | Nội dung | Trạng thái | Ghi chú |
| :--- | :--- | :--- | :--- |
| **Step B1** | Command Builder, FFmpeg Capabilities & Audio Quality | **Completed** | Bảo toàn bit depth (`16/24/32/float` không ép 24-bit), sample rate & multichannel (`lan-lossless-flac` giữ nguyên đa kênh), FFmpeg Capability Detection có cache & cổng Trust Policy, phân biệt `attached_pic` vs video stream, đủ adapter (`flac`, `lame`, `opusenc`, `oggenc2`, `wavpack`, `refalac`, `qaac`, `fhgaacenc`, `fdkaac`, `mpcenc`, `ffmpeg`). |
| **Step B2** | Resource Modes & Playback Priority Policy | **Completed** | `ResourcePolicyManager` với 3 chế độ (`power-saving` mặc định `concurrency = 1`, `balanced`, `performance`) và Playback Priority Policy kết nối `CodecManager.setDiscoveryPolicy(...)` + hàng đợi chuyển đổi mà không gắn trực tiếp vào `AudioEngine`. |
| **Step B3** | AudioProcessingService & File Protection | **Completed** | Bảo vệ file nguồn (realpath, symlink, junction, hard link, Windows case-insensitive), Output Path Collision Reservation/Lock, Backup-Before-Rename swap, Startup + Sliding Inactivity/Stall Timeout, Process Tree Cleanup (`taskkill /T /F` trên Windows / process group trên POSIX), `Pause`/`Resume` Queue, sửa race condition `cancelJob()` vs `retryFailedJobs()`, Output Verification (header + FFprobe + so sánh PCM lossless), Progress Reporting trung thực (bỏ cứng `2%`, hỗ trợ `indeterminate`, throttle theo Resource Mode). |
| **Step B4** | AudioAnalyzerService Accuracy | **Completed** | Bỏ nhãn giả `verified-lossless`; tách `lossless-codec`, `uncompressed-pcm`, `lossy-compressed`, `wavpack-hybrid`, `wavpack-lossy`, `unknown`; kiểm tra header WavPack 32-byte + `.wvc`; loại bỏ mặc định giả `channels = 2` / `bitDepth = 16` / `sampleRate = 44100`; tách bạch `ReplayGain` / `R128_TRACK_GAIN` / `Integrated LUFS`; `decoderStrategy` trung thực (`pendingPlaybackIntegration`); phân loại chi tiết lỗi FFprobe (`missing` / `incompatible` / `unverified` / `timeout` / `execution-failed` / `invalid-json` / `audio-stream-not-found`) + offline fallback. |
| **Step B5** | Unit Tests, Docs & Final Phase 03 Verification | **Completed** | 18 bài test mới Phase 03B (`codec-conversion.test.ts`, `codec-analyzer.test.ts`, `codec-resource-policy.test.ts`) — 100% Passed; cập nhật roadmap chính thức; `tsc --noEmit` 0 lỗi, Build Passed, `ISOLATED_OK`, Web Preview Passed, 0 regression Music Player. |

---

## 2. Danh sách file đã tạo / cập nhật trong Phase 03B

| File | Vai trò & Nội dung chính |
| :--- | :--- |
| `src/shared/types/codec-engine.ts` | Bổ sung `ResourceMode`, `ResourceModePolicy`, `PlaybackPriorityState`, `EffectiveResourceLimits`, `SourceAudioSpec`, `SourceSampleFormat`, `FfmpegCapabilities`, `ConversionProgressMode`, `OutputVerificationStatus`, `OutputVerificationReport`, `PcmComparisonStatus`, `ProcessTerminationReason`, `FfprobeExecutionStatus`, `DecoderStrategyKind`, `WavPackModeKind`; chuẩn hóa `LosslessVerificationStatus` & `AudioAnalysisReport`; cho phép `TranscodingProfile.channels: number | null`. |
| `src/shared/utils/codec-registry.ts` | Thêm `DEFAULT_RESOURCE_MODE = 'power-saving'`, `RESOURCE_MODE_POLICIES`, `FFMPEG_ENCODER_BY_TARGET`; cập nhật `DEFAULT_CONVERT_OPTIONS` (`concurrency = 1`, `resourceMode = 'power-saving'`); sửa `lan-lossless-flac` (`channels: null` để giữ nguyên đa kênh). |
| `src/main/services/codec/resource-policy.ts` *(Mới)* | Quản lý 3 chế độ tài nguyên (`Power Saving` mặc định / `Balanced` / `Performance`) và `PlaybackPriorityState`; tự động đồng bộ `CodecManager.setDiscoveryPolicy(...)`; không dùng background timer, không giảm chất lượng âm thanh, không yêu cầu quyền Administrator. |
| `src/main/services/codec/ffmpeg-capabilities.ts` *(Mới)* | Phát hiện & cache năng lực thực tế của `ffmpeg` (`-encoders`, `-decoders`, `-formats`, `-sample_fmts`) theo `(canonicalPath, size, mtimeMs, ino)`; tuân thủ Trust Policy của `CodecManager`. |
| `src/shared/utils/codec-command-builder.ts` | Nâng cấp toàn diện: bảo toàn bit depth & integer/float PCM, bảo toàn sample rate & đa kênh, kiểm tra năng lực FFmpeg trước fallback, phân biệt `attached_pic` vs video stream, hoàn thiện adapter `refalac`, `fhgaacenc`, `mpcenc`, `flac`, `lame`, `opusenc`, `oggenc2`, `wavpack`, `qaac`, `fdkaac`, `ffmpeg`, và sửa `buildStreamingTranscodePlan`. |
| `src/main/services/codec/audio-processing-service.ts` | Gia cố toàn diện: bảo vệ tệp nguồn qua realpath/symlink/junction/hardlink, khóa chống trùng đường dẫn đích (`reservedOutputPaths`), backup-before-rename swap, startup + sliding inactivity timeout, dọn cây tiến trình, `pauseQueue()`/`resumeQueue()`, chặn race condition `cancelJob()` vs `retryFailedJobs()`, xác minh tệp đầu ra (header + FFprobe + so sánh PCM lossless), báo cáo tiến trình trung thực không gán cứng `2%`. |
| `src/main/services/codec/audio-analyzer.ts` | Nâng cấp phân tích trung thực: bỏ `verified-lossless`, phân biệt PCM tuyến tính vs ADPCM/mu-law/A-law, đọc header 32-byte WavPack + `.wvc`, không điền mặc định giả `channels/bitDepth/sampleRate`, tách `ReplayGain` / `R128_TRACK_GAIN` / `Integrated LUFS`, chuẩn hóa `decoderStrategy` (`pendingPlaybackIntegration`), phân loại lỗi FFprobe chi tiết + offline fallback. |
| `tests/codec-conversion.test.ts` *(Mới)* | 10 bài unit test bao phủ Command Builder, FFmpeg Capability Detection, Source Protection, Output Collision Lock, Pause/Resume, Honest Progress, Safe Overwrite, Cancel-vs-Retry Guard, Startup/Inactivity Timeout, Magic Header & Full FFprobe + Lossless PCM Verification. |
| `tests/codec-analyzer.test.ts` *(Mới)* | 5 bài unit test bao phủ phân loại lossless/lossy/PCM/ADPCM, 4 trạng thái WavPack, tách ReplayGain/R128_TRACK_GAIN/Integrated LUFS, `decoderStrategy`, và 6 mã trạng thái lỗi FFprobe + no fake defaults. |
| `tests/codec-resource-policy.test.ts` *(Mới)* | 3 bài unit test bao phủ 3 chế độ tài nguyên, Playback Priority throttling, đồng bộ `CodecManager.setDiscoveryPolicy`, và cơ chế tự hoãn/tự tiếp tục chuyển đổi khi phát nhạc. |
| `DOREMI_CORE_PRINCIPLES.md` | Cập nhật Mục 15 theo lộ trình chính thức 11 mốc (Phase 01 → Phase 09 gồm Phase 03A, Phase 03B, Phase 03.5). |

---

## 3. Hạng mục cần xác minh trên máy Windows thật (`Pending Desktop Verification`)

- Thực thi các binary thật của `foobar2000 Free Encoder Pack 2026-03-13` trên Windows 10/11 x64 (`flac.exe`, `lame.exe`, `opusenc.exe`, `oggenc2.exe`, `wavpack.exe`, `mpcenc.exe`, `refalac64.exe`, `qaac64.exe`, `fhgaacenc.exe`, `nsutil.dll`) và bản build thực tế của `ffmpeg.exe` / `ffprobe.exe`.
- Xác minh thực tế các cờ CLI Windows của `refalac64.exe`, `fhgaacenc.exe` (kèm `nsutil.dll` + `enc_fhgaac.dll`), `qaac64.exe` (kèm `CoreAudioToolbox.dll`), và `mpcenc.exe`.
- Xác minh `taskkill /PID <pid> /T /F` khi hủy/timeout pipeline hai giai đoạn (`ffmpeg.exe | encoder.exe`) trên Windows thật.
- Xác minh hành vi khóa tệp (file locking) trên Windows NTFS khi ghi đè an toàn, đổi tên backup-swap, đường dẫn tiếng Việt/Unicode dài và đo hiệu năng thực tế trên laptop CPU Intel Core i5 dòng U / 8GB RAM.
- Xác minh và điền SHA-256 tham chiếu chính thức cho từng binary trước khi phát hành đóng gói.

---

## 4. Điều kiện tiên quyết đã sẵn sàng cho Phase 03.5 & Phase 04

- Toàn bộ tầng Codec Engine backend (`CodecManager`, `AudioProcessingService`, `AudioAnalyzerService`, `FfmpegCapabilityDetector`, `ResourcePolicyManager`, `codec-command-builder`, `codec-registry`) đã hoàn chỉnh, có bộ test tự động riêng và vẫn **cô lập 100% khỏi runtime Music Player (`ISOLATED_OK`)**.
- **Backlog Phase 8 được bảo lưu nguyên trạng** (chưa đụng chạm trong Phase 03):
  - `tests/database.test.ts:17` (`5 !== 4` migrations do `005_phase8_library_exclusions`).
  - 10 phương thức Library Management Phase 8 trong `src/shared/types/ipc.ts` chưa nối IPC/Preload (sẽ rà soát thống nhất trước Phase 05 Personal Stable Release).
