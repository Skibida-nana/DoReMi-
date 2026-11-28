# KNOWN_ISSUES.md — Theo dõi lỗi, Tồn đọng & Chống Regression

- **Last Updated**: 2026-11-28T21:16+07:00
- **Last Verified Checkpoint**: `PHASE-6.5-RESOURCE-POWER-MANAGEMENT-RC9-20261128`
- **Verification Scope**: Toàn bộ Phase 5.1–6.4 & **Phase 6.5 (`1.0.0-rc.9`)** trên Windows (`win32 x64`, Electron `45.4.1`).
- **Source References**: [`docs/phase-6/PHASE_6.5_REPORT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_REPORT.md), [`docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md), [`docs/phase-6/PHASE_6.5_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_WINDOWS_UAT.md)
- **Verification Status**: `RELEASE CANDIDATE - AUTOMATED RESOURCE, POWER & SOAK VERIFIED · PACKAGED RC.9 VERIFIED · PHYSICAL COMBINED UAT PENDING`

---

## 1. Trạng thái các vấn đề / quan sát hiện tại (`STAB-*` / `OBS-*` / `ISS-OPEN-*` / `UI-BACKLOG-*`)

| Issue ID | Mô tả & Root Cause | Status | Files / Phạm vi | Hướng xử lý tiếp theo |
|---|---|---|---|---|
| `UI-BACKLOG-01` | **Now Playing Vinyl Rotation on Remote Playback**: Đĩa than trong `NowPlayingPage` / Focus Vinyl chưa quay đúng trạng thái khi phát nhạc từ xa (kể cả ở chế độ High Performance Mode). | `DEFERRED_UI_FIX_PHASE` *(Target Phase 7.3 — Không sửa trong Phase 6.5)* | `NowPlayingPage.tsx`, Focus Vinyl rotation | Triển khai riêng trong Phase 7.3. |
| `UI-BACKLOG-02` | **Source-Aware Main Library Integration**: Tích hợp duyệt Remote Music Library từ mục Server vào giao diện **Thư viện (Library)** chính với bộ lọc nguồn thống nhất: **All Sources / Local Sources / Remote Server Sources**, chia sẻ search/Album/Nghệ sĩ/Playlist/Queue (không sao chép file remote vào SQLite cục bộ). | `DEFERRED_UI_FIX_PHASE` *(Target Phase 7.2 — Không sửa trong Phase 6.5)* | `LibraryPage.tsx`, `connect-store-core.ts`, `ui-store.ts` | Thiết kế và triển khai trong Phase 7.2. |
| `UI-BACKLOG-03` | **Lightweight Real Host Resource Gauges**: Hiển thị chỉ số tài nguyên Host thực tế nhẹ (CPU, RAM, tốc độ upload, số Client đang kết nối, tách bạch rõ phạm vi local/LAN/Remote). | `BACKEND_READY_UI_DEFERRED` *(Target Phase 7.4 — API `HostResourceSampler` đã xong ở Phase 6.5)* | `ServerPage.tsx`, `resource-sampler.ts` | Triển khai đồng hồ UI nhẹ trong Phase 7.4. |
| `UI-BACKLOG-04` | **Minimalist Server UI Redesign**: Thiết kế lại giao diện Server theo hướng tối giản hơn, đưa các chi tiết kỹ thuật/bảo mật/mạng chuyên sâu vào mục Nâng cao (Advanced). | `DEFERRED_UI_FIX_PHASE` *(Target Phase 7.4 — Không sửa trong Phase 6.5)* | `ServerPage.tsx` | Triển khai thiết kế lại trong Phase 7.4. |
| `UI-BACKLOG-05` | **Lyrics Compatibility & Synchronization Investigation**: Điều tra lỗi tương thích & đồng bộ lời bài hát thực tế (`Love Option` unsynced trên cả Host & Client so với `DNA` synced và `Love Option Instrumental`), giữ nguyên thứ tự ưu tiên Custom > External LRC > Embedded. | `DEFERRED_UI_FIX_PHASE` *(Target Phase 7.3 — Không sửa trong Phase 6.5)* | `lyrics-service.ts`, lyrics parser & Remote/Host sync UI | Điều tra với file mẫu thực tế trong Phase 7.3. |
| `STAB-P63-65-PHYSICAL-UAT` | Đã kiểm chứng tự động đầy đủ Remote HTTPS, Smart Handover, Power Blocker (`powerSaveBlocker.isStarted()`) và Soak `118.93s`, nhưng chưa chạy UAT thực địa hợp nhất (Internet Tailscale Funnel thật, 2 máy Wi-Fi ↔ Hotspot 4G/5G, `powercfg /requests` quyền Admin & Sleep/Resume vật lý, đo trên laptop `i5-1035G1`, ngâm 2h/8h). | `PENDING_PHYSICAL_UAT` | `docs/phase-6/PHASE_6.5_WINDOWS_UAT.md`, `PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md` | Thực hiện trong Đợt Rà soát Hợp nhất Phase 6.3–6.5 trên `release/v1.0.0-rc.9/`. |
| `ISS-P65-PUBLIC-WOL` | Không thể đánh thức máy tính Windows đã vào Sleep/Shutdown từ Internet công cộng qua Tailscale Funnel nếu không có phần cứng phụ luôn bật trong mạng nhà. | `BY_DESIGN_ARCHITECTURAL_LIMIT` | `PHASE_6.5_POWER_MANAGEMENT.md` | Giải quyết bằng chế độ giữ thức tường minh (`keep-awake-streaming` / `keep-awake-host-on`). |
| `ISS-P63-RELAY-BANDWIDTH` | Tailscale Funnel trên gói miễn phí chịu giới hạn băng thông relay của Tailscale và tiêu tốn dữ liệu di động 4G/5G khi stream file Lossless/Hi-Res lớn. | `BY_DESIGN_UPSTREAM_LIMIT` | Tailscale Edge Relay / Remote Streaming | Đã cảnh báo rõ trong User Guide Chương 13; tối ưu đệm đọc trước ở Phase 6.6. |
| `OBS-51-01` / `ISS-OPEN-03` / `ISS-OPEN-07` / `ISS-P61-FIREWALL-LAN` | Quan sát lịch sử `Library`, codec manifest cô lập, preflight `test:electron`, và cấu hình Private Network Firewall cho mDNS. | `MITIGATED / BY_DESIGN` | Các phân hệ tương ứng | Giữ nguyên theo dõi trung thực. |

---

## 2. Lỗi & Điểm nghẽn đã khắc phục từ Phase 6.1.1 -> Phase 6.5 *(Cấm regression)*

| Issue ID | Hạng mục & Vấn đề gốc | Fix Summary | Bằng chứng & Tests | Phase |
|---|---|---|---|---|
| `P65-TLS-SQLITE-CHURN` | Mỗi yêu cầu `HTTP 206 Range` mở mới kết nối TLS (`agent: false`) và ghi SQLite `touchDeviceActivity`, cộng view `Buffer` chia sẻ giữ bộ nhớ WASM ALAC. | `ScopedHttpsAgentPool` kiểm tra lại SPKI (`-81.5%` TLS handshakes), gom nhịp ghi SQLite `30s` (`-93.9%` writes), bản sao `Buffer.from(decodedChunks[0])` + tự dọn `20s`/`60s`, giữ cache dương tính `ready` `5s` cho Tailscale CLI. | `tests/phase65-resource-lifecycle.test.ts`, `qa/logs/phase65-benchmark-after.json` | Phase 6.5 |
| `P65-AUTO-ENROLL-CACHE` | Ghép nối tự động `autoApproveSingleUse: true` duyệt thiết bị đồng bộ nhưng chưa xóa ngay `cachedDevicesRaw`. | Xóa `cachedDevicesRaw` ngay khi `status === 'approved'` kèm TTL ngắn khi chạy. | `tests/phase65-power-management.test.ts` | Phase 6.5 |
| `P64-MDNS-SPOOF-DOS` & `P64-MBB-STREAM-DRAIN` | Chống giả mạo mDNS khóa phiên & cửa sổ thoát êm `600 ms` cho `Make-Before-Break` (`?ho=<seq>`). | Bỏ qua ứng viên sai SPKI (`0` leak) & kiểm chứng `X-DoReMi-Source-Revision`. | `tests/phase64-*.test.ts` | Phase 6.4 |
| `P63-ROTATE-GRACE` & `BUG-P613-01` & `P0-612-*` | Thu hồi token cũ tức thì khi xoay vòng, giữ trạng thái tìm kiếm Remote Library, khôi phục đa định dạng ALAC/FLAC/WAV/AAC. | Store-owned search, lane isolation, Range ALAC WASM decoder. | `tests/phase63-*`, `phase613-*`, `phase612-*` | Phase 6.1.2–6.3 |
