# FILE_INDEX.md — Bản đồ điều hướng Source Code DoReMi

- **Last Updated**: 2026-11-28T21:16+07:00
- **Last Verified Checkpoint**: `PHASE-6.5-RESOURCE-POWER-MANAGEMENT-RC9-20261128`
- **Verification Scope**: Hoàn tất Phase 5.1–6.4 & **Phase 6.5 (`1.0.0-rc.9`)**.
- **Source References**: `src/`, `qa/`, `scripts/`, `tests/`, `docs/`, `RELEASE_NOTES.md`, `CHANGELOG.md`
- **Verification Status**: `RELEASE CANDIDATE - AUTOMATED RESOURCE, POWER & SOAK VERIFIED · PACKAGED RC.9 VERIFIED`

---

## 1. Main Lifecycle, Resilience, Decoders, DB & Connect Backend (`src/main/`)
- **`src/main/index.ts`**, **`src/main/utils/runtime-resilience.ts`**, **`src/main/windows/main-window.ts`**: Hardened Electron shell, `%APPDATA%\Lossless Player`, CSP, `powerMonitor` (`suspend`/`resume`) chuyển tiếp cho cả Host & Client, `connectHostService.dispose()` & `connectClientService.shutdown()` khi `before-quit`.
- **`src/main/database/migrations.ts`** *(SQLite `v10`)*: Bảo toàn 100% schema `v10`; `connect-repository.ts` lưu `connect.host.power_policy` trong `app_preferences`, bỏ qua lệnh ghi cấu hình không đổi, và xuất `getLibraryStateToken()`.
- **`src/main/services/{alac-decoder,flac-stream-sanitizer}.ts`**: Local ALAC WASM (`0.1.1`) + shared `FlacByteSource` sanitizer có trần `8 MB` & `invalidateFlacPlansByPrefix`.
- **`src/main/services/connect/`**:
  - `host-power-manager.ts` *(Mới - Phase 6.5)*: Quản lý 3 chế độ nguồn điện (`follow-system`, `keep-awake-streaming` kèm `45s` đệm + nhả tức thì khi thu hồi, `keep-awake-host-on`) qua `powerSaveBlocker('prevent-app-suspension')` và `powerMonitor` (`suspend`, `resume`, `on-ac`, `on-battery`).
  - `resource-sampler.ts` *(Mới - Phase 6.5)*: Lấy mẫu theo yêu cầu `ScopedHostResourceBreakdown` (`0` timer nền khi không đăng ký), tách bạch tiến trình DoReMi và Tailscale chỉ-đọc.
  - `connect-client.ts` *(Phase 6.5)*: `ScopedHttpsAgentPool` cách ly theo `(hostId, transport, SPKI/origin, gen)` kèm xác minh lại SPKI trên socket tái sử dụng, `inflightTrackMeta`, `remoteLyricsCache` + `inflightLyrics`, khóa `sourceRevision` cho FLAC sanitizer, xử lý `suspend`/`resume`.
  - `host-service.ts` *(Phase 6.5)*: Vòng đời `STOPPED/STANDBY/ACTIVE`, tích hợp `HostPowerManager` & `HostResourceSampler`, đối soát `resume` fail-closed cho Remote Access, `libraryViewCache` lười theo `stateToken`, `inflightArtwork`, `lyricsCache` kèm `mtimeMs` sidecar, timer quét luồng tự tắt.
  - `device-auth-service.ts` *(Phase 6.5)*: `touchDeviceActivityThrottled` (`30s`) + `flushPendingDeviceActivity` + `deviceAuthCache` (`10s`, xóa tức thì khi đổi quyền/token).
  - `remote-alac-decoder.ts` *(Phase 6.5)*: Bản sao độc lập `Buffer.from(decodedChunks[0])` giải phóng bộ nhớ WASM ngay, trần `6 MB` cửa sổ / `3` chỉ mục, tự dọn sau `20s`/`60s` nghỉ.
  - `tailscale-funnel-provider.ts` *(Phase 6.5)*: Gộp yêu cầu `inflightDetect` + cache `5s` cho trạng thái `ready`.
  - `host-identity-service.ts` *(Phase 6.5)*: Cache khóa công khai + `releasePrivateKeyFromMemory()` khi `STOPPED`.
  - `smart-connection-manager.ts`, `network-monitor.ts`, `audio-streaming-service.ts`, `resource-budget.ts`, `remote-gateway-service.ts`, `remote-trust.ts`, `tailscale-cli.ts`, `lan-discovery-service.ts`, `secret-storage.ts`, `lan-direct-provider.ts`, `filesystem-guard.ts`.

## 2. Shared Contracts, IPC & UI (`src/shared/`, `src/preload/`, `src/renderer/src/`)
- **`src/shared/contracts/channels.ts`**, **`src/shared/types/{connect,ipc}.ts`**, **`src/preload/index.ts`**, **`src/main/ipc/register-ipc.ts`**: Kênh `CONNECT_HOST_SET_POWER_POLICY`, `CONNECT_HOST_GET_RESOURCE_BREAKDOWN`, gọi `invalidateLibraryCache()` khi sửa metadata/artwork/lyrics.
- **`src/renderer/src/stores/connect-store-core.ts`**, **`src/renderer/src/pages/ServerPage.tsx`**: Bộ chọn chính sách nguồn điện tiếng Việt tối thiểu, huy hiệu trạng thái chống ngủ/pin, tạm dừng timer UI theo `document.visibilitychange`, bảo toàn `UI-BACKLOG-01..05`.

## 3. Tests, Benchmarks, Docs, QA & Artifacts
- **`tests/phase65-{power-management,resource-lifecycle}.test.ts`** + `53` tệp test trước đó = **55 tệp (`232/232` PASS)**.
- **`scripts/{run-electron-ts.mjs,benchmark-phase65.ts,soak-phase65.ts,verify-windows-power-phase65.mjs,verify-packaged-rc9.mjs}`**, **`qa/logs/phase65-*.json`**.
- **`docs/phase-6/PHASE_6.5_{RESOURCE_ARCHITECTURE,POWER_MANAGEMENT,BENCHMARK_REPORT,RESOURCE_LIFECYCLE,WINDOWS_UAT,REPORT}.md`**, **`docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`**, **`release/v1.0.0-rc.9/*`**, **`backups/phase-6.4-pre-phase65-checkpoint/`**.
