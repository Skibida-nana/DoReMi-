# ARCHITECTURE_MAP.md — Bản đồ kiến trúc thực tế DoReMi

- **Last Updated**: 2026-11-28T21:16+07:00
- **Last Verified Checkpoint**: `PHASE-6.5-RESOURCE-POWER-MANAGEMENT-RC9-20261128`
- **Verification Scope**: Kiến trúc thực tế **Audio Engine (`RUNTIME_ACTIVE` + Handover Recovery)**, **DoReMi Connect Phase 6.1–6.5 (`RUNTIME_OPT_IN` — SmartConnectionManager + Scoped Keep-Alive Pool + HostPowerManager + HostResourceSampler + LAN Direct TLS Pinning + Remote HTTPS qua Tailscale Funnel Loopback Gateway)**, **Codec Engine (`ISOLATED`)**, SQLite schema **`v10`**, và **User Guide (`v1.0.0-rc.9`)**.
- **Source References**: `src/main/services/connect/*`, `src/renderer/src/player/audio-engine.ts`, [`docs/phase-6/PHASE_6.5_RESOURCE_ARCHITECTURE.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_RESOURCE_ARCHITECTURE.md), [`docs/phase-6/PHASE_6.5_POWER_MANAGEMENT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_POWER_MANAGEMENT.md)
- **Verification Status**: `AUTOMATED RESOURCE, POWER & SOAK VERIFIED (232/232) · PACKAGED RC.9 VERIFIED · PHYSICAL COMBINED UAT PENDING`

---

## 1. Phân loại trạng thái tích hợp thực tế
- **Đang hoạt động (`RUNTIME_ACTIVE`)**: Core Electron/SQLite `v1–v10`, `verifyDatabaseIntegrity()`, `RuntimeResilience`, FLAC Sanitizer (`FlacByteSource` có khóa `sourceRevision` & trần `8 MB`), `@mgz-dev/alac 0.1.1` WASM (Local + Remote Range với bản sao PCM độc lập & tự dọn `20s`/`60s`), `AudioDspGraph`, `PlaybackQueueController` (Album-aware Smart Shuffle + Auto Continue), `AudioEngine.recoverCurrentTrackTransport` (`?ho=<seq>`), Unified Focus Player, Virtualized Queue & Library, `AboutSection` & `UserGuideSection`.
- **Tùy chọn Opt-In (`RUNTIME_OPT_IN` — Mặc định `0` cổng mạng, `0` khóa chống ngủ, `0` timer quét khi tắt)**:
  - **Resource & Power Management (Phase 6.5)**: `ScopedHttpsAgentPool` tái sử dụng kết nối an toàn theo từng `(hostId, transport, SPKI/origin)`, gom nhịp ghi SQLite `30s`, `HostPowerManager` (`follow-system` mặc định, `keep-awake-streaming` + `45s` đệm, `keep-awake-host-on` dùng `prevent-app-suspension`), đối soát `suspend`/`resume` fail-closed, `HostResourceSampler` theo yêu cầu (`0` timer nền khi không gọi).
  - **Smart Connection Manager (Phase 6.4)**: 3 chế độ `Automatic` / `LAN Only` / `Remote Only`, `NetworkChangeMonitor` tắt khi nghỉ, mDNS rediscovery chống giả mạo, `Make-Before-Break` & `Break-Before-Make`.
  - **LAN Direct (Phase 6.1–6.2)** & **Remote HTTPS (Phase 6.3)**: `ConnectHostService` (`STOPPED -> STANDBY -> ACTIVE`, giải phóng khóa riêng khi `STOPPED`), `RemoteGatewayService` loopback `127.0.0.1`, token tách biệt `r1.*` vs LAN, Client không cần Tailscale/VPN.
- **Cô lập có chủ đích (`ISOLATED` Backend)**: Toàn bộ Codec Engine (`src/main/services/codec/*`) — `0` static import từ Renderer hay Audio/Connect hot paths.
- **Deferred UI Fix Backlog (`UI-BACKLOG-01`..`05`)**: Vinyl rotation Remote (`7.3`), Unified Main Library Sources (`7.2`), Lightweight Host Gauges UI (`7.4` — backend `HostResourceSampler` đã sẵn sàng), Minimalist Server UI (`7.4`), Lyrics compat/sync (`7.3`).
- **Kế hoạch tương lai (`PLANNED`)**: Đợt rà soát ổn định hợp nhất Phase 6.3–6.5 -> Phase 6.6 Intelligent Playback Buffering -> Single-APK Android Client.
