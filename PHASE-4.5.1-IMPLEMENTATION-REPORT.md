# PHASE-4.5.1-IMPLEMENTATION-REPORT.md
**DoReMi — Phase 4.5.1: Audio Integrity, Real Encoder Validation & Windows Build Hardening**

- **Official Status**: **`IMPLEMENTED - AWAITING CLEAN ENVIRONMENT VALIDATION`** *(theo Mục 9; bộ test logic, ALAC metadata/PCM, SQLite recovery & Real Encoder Integration chạy tự động đạt `173 PASS / 0 FAIL / 2 SKIP` trong sandbox + lặp 5 lần `23/23 PASS`; các cổng phụ thuộc GUI/mạng/reparse của sandbox gồm `AC-04 OS kernel EPERM`, `AC-23`, `AC-24`, `AC-25`, Clean Environment & Manual UAT chờ người dùng xác minh ngoài sandbox trước khi chốt `PHASE 4.5.1 COMPLETED` — không tự chuyển sang Phase 5)*
- **Checkpoint**: `PHASE-4.5.1-AUDIO-INTEGRITY-REAL-ENCODERS-20261125`
- **Pre-Fix Backup Checkpoint**: `PHASE-4.5.1-PRE-HOTFIX-WINDOWS-BASELINE`

---

## 8.1. Executive Summary

- **Công việc đã hoàn thành**:
  1. Tạo backup checkpoint đầy đủ trước khi sửa (loại trừ `node_modules`, `out`, `release`, `dist`, `.vite`), và tái lập chính xác `2/2` test FAIL baseline từ máy Windows người dùng (`tests/phase7-m4a-alac.test.ts:248` và `tests/codec-real-integration.test.ts:144`).
  2. Sửa triệt để lỗi ưu tiên metadata ALAC (`4.5.1B`) bằng helper dùng chung `resolveMp4AudioMetadataOverride` trong [src/shared/utils/audio-codec.ts](src/shared/utils/audio-codec.ts), siết kiểm tra ISO-BMFF `ALACSpecificConfig` + bỏ qua track phi âm thanh (`vide`) trong [src/main/services/alac-decoder.ts](src/main/services/alac-decoder.ts), đồng bộ 100% giữa [src/main/services/metadata-service.ts](src/main/services/metadata-service.ts) và [src/main/services/codec/audio-analyzer.ts](src/main/services/codec/audio-analyzer.ts), giữ `bit_depth = null` cho AAC.
  3. Triển khai cơ chế khôi phục metadata thư viện hiện có an toàn (`4.5.1C`) qua SQLite migration `v8` (`metadata_version` trong [src/main/database/migrations.ts](src/main/database/migrations.ts)), `findAvailableTracksNeedingMetadataRevalidation` ([src/main/database/track-repository.ts](src/main/database/track-repository.ts)), `revalidateLegacyMetadata()` & Smart Rescan ([src/main/services/library-service.ts](src/main/services/library-service.ts)), bảo toàn 100% Track UUID, playlists, favorites, custom lyrics, custom artwork, overrides & thống kê nghe.
  4. Xác minh toàn bộ pipeline ALAC `@mgz-dev/alac` WAV streaming, LSB 24-bit không đối xứng L/R, 206 byte-range qua ranh giới header 44 byte & suffix range, LRU eviction (`4.5.1D`).
  5. Chẩn đoán chính xác và sửa lỗi stale snapshot + bổ sung `waitForJob` / `waitForBatch` điều khiển theo sự kiện (0 polling), vá race condition hủy trong lúc verify (`fs.rename`), vá lỗ hổng `verifyOutputFile` khi `cmp.status === 'failed'` hoặc thiếu `ffmpeg` khi yêu cầu `verifyPcmOnLossless`, hỗ trợ `f64le`, và tăng cứng pipe 2 tiến trình (`4.5.1E/H`).
  6. Sửa `refalac` và `qaac` health check từ `--version` (exit `1`) sang `--check` (khớp binary thực tế `refalac 1.85` exit `0`), bổ sung `--rate keep` & `--bits-per-sample` cho `refalac64`, và kiểm tra khớp kiến trúc x86/x64 giữa executable và PE DLL (`CoreAudioToolbox.dll`, `enc_fhgaac.dll`) (`4.5.1H/I`).
  7. Viết lại [tests/codec-real-integration.test.ts](tests/codec-real-integration.test.ts) với `StructuredWavFixture` thật (khác kênh L/R, transient, silence, bit thấp 24-bit), tách ma trận **Native-only (`foobar2000 Free Encoder Pack`)** và **FFmpeg-only** riêng biệt không fallback ẩn, cộng bộ test hồi quy mới [tests/phase451-regression.test.ts](tests/phase451-regression.test.ts).
  8. Bổ sung preflight ABI guard [scripts/run-tests-node.mjs](scripts/run-tests-node.mjs) cho `npm test` khi chạy nhầm trên host Node N-API 9 (`v22.12.0`).
