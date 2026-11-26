# CHANGELOG.md — Lịch sử các giai đoạn phát triển DoReMi

- **Last Updated**: 2026-11-26T03:36+07:00
- **Last Verified Checkpoint**: `PHASE-5.2-STABILITY-QA-RELEASE-CANDIDATE-20261126`
- **Verification Scope**: Hoàn tất Phase 5.1 (`5.1A → 5.1G`) & Phase 5.2 (`5.2A → 5.2H`) — phát hành Release Candidate `v1.0.0-rc.1` tách biệt tại `release/v1.0.0-rc.1/` (`Portable EXE/ZIP`, `NSIS Setup`, `SHA256SUMS.txt`), `185/185` Electron tests PASS (`0` FAIL, `0` SKIP), `smoke:electron` PASS trên cả dev lẫn `win-unpacked/DoReMi.exe`.
- **Source References**: [PHASE_5.2_FINAL_REPORT.md](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_FINAL_REPORT.md), [RELEASE_NOTES.md](file:///G:/Source%20code%20DoReMi/RELEASE_NOTES.md), [CHANGELOG.md](file:///G:/Source%20code%20DoReMi/CHANGELOG.md)
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

## [Phase 5.2 — Stability, QA & Standalone Release Candidate (`1.0.0-rc.1`)] *(2026-11-26)*
- **5.2A–B**: Bổ sung [runtime-resilience.ts](file:///g:/Source%20code%20DoReMi/src/main/utils/runtime-resilience.ts), `uncaughtException`/`unhandledRejection`/`render-process-gone`/`child-process-gone` trong [main/index.ts](file:///g:/Source%20code%20DoReMi/src/main/index.ts), [AppErrorBoundary.tsx](file:///g:/Source%20code%20DoReMi/src/renderer/src/components/AppErrorBoundary.tsx), và [integrity.ts](file:///g:/Source%20code%20DoReMi/src/main/database/integrity.ts) (`PRAGMA integrity_check` + `foreign_key_check`, WAL-safe `db.backup()` & pre-validated restore).
- **5.2C–D**: Ghi nhận sự cố double-click Library cuối Phase 5.1 là `INTERMITTENT - NOT REPRODUCED`, sửa clamping scroll edge-case trong [queue-virtualization.ts](file:///g:/Source%20code%20DoReMi/src/renderer/src/utils/queue-virtualization.ts), kiểm chứng `185/185 PASS` (`0` FAIL, `0` SKIP), `0` network calls, `0` prod CVEs.
- **5.2E–H**: Đo stress & concurrency sweep via [stress-benchmark-phase52.ts](file:///g:/Source%20code%20DoReMi/scripts/stress-benchmark-phase52.ts), tạo 4 launcher 1-click trong `qa/`, đóng gói `release/v1.0.0-rc.1/*` + `SHA256SUMS.txt` (giữ nguyên `release/DoReMi-0.1.0-x64-portable.exe`), hoàn thiện toàn bộ release docs & `PHASE_6_HANDOFF.md`.

## [Phase 4.5.1 — Audio Integrity, Real Encoder Validation & Windows Build Hardening] *(4.5.1A–4.5.1M Implemented — Awaiting Clean Environment & User UAT — 2026-11-25)*
- **Checkpoint**: `PHASE-4.5.1-AUDIO-INTEGRITY-REAL-ENCODERS-20261125`
- **4.5.1A–D — ALAC Metadata Priority, Recovery & Streaming Integrity**:
  - Sửa lỗi `!sampleRateHz`/`!bitDepth` trong [metadata-service.ts](file:///G:/Source%20code%20DoReMi/src/main/services/metadata-service.ts) bằng shared helper `resolveMp4AudioMetadataOverride` ([audio-codec.ts](file:///G:/Source%20code%20DoReMi/src/shared/utils/audio-codec.ts)), lọc track phi âm thanh `hdlr !== 'soun'` trong [alac-decoder.ts](file:///G:/Source%20code%20DoReMi/src/main/services/alac-decoder.ts) và đồng bộ [audio-analyzer.ts](file:///G:/Source%20code%20DoReMi/src/main/services/codec/audio-analyzer.ts).
  - Bổ sung SQLite migration `v8` (`metadata_version`) & `LibraryService.revalidateLegacyMetadata()` để tự động chuẩn hóa lại các track M4A/ALAC cũ mà vẫn giữ nguyên `100%` UUID, playlist, favorites, lyrics, artwork, override & thống kê nghe.
  - `tests/phase7-m4a-alac.test.ts` & `tests/phase451-regression.test.ts` xác nhận `16/44.1..24/192` ALAC, AAC `bit_depth = null`, `@mgz-dev/alac` 24-bit LSB L!=R PCM bit-exact & seeking qua ranh giới header WAV 44 byte.
- **4.5.1E–M — Job Lifecycle, Real Encoder Matrix, Native Adapters & Build Hardening**:
  - Bổ sung `waitForJob` / `waitForBatch` không polling, cancel guard trước `fs.rename`, vá verify failure honesty & 2-step pipe cleanup trong [audio-processing-service.ts](file:///G:/Source%20code%20DoReMi/src/main/services/codec/audio-processing-service.ts).
  - Đổi health probe `refalac`/`qaac` sang `--check`, bổ sung `--rate keep`/`--bits-per-sample` cho `refalac64`, và kiểm tra khớp kiến trúc PE DLL trong [codec-manager.ts](file:///G:/Source%20code%20DoReMi/src/main/services/codec/codec-manager.ts).
  - Thêm [scripts/run-tests-node.mjs](file:///G:/Source%20code%20DoReMi/scripts/run-tests-node.mjs) phòng dev chạy nhầm `npm test` trên Node N-API 9.
  - Xác minh lặp 5 lần targeted real matrix (`23/23 PASS`), Full Suite 37 tệp (`173 PASS / 0 FAIL / 2 EPERM SKIP`), `lint`/`codecs:verify`/`build`/`doctor` PASS, `0` vi phạm cô lập Codec Engine (`78` files). Chi tiết đầy đủ tại [PHASE-4.5.1-IMPLEMENTATION-REPORT.md](file:///G:/Source%20code%20DoReMi/PHASE-4.5.1-IMPLEMENTATION-REPORT.md).

## [Phase 4.5 — Codec Engine Stabilization, Foobar2000 Encoder Integration, Cross-Platform Testing & Windows Release Readiness] *(4.5A–4.5I)*
- **Checkpoint**: `PHASE-4.5-CODEC-ENGINE-STABILIZATION-FOOBAR-CROSSPLATFORM-20261125`
- **4.5A — Root Cause Audit (15 Test FAIL + 1 Skip Baseline)**:
  - Xác định **13/15** lỗi bắt nguồn từ script mock POSIX (`#!/bin/sh`, `#!/usr/bin/env node`, `chmod 0o755`, lệnh bash `touch`/`sleep`) không chạy qua `spawn({ shell: false })` trên Windows `win32`; **2/15** lỗi do `fs.symlink` trả về `EPERM` thiếu quyền tạo reparse link; ngoài ra phát hiện **1 bug thực tế Windows** ở `resolveConversionOutputPath` (lệch hoa-thường `reservedPaths` chứa ổ đĩa `C:\`).
- **4.5B–C — Cross-Platform Process Adapter & Windows Security Testing**:
  - Tạo [process-execution.ts](file:///G:/Source%20code%20DoReMi/src/main/services/codec/process-execution.ts) (`CodecProcessAdapter`, `CodecExecutableInspector`, `FsPathSafetyOps`, `defaultNativeProcessAdapter` `shell: false`) và tiêm sạch qua DI vào `CodecManager`, `AudioProcessingService`, `AudioAnalyzerService`, `FfmpegCapabilityDetector` mà không đưa bất kỳ cấu hình mock nào vào production.
  - Tạo [cross-platform-codec-harness.ts](file:///G:/Source%20code%20DoReMi/tests/helpers/cross-platform-codec-harness.ts): viết mock JS thuần `.cjs` chạy thật qua runtime được xác minh (`electron.exe` với `ELECTRON_RUN_AS_NODE=1` hoặc `node.exe`), đồng thời dùng `createSimulatedPathSafetyOps` + `probeOsLinkSupport()` tách kiểm thử bảo mật logic đường dẫn với subtest reparse OS thật (`fileSymlink`, `junction`, `hardLink`).
  - Vá lỗi phân biệt hoa-thường `reservedPaths` trong [audio-processing-service.ts](file:///G:/Source%20code%20DoReMi/src/main/services/codec/audio-processing-service.ts) via `normalizeReservationKey`.
- **4.5D–I — Foobar2000 Pack Discovery, FLAC Pipe Fix, Manifest & License Audit, Packaged Path Resolution**:
  - Thêm `resolveDefaultBundledCodecsDir` & `resolveBundledManifestFilePath` (dùng `process.resourcesPath` / `execDir` trước `cwd`, loại bỏ hoàn toàn nguy cơ lệ thuộc working directory trên NSIS/Portable ZIP), `getStandardFoobarEncoderSearchDirs` + `externalPackDirs` chịu Trust Policy.
  - Thêm `--ignore-chunk-sizes` cho lệnh `flac` khi nhận pipe WAV từ `ffmpeg` trong [codec-command-builder.ts](file:///G:/Source%20code%20DoReMi/src/shared/utils/codec-command-builder.ts).
  - Thêm `validateBundledCodecManifestSchema`, `auditCodecDistributionMatrix` & CLI `npm run codecs:verify` ([verify-codecs.mjs](file:///G:/Source%20code%20DoReMi/scripts/verify-codecs.mjs)).
  - Thêm [codec-phase45-integration.test.ts](file:///G:/Source%20code%20DoReMi/tests/codec-phase45-integration.test.ts) và [codec-real-integration.test.ts](file:///G:/Source%20code%20DoReMi/tests/codec-real-integration.test.ts).
  - Kết quả verification cuối: `npm run lint` (`0` lỗi), `npm run codecs:verify` (`OK`), `npm run build` (`OK`), Full Suite **36 tệp (`154` tests): `150 PASS / 0 FAIL / 4 SKIPPED`**, `0` runtime imports Codec Engine (`76` files); `smoke:electron` & `electron-builder` sang `release-phase4.5/` bị sandbox chặn (`2147483651` / `ENOTFOUND github.com`, đã dọn bản đóng gói dở & bảo toàn `release/` gốc).

## [Phase 4.4 — Focus Vinyl Polish, Simplified Artwork Backdrop, Multiline Radial Lyrics, True Shuffle, Queue Restoration & Global Layer Audit] *(UAT: 58 PASS / 0 FAIL / 1 chưa xác nhận)*
- *(Giữ nguyên lịch sử Phase 4.4 và các giai đoạn trước)*.