- **Chưa hoàn thành / Bị sandbox chặn**:
  - `npm run smoke:electron` (`status=2147483651`), `electron-builder` NSIS/ZIP (`getaddrinfo ENOTFOUND github.com` tại bước tải cache), `2` subtest OS kernel reparse link (`EPERM`), kiểm thử máy sạch không có tool ngoài, và UAT thủ công GUI người dùng.
- **Thay đổi kiến trúc**: Giữ nguyên sự cô lập 100% giữa Audio Engine và Codec Engine (`0` runtime import Codec Engine trong playback/library/UI); chỉ chia sẻ helper thuần `resolveMp4AudioMetadataOverride` trong `src/shared/utils/audio-codec.ts` và thêm cột `metadata_version` (migration `v8`) không phá vỡ schema cũ.

---

## 8.2. Root Cause Analysis

| Issue ID | File & Function | Triệu chứng & Bằng chứng | Nguyên nhân gốc | Cách sửa | Regression Test & Kết quả |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`P451-BUG-01`** *(FAIL baseline #1)* | `src/main/services/metadata-service.ts` -> `readTrackMetadata()` (dòng 194–199 trước sửa) & `alac-decoder.ts` | `tests/phase7-m4a-alac.test.ts:248`: `48000 !== 96000` dù `detectMp4AudioCodec()` đọc đúng `96000 Hz / 24-bit`. | `music-metadata` đọc field `stsd` 16.16/timescale `48000` (tràn/lệch khi >65.5kHz). Điều kiện `!sampleRateHz` & `!bitDepth` bỏ qua thông số chuẩn từ `ALACSpecificConfig` khi parser đã trả số khác `null`; `scanMoovContainer` cũng chưa bỏ track `vide`. | Dùng `resolveMp4AudioMetadataOverride` ưu tiên `ALACSpecificConfig` (`sampleRateHz`, `bitDepth`, `channels`) nếu hợp lệ, dùng `null` cho `AAC bitDepth`; lọc `hdlr !== 'soun'` & kiểm tra `frameLength`/`bitDepth` trong `alac-decoder.ts`; đồng bộ `audio-analyzer.ts`. | `tests/phase7-m4a-alac.test.ts` & `tests/phase451-regression.test.ts` (**PASS**, 5x repeat PASS). |
| **`P451-BUG-02`** *(FAIL baseline #2 — Stale Snapshot + Test Design)* | `tests/codec-real-integration.test.ts:128-144` & `audio-processing-service.ts` | `AssertionError: Real encode failed for flac: actual 'running' !== expected 'completed'`. | **Kết hợp nhiều nguyên nhân ở tầng test**: (1) `enqueueConversion()` gọi `pumpQueue()` đồng bộ khiến `job.status` chuyển `'running'` trước `await`, trả về **immutable snapshot cũ (`snap`)**; (2) Sau `await service.waitForCleanup()`, test vẫn đọc `snap.jobs[0]` thay vì snapshot mới nhất hoặc tìm theo `jobId`; (3) Test cũ gán cứng `SourceAudioSpec` `24-bit/96kHz` cho `wav16` và ép `WavPack` (`44.1kHz/16-bit`) phải ra `96000/24-bit`, cộng `catch { continue; }` bỏ qua lỗi âm thầm. | Sửa `codec-real-integration.test.ts` dùng `StructuredWavFixture`, tách Native-only vs FFmpeg-only thành subtest độc lập, tra cứu `job.id` và chờ `waitForJob(job.id)` (giữ nguyên ngữ nghĩa `waitForCleanup()`). | `tests/codec-real-integration.test.ts` & `tests/phase451-regression.test.ts` (**PASS**, 5x repeat PASS). |
| **`P451-BUG-03`** *(Production lifecycle bug)* | `src/main/services/codec/audio-processing-service.ts` -> `executeJob()`, `verifyOutputFile()`, `runPipelineSteps()` | (1) `cmp.status === 'failed'` khi FFmpeg decode lỗi không làm fail `verifyOutputFile`; (2) yêu cầu `verifyPcmOnLossless: true` khi thiếu `ffmpeg` vẫn trả `'verified-full'`; (3) Cancel giữa chừng bước verify có thể vẫn chạy `fs.rename` commit output; (4) `decChild` exit lỗi trước không unpipe/dọn gọn `encChild`. | Thiếu check `cmp.status === 'failed'`, thiếu hạ cấp `'verified-container-only'`, thiếu chốt `if (entry.canceled) return` trước bước 7 & 8. | Vá đủ cả 4 điểm + thêm `waitForJob`/`waitForBatch` không polling + hỗ trợ `f64le`. | `tests/phase451-regression.test.ts` & `tests/codec-conversion.test.ts` (**PASS**). |
| **`P451-BUG-04`** *(Real binary flag mismatch)* | `src/shared/utils/codec-registry.ts` & `codec-command-builder.ts` | `refalac64.exe --version` & `qaac64.exe --version` đều trả exit `1` (`unrecognized option '--version'`). | Manifest dùng `--version` chung cho `refalac` & `qaac`; builder chưa truyền `--rate keep` rõ ràng cho `refalac`. | Đổi `versionArgs` sang `['--check']` (xác minh `refalac64.exe --check` exit `0`, in `refalac 1.85`); truyền `--rate keep` / `--bits-per-sample` cho `refalac`. | `tests/codec-real-integration.test.ts` (**Native refalac -> alac PASS** trên 44.1/96/192kHz & mono). |
| **`P451-BUG-05`** *(PE DLL Arch Check)* | `src/main/services/codec/codec-manager.ts` -> `checkRequiredDependencies()` | Chưa đối chiếu kiến trúc PE x86 vs x64 giữa `.exe` và `.dll` phụ thuộc (`qaac64.exe` là x64, `fhgaacenc.exe` là x86 `0x14c`). | `checkRequiredDependencies` chỉ kiểm `dllCheck.isPeDll` mà bỏ qua `dllCheck.architecture === executableArch`. | Bắt buộc khớp `architecture` trên `win32` và ghi rõ chẩn đoán lệch kiến trúc / stderr transitive DLL. | `tests/phase451-regression.test.ts` (`x64 qaac64` từ chối `x86 CoreAudioToolbox.dll` -> `missing-dependency` **PASS**). |
| **`P451-BUG-06`** *(Legacy DB stale metadata)* | `migrations.ts`, `track-repository.ts`, `library-service.ts`, `main/index.ts` | Track ALAC 96kHz nhập trước bản vá vẫn kẹt `48000` trong SQLite do `mtime`/`size` không đổi khiến `rescanLibrary` bỏ qua. | Chưa theo dõi phiên bản đọc metadata (`metadata_version`) để re-probe có chọn lọc. | Migration `v8` thêm `metadata_version` (chỉ để `1` cho track `.m4a/.mp4/ALAC/AAC/rỗng`), `revalidateLegacyMetadata()` theo batch nhỏ không FFmpeg, giữ nguyên UUID & dữ liệu người dùng. | `tests/phase451-regression.test.ts` (**PASS**). |

---

## 8.3. Files Changed

| File Path | Mục đích & Phạm vi thay đổi | Lý do cần thiết | Coverage |
| :--- | :--- | :--- | :--- |
| `src/shared/utils/audio-codec.ts` | Thêm `toValidatedAudioPositiveInt`, `resolveMp4AudioMetadataOverride` *(Mở rộng nhẹ)* | Thống nhất quy tắc ALACSpecificConfig & AAC `bit_depth = null` dùng chung | `phase7-m4a-alac`, `phase451-regression` |
| `src/main/services/alac-decoder.ts` | Siết `ALACSpecificConfig` bounds + bỏ `hdlr !== 'soun'` track phi âm thanh *(Hẹp)* | Chống stream `vide`/cover spoofing & config rỗng | `phase451-regression`, `phase7-m4a-alac` |
| `src/main/services/metadata-service.ts` | Dùng `resolveMp4AudioMetadataOverride` + đồng bộ `channels` *(Hẹp)* | Sửa bug `!sampleRateHz` khiến 96kHz bị giữ ở 48000 | `phase7-m4a-alac`, `phase451-regression` |
| `src/main/services/codec/audio-analyzer.ts` | Dùng chung `resolveMp4AudioMetadataOverride` + ép `bitDepth = null` cho lossy FFprobe *(Hẹp)* | Đảm bảo MetadataService & AudioAnalyzer đồng nhất | `codec-analyzer`, `phase451-regression`, `codec-real-integration` |
| `src/shared/types/track.ts`, `src/main/database/migrations.ts`, `src/main/database/track-repository.ts` | Migration `v8` (`metadata_version`), `findAvailableTracksNeedingMetadataRevalidation` *(Hẹp, bảo toàn UUID/FK)* | Revalidate chọn lọc M4A/ALAC/AAC cũ không xóa DB | `database.test.ts`, `phase451-regression` |
| `src/main/services/library-service.ts`, `src/main/index.ts` | Bổ sung `revalidateLegacyMetadata()` theo batch + Smart Rescan check `metadata_version` *(Trung bình, 0 FFmpeg)* | Khôi phục track ALAC 96kHz cũ chạy nền không block playback | `library-service.test.ts`, `phase451-regression` |
| `src/shared/utils/codec-registry.ts` | Sửa `refalac` & `qaac` `versionArgs: ['--check']` *(Hẹp)* | Khớp hành vi thật `refalac64.exe` & `qaac64.exe` | `codec-real-integration`, `phase451-regression` |
| `src/shared/utils/codec-command-builder.ts` | Thêm `--rate keep` / `--bits-per-sample` & full tag cho `refalac64` *(Hẹp)* | Ngăn resample ngoài ý muốn & bảo toàn bit depth `refalac64` | `codec-real-integration`, `codec-conversion` |
| `src/main/services/codec/codec-manager.ts` | Đối chiếu PE arch x86/x64 DLL & giữ chi tiết lỗi stderr exit code *(Hẹp)* | Phân biệt lệch kiến trúc DLL (`CoreAudioToolbox`/`enc_fhgaac`) & transitive load fail | `codec-manager.test.ts`, `phase451-regression` |
| `src/main/services/codec/audio-processing-service.ts` | Thêm `waitForJob`/`waitForBatch`, cancel guard trước `fs.rename`, sửa `verifyOutputFile` & `f64le`, vá pipe 2 bước *(Trung bình)* | Sửa toàn bộ góc cạnh lifecycle/verification/pipe | `codec-conversion`, `codec-real-integration`, `phase451-regression` |
| `scripts/run-tests-node.mjs`, `package.json` | Preflight N-API guard cho `npm test` hướng dẫn chạy `npm run test:electron` *(Hẹp)* | Tránh dev nhầm `ERR_DLOPEN_FAILED` trên Node 22.12.0 | Xác minh `npm.cmd test` exit `1` rõ thông báo |
| `tests/codec-real-integration.test.ts`, `tests/phase451-regression.test.ts` | Tái cấu trúc Real Encoder Matrix (Native vs FFmpeg tách biệt) + bộ test hồi quy 4.5.1 *(Mới/Mở rộng)* | Chứng minh thực tế không bỏ qua lỗi hay fallback ngầm | `23/23 PASS` x 5 lần liên tiếp |

---

## 8.4. Encoder Inventory (Đo thực tế trên môi trường Windows x64)

| Codec | Version đo được | Arch | Tier / Nguồn kiểm thử | Health | Dependency Status | Trust Status | Actual Conversion Result | License (theo binary/file thật) | Packaging Eligibility |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `flac` (`flac.exe`) | `flac 1.5.0` | `x64` | External / PATH (`foobar2000/encoders`) | `ready` (`--version`, exit `0`) | Không | `trusted` (test userData) | **PASS** (16/44.1, 24/96, 24/192, Mono 24/48 — PCM match) | `flac_license.txt`: **GNU GPL v2** (`libFLAC` source BSD-3-Clause) | Cần hoàn thành nghĩa vụ GPLv2 nếu đóng gói binary CLI |
| `refalac` (`refalac64.exe`) | `refalac 1.85` | `x64` | External / PATH | `ready` (`--check`, exit `0`) | Không | `trusted` (test userData) | **PASS** (16/44.1, 24/96, 24/192, Mono 24/48 — PCM match) | Apache-2.0 / Public Domain | Cần kèm notice Apache-2.0 khi phân phối |
| `wavpack` (`wavpack.exe`) | `wavpack 5.9.0` | `x64` | External / PATH | `ready` (`--version`, exit `0`) | Không | `trusted` (test userData) | **PASS** (16/44.1, 24/96, 32f/48 — PCM match) | `wavpack_license.txt`: **BSD-3-Clause** | Đã xác minh có thể phân phối (kèm `wavpack_license.txt`) |
| `lame` (`lame.exe`) | `LAME 3.100 64-bit` | `x64` | External / PATH | `ready` (`--version`, exit `0`) | Không | `trusted` (test userData) | **PASS** (MP3 16/44.1, 16/48 — Lossy, duration & tag OK) | `lame_license.txt`: **GNU LGPL v2** | Cần kèm `lame_license.txt` & nghĩa vụ LGPLv2 ngoài ASAR |
| `opusenc` (`opusenc.exe`) | `opus-tools 0.2 / libopus 1.6.1` | `x64` | External / PATH | `ready` (`--version`, exit `0`) | Không | `trusted` (test userData) | **PASS** (Opus RFC 6716 48kHz — Lossy OK) | `opusenc_license.txt`: **BSD-2-Clause** | Đã xác minh có thể phân phối (kèm `opusenc_license.txt`) |
| `oggenc` (`oggenc2.exe`) | `OggEnc v2.88 (libvorbis 1.3.7)` | `x64` | External / PATH | `ready` (`--version`, exit `0`) | Không | `trusted` (test userData) | **PASS** (Ogg Vorbis 16/44.1 — Lossy OK) | BSD-3-Clause (`vorbis` / `oggenc2`) | Cần xác minh notice đầy đủ của bản build `oggenc2` trước bundle |
| `mpcenc` (`mpcenc.exe`) | *Loader error* | `x64` | External / PATH | `invalid` (`spawn UNKNOWN` / OS `{Illegal System DLL Relocation}` Win11 build 26200) | Không | `invalid` (chặn chạy an toàn) | **BLOCKED (OS binary loader)** — không làm crash DoReMi | LGPL-2.1 (theo manifest) | **NOT ELIGIBLE** với binary lỗi relocation hiện tại |
| `qaac` (`qaac64.exe`) | Chưa chạy | `x64` | External / PATH | `missing-dependency` (`--check` exit `2`) | Thiếu `CoreAudioToolbox.dll` (`The specified module could not be found`) | `missing-dependency` | **BLOCKED (Missing Apple Runtime DLL)** | Public Domain wrapper + **Apple proprietary runtime** | **External user-provided only** (không bundle DLL Apple) |
| `fhgaacenc` (`fhgaacenc.exe`) | Chưa chạy | `x86` | External / PATH | `missing-dependency` (`--version` exit `1`) | Có `nsutil.dll`, thiếu `enc_fhgaac.dll` (`cannot open enc_fhgaac.dll`) | `missing-dependency` | **BLOCKED (Missing Winamp DLL)** | `fhgaacenc_license.txt` (tmkk MIT/BSD) + **Winamp `enc_fhgaac.dll` độc quyền** | **External user-provided only** (không bundle DLL Winamp) |
| `ffmpeg` / `ffprobe` | `2026-11-23-git-05c674c913-full_build-www.gyan.dev` | `x64` | External test (`PATH`) | `ready` (`-version`, exit `0`) | Không (static build) | `trusted` (test userData) | **PASS** toàn ma trận FFmpeg-only | **`--enable-gpl --enable-version3` (GPLv3+)** | **External test only — KHÔNG phê duyệt bundle GPLv3+** |

*(Lưu ý: SHA-256 tham chiếu các tệp trên được tính cục bộ khi kiểm tra; `resources/codecs/manifest.json` giữ `expectedSha256: null` và KHÔNG đóng gói bất kỳ `.exe` hay `.dll` nào trong workspace.)*

---

## 8.5. Real Conversion Matrix

| Source | Target | Encoder | Sample rate | Bit depth | Channels | PCM verification | Result |
|---|---|---|---:|---:|---:|---|---|
| WAV `16-bit / 44.1kHz / 2ch` | FLAC | `flac.exe` (Native) | 44100 | 16 | 2 | FFmpeg PCM `s16le` SHA-256 **matched** | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | FLAC | `flac.exe` (Native) | 96000 | 24 | 2 | FFmpeg PCM `s24le` SHA-256 **matched** | **PASS** |
| WAV `24-bit / 192kHz / 2ch` | FLAC | `flac.exe` (Native) | 192000 | 24 | 2 | FFmpeg PCM `s24le` SHA-256 **matched** | **PASS** |
| WAV `24-bit / 48kHz / 1ch` | FLAC | `flac.exe` (Native) | 48000 | 24 | 1 | FFmpeg PCM `s24le` SHA-256 **matched** | **PASS** |
| WAV `16-bit / 44.1kHz / 2ch` | ALAC `.m4a` | `refalac64.exe` (Native) | 44100 | 16 | 2 | ALAC box + FFmpeg `s16le` **matched** | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | ALAC `.m4a` | `refalac64.exe` (Native) | 96000 | 24 | 2 | ALAC box + FFmpeg `s24le` **matched** | **PASS** |
| WAV `24-bit / 192kHz / 2ch` | ALAC `.m4a` | `refalac64.exe` (Native) | 192000 | 24 | 2 | ALAC box + FFmpeg `s24le` **matched** | **PASS** |
| WAV `24-bit / 48kHz / 1ch` | ALAC `.m4a` | `refalac64.exe` (Native) | 48000 | 24 | 1 | ALAC box + FFmpeg `s24le` **matched** | **PASS** |
| WAV `16-bit / 44.1kHz / 2ch` | WavPack `.wv` | `wavpack.exe` (Native) | 44100 | 16 | 2 | FFmpeg PCM `s16le` **matched** | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | WavPack `.wv` | `wavpack.exe` (Native) | 96000 | 24 | 2 | FFmpeg PCM `s24le` **matched** | **PASS** |
| WAV `32-bit float / 48kHz / 2ch` | WavPack `.wv` | `wavpack.exe` (Native) | 48000 | 32 | 2 | FFmpeg PCM `f32le` **matched** | **PASS** |
| WAV `16-bit / 44.1kHz / 2ch` & `48kHz` | MP3 | `lame.exe` (Native) | 44100 / 48000 | `null` | 2 | N/A (Lossy — verified decode/duration/tags) | **PASS** |
| WAV `16-bit / 48kHz / 2ch` & `24/96kHz` | Opus | `opusenc.exe` (Native) | 48000 *(RFC 6716)* | `null` | 2 | N/A (Lossy — verified decode/duration/tags) | **PASS** |
| WAV `16-bit / 44.1kHz / 2ch` | Ogg Vorbis | `oggenc2.exe` (Native) | 44100 | `null` | 2 | N/A (Lossy — verified decode/duration/tags) | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | FLAC | `ffmpeg.exe` (FFmpeg-only) | 96000 | 24 | 2 | `verifyPcmOnLossless` **matched** (`verified-full`) | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | ALAC `.m4a` | `ffmpeg.exe` (FFmpeg-only) | 96000 | 24 | 2 | `verifyPcmOnLossless` **matched** (`verified-full`) | **PASS** |
| WAV `32-bit float / 48kHz / 2ch` | WAV | `ffmpeg.exe` (FFmpeg-only) | 48000 | 32 | 2 | `verifyPcmOnLossless` **matched** (`verified-full`) | **PASS** |
| WAV `24-bit / 96kHz / 2ch` | WavPack `.wv` | `ffmpeg.exe` (FFmpeg-only) | 96000 | 32 *(container s32p)* | 2 | `verifyPcmOnLossless` **matched** (`s24le`) | **PASS** |
| WAV `16-bit` (`44.1k` / `48k`) | MP3 / AAC / Opus / Ogg | `ffmpeg.exe` (FFmpeg-only) | 44100 / 48000 | `null` | 2 | `skipped-lossy` (`verified-full` container+stream) | **PASS** |
| WAV `16-bit / 44.1kHz / 2ch` | AAC (`qaac` / `fhgaacenc`) & MPC | `qaac64` / `fhgaacenc` / `mpcenc` | — | — | — | N/A | **BLOCKED** *(Thiếu `CoreAudioToolbox.dll` / `enc_fhgaac.dll`; `mpcenc.exe` Win11 DLL relocation loader error)* |

---

## 8.6. Automated Test Results

| Hạng mục | Baseline Phase 4.5.1 (trước sửa) | Sau sửa Phase 4.5.1 (đo thực tế với FFmpeg + Foobar Pack) |
|---|---|---|
| **Targeted FAIL Suite** | `0 PASS / 2 FAIL` (`phase7-m4a-alac`, `codec-real-integration`) | **`23 PASS / 0 FAIL / 0 SKIP`** (lặp **5 lần liên tiếp**: cả 5/5 lần PASS trong 4.6–6.5s) |
| **Full Suite (`npm run test:electron`)** | `154 tests: 152 PASS / 2 FAIL / 0 SKIP` (máy user) | **`175 tests: 173 PASS / 0 FAIL / 2 SKIP / 0 Cancelled`** (`8147.87ms`, `exit 0`; **+21 tests/subtests mới** gồm `phase451-regression.test.ts` + subtest tách riêng trong `codec-real-integration.test.ts`) |
| **Chi tiết các mục `SKIP`** | `0` trên máy user (`EPERM` không chặn junction) | **`2`** mục đều tại `codec-conversion.test.ts` & `codec-manager.test.ts` (*"OS kernel reparse links blocked in current environment (fileSymlink=EPERM, junction=EPERM, hardLink=EPERM)"* — bị sandbox chặn tạo symlink/junction/hardlink) |
| **Codec Engine Isolation** | `PASS` | **`PASS`**: Quét `78` tệp thuộc `src/renderer`, `src/main/ipc`, `src/main/index.ts`, `library-service.ts`, `metadata-service.ts`, `alac-decoder.ts`: **`0` runtime import Codec Engine** |

---

## 8.7. Build & Packaging Results

- **`npm.cmd run doctor`**: **PASS** (`Summary: 0 hard failure(s), 2 warning(s)` — Node `v22.12.0` N-API 9 vs `better-sqlite3` N-API 10 chạy ổn định trong Electron `45.4.1`).
- **`npm.cmd run lint`**: **PASS** (`tsc --noEmit` exit `0`, 0 lỗi).
- **`npm.cmd run codecs:verify`**: **PASS** (`OK (1 file(s): manifest.json)`, note: chỉ có `manifest.json`, chưa có binary bundled trong `resources/codecs/`).
- **`npm.cmd run build`**: **PASS** (`out/main/index.js` `319.44 kB`, `out/preload/index.cjs` `10.95 kB`, `out/renderer/index.html` `0.83 kB`, `out/renderer/assets/index-pk6wDWkG.css` `126.02 kB`, `out/renderer/assets/index-DHD-ow8A.js` `1,743.17 kB`, `[verify-build] OK`).
- **`npm.cmd test` (Host Node guard)**: Exit `1` có chủ đích kèm thông báo rõ ràng hướng dẫn chạy `npm run test:electron` trên Node `v22.12.0` (không lỗi cryptic).
- **`npm.cmd run smoke:electron` (Dev)**: **BLOCKED trong sandbox** (`status=2147483651`).
- **Windows Packaging (`electron-builder --win nsis zip --x64 --publish never` ra `$env:TEMP`)**: `@electron/rebuild` `better-sqlite3@13.2.0` cho Electron `45.4.1` `x64` hoàn tất **OK**; bước tải asset từ GitHub thất bại do sandbox chặn mạng (`getaddrinfo ENOTFOUND github.com`, `PKG_EXIT=1`); thư mục tạm đã dọn sạch và `release/` gốc hoàn toàn nguyên vẹn.
- **Bundled Codec / Icon / Signing / Clean Env**:
  - `resources/codecs/` chỉ chứa `manifest.json` (`0` `.exe`/`.dll` đóng gói, `0` đường dẫn `D:\`/`G:\` trong production).
  - `build/` hiện có `0` file icon -> bản build dùng icon Electron mặc định (unsigned build — chưa có chứng thư số, không giả mạo chữ ký).
  - Packaged EXE Smoke & Clean Environment relocation: **NOT TESTED (Blocked by sandbox network/GPU)** — cần chạy ngoài sandbox.

---

## 8.8. Resource Results

- Idle CPU / Idle RAM / Playback CPU / Playback RAM / Conversion peak RSS: **NOT MEASURED** trong sandbox chạy CLI `ELECTRON_RUN_AS_NODE` (không thể mở Electron GPU/AudioContext GUI trong sandbox).
- Các chính sách tài nguyên được xác minh bảo toàn qua unit/integration tests: mặc định `power-saving` (`conversionConcurrency = 1`, `encoderThreads = 1`), `revalidateLegacyMetadata()` chỉ đọc header tối đa batch nhỏ với `setImmediate` yield (0 FFmpeg spawn), `child` & `.doremi-tmp-*` cleanup sạch 0 file rác.

---

## 8.9. Remaining Issues

| Issue / Gate | Trạng thái | Chi tiết & Bằng chứng |
|---|---|---|
| `P451-BUG-01` (ALAC 96kHz metadata priority + AAC null bit depth) | **RESOLVED** | Đã sửa & PASS trên toàn bộ ma trận 44.1–192kHz & `phase7-m4a-alac.test.ts` (5/5 lần). |
| `P451-BUG-02/03/04/05/06` (Stale snapshot, lifecycle, refalac/qaac `--check`, DLL arch, DB recovery) | **RESOLVED** | Đã sửa & PASS toàn bộ `codec-real-integration.test.ts` + `phase451-regression.test.ts` (5/5 lần). |
| `ISS-OPEN-08` (FFmpeg M4A/ALAC fixture test) | **RESOLVED** | `phase7-m4a-alac.test.ts` đã chạy thật với FFmpeg & đạt **PASS**. |
| `ISS-OPEN-04` (Windows kernel symlink/junction/hardlink subtests) | **PARTIALLY RESOLVED (Sandbox EPERM)** | Logic + DI PASS; 2 subtest kernel reparse `SKIP` do sandbox `EPERM`. Cần xác nhận ngoài sandbox (nơi baseline máy user đã PASS). |
| `ISS-OPEN-03` (Bundling binary encoder OSS vào `resources/codecs/`) | **PARTIALLY RESOLVED** | Đã audit license thật (`flac_license.txt` là GPLv2!); workspace giữ manifest-only `0` binary, dùng external Pack đã xác minh. |
| `AC-23, AC-24, AC-25` (`smoke:electron`, NSIS/ZIP packaging, Packaged EXE smoke) & Clean Env | **BLOCKED (Sandbox) / NOT TESTED** | Chờ chạy bằng lệnh PowerShell bên dưới trên Windows Desktop ngoài sandbox. |
| Optional codecs (`qaac64`, `fhgaacenc`, `mpcenc`) | **BLOCKED (External dependency / OS loader)** | `qaac64` thiếu Apple `CoreAudioToolbox.dll`, `fhgaacenc` thiếu Winamp `enc_fhgaac.dll`, `mpcenc.exe` lỗi OS relocation trên Win11 26200; không làm ảnh hưởng app hay các encoder khác. |
| Phase 4.4 UAT `#59` & Phase 4.5.1 Manual UAT | **OPEN (Awaiting User UAT)** | Chờ người dùng kiểm tra trực tiếp app Electron Windows thật. |

---

## 8.10. Backup & Rollback

- **Vị trí bản sao lưu Pre-Hotfix**: `C:\Users\Admin\.gemini\antigravity\brain\35f21e1e-f014-4295-b49e-34dfb9c533c0\scratch\backup-PHASE-4.5.1-PRE-HOTFIX-WINDOWS-BASELINE`
- **Checkpoint Identifier**: `PHASE-4.5.1-PRE-HOTFIX-WINDOWS-BASELINE` (`143` tệp `src/`, toàn bộ `tests/`, `scripts/`, `resources/`, `package.json`, `package-lock.json`, `electron-builder.yml`; loại trừ `node_modules`, `out`, `release`, `dist`, `.vite` có thể tái tạo).
- **Hướng dẫn Rollback**: Nếu cần khôi phục hoàn toàn về trước Phase 4.5.1, sao chép đè lại `src/`, `tests/`, `scripts/`, `package.json` từ thư mục backup trên và chạy `npm.cmd run build`.
- **Database Schema Note**: Migration `v8` chỉ thêm cột `metadata_version INTEGER NOT NULL DEFAULT 1` + index `idx_tracks_metadata_version` vào bảng `tracks`. Trước khi chạy bất kỳ migration nào, `openLibraryDatabase` luôn tự tạo file backup SQLite; toàn bộ Track UUID và dữ liệu người dùng không bị sửa hoặc xóa.

---

## 8.11. Windows UAT Commands (Copy & Run Ngoài Sandbox)

```powershell
# 1. Thiết lập môi trường phiên PowerShell tạm thời (không lưu PATH vĩnh viễn)
$nodePath = "D:\Dowload\node-v22.12.0-win-x64\node-v22.12.0-win-x64"
$ffmpegPath = "D:\Dowload\FFmpeg\ffmpeg-2026-11-23-git-05c674c913-full_build\bin"
$encoderPath = "G:\Soure app\foobar2000\encoders"
$env:Path = "$nodePath;$ffmpegPath;$encoderPath;$env:Path"
$env:DOREMI_REAL_CODECS_DIR = $encoderPath
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Set-Location "G:\Source code DoReMi"

# 2. Kiểm tra Doctor, Lint, Manifest & Build
npm.cmd run doctor; Write-Host "DOCTOR_EXIT=$LASTEXITCODE"
npm.cmd run lint; Write-Host "LINT_EXIT=$LASTEXITCODE"
npm.cmd run codecs:verify; Write-Host "CODECS_VERIFY_EXIT=$LASTEXITCODE"
npm.cmd run build; Write-Host "BUILD_EXIT=$LASTEXITCODE"

# 3. Chạy toàn bộ Full Suite ngoài sandbox (kỳ vọng 175/175 PASS hoặc chỉ skip fileSymlink nếu chưa bật Developer Mode; junction/hardlink PASS)
npm.cmd run test:electron; Write-Host "FULL_TEST_EXIT=$LASTEXITCODE"

# 4. Chạy lại targeted real tests
npm.cmd run test:electron -- tests/phase7-m4a-alac.test.ts tests/codec-real-integration.test.ts tests/phase451-regression.test.ts
Write-Host "TARGETED_EXIT=$LASTEXITCODE"

# 5. Dev Startup Smoke & Đóng gói Windows sang thư mục tạm (không đụng release\ cũ)
npm.cmd run smoke:electron; Write-Host "DEV_SMOKE_EXIT=$LASTEXITCODE"
$packageOut = Join-Path $env:TEMP ("DoReMi-Phase-4.5.1-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
npx.cmd --no-install electron-builder --win nsis zip --x64 --publish never "--config.directories.output=$packageOut"
Write-Host "PACKAGING_EXIT=$LASTEXITCODE"
node scripts/smoke-electron.mjs --exe "$packageOut\win-unpacked\DoReMi.exe"
Write-Host "PACKAGED_SMOKE_EXIT=$LASTEXITCODE"
Get-ChildItem $packageOut | Select-Object Name, Length

# 6. Kiểm tra Clean Environment (tạm thời loại Node, FFmpeg, Encoders khỏi PATH khi gọi smoke test Packaged EXE)
$savedPath = $env:Path
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
& "$nodePath\node.exe" scripts/smoke-electron.mjs --exe "$packageOut\win-unpacked\DoReMi.exe"
Write-Host "CLEAN_ENV_PACKAGED_SMOKE_EXIT=$LASTEXITCODE"
$env:Path = $savedPath
```
