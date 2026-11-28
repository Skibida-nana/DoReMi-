# NEXT_TASK.md — Bộ nhớ tiếp nối công việc

- **Last Updated**: 2026-11-28T21:16+07:00
- **Completed Task ID**: `PHASE-6.5-RESOURCE-POWER-MANAGEMENT` (`COMPLETED — Released v1.0.0-rc.9`)
- **Next Planned Milestone**: **Combined Stabilization & Optimization Review of Phase 6.3 + Phase 6.4 + Phase 6.5** *(Không tự động chuyển sang Phase 6.6 khi chưa có xác nhận của người dùng)*
- **Recovery Checkpoints Available**:
  - `backups/phase-6.4-pre-phase65-checkpoint/` (`352` tệp — trạng thái `v1.0.0-rc.8` trước Phase 6.5, đã xác minh SHA-256)
  - `backups/phase-6.3-rc7-checkpoint/` (`324` tệp — trạng thái `v1.0.0-rc.7` trước Phase 6.4)
  - `backups/phase-6.2-rc6-checkpoint/` (trạng thái `v1.0.0-rc.6` trước Phase 6.3)
- **Stabilization & Physical UAT Checklist Ready for User Review**:
  - Hướng dẫn UAT hợp nhất (12 mục kiểm tra nhanh + 72 mục chi tiết Nhóm A–G): [`docs/phase-6/PHASE_6.5_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_WINDOWS_UAT.md).
  - Sổ đăng ký vấn đề ổn định hợp nhất Phase 6.3–6.5: [`docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md).
  - Các hạng mục UAT thực địa chờ người dùng xác nhận trên `release/v1.0.0-rc.9/`:
    1. `STAB-P63-01`: Kết nối Remote HTTPS thực tế từ mạng ngoài qua Tailscale Funnel thật.
    2. `STAB-P64-01`: Bàn giao phát nhạc 2 máy tính giữa Wi-Fi gia đình ↔ Hotspot 4G/5G điện thoại.
    3. `STAB-P65-01`: Kiểm tra trực tiếp `powercfg /requests` (Admin CMD), tắt màn hình độc lập và Sleep/Resume vật lý trên Windows.
    4. `STAB-P65-02`: Đo CPU/RAM thực tế trên laptop dòng U (`i5-1035G1 / 8 GB RAM`) và chạy ngâm dài hạn 2h/8h nếu cần (`soak-phase65.ts --minutes 120`).
- **Preserved Deferred UI Backlog (Dành riêng cho Phase 7 — Không tự ý triển khai sớm)**:
  - `UI-BACKLOG-01` (Phase 7.3): Chuyển động quay đĩa than `NowPlayingPage` / Focus Vinyl khi phát Remote Playback (kể cả High Performance Mode).
  - `UI-BACKLOG-02` (Phase 7.2): Tích hợp nguồn nhạc vào Thư viện chính (`All Sources / Local Sources / Remote Server Sources`), dùng chung search/Album/Artist/Playlist/Queue, không chép file remote vào SQLite cục bộ.
  - `UI-BACKLOG-03` (Phase 7.4): Chỉ số tài nguyên Host thực tế nhẹ (CPU, RAM, tốc độ upload, số Client đang kết nối, tách rõ phạm vi; API nền `HostResourceSampler` đã sẵn sàng từ Phase 6.5).
  - `UI-BACKLOG-04` (Phase 7.4): Thiết kế lại giao diện Server tối giản, đưa chi tiết kỹ thuật/bảo mật vào mục Nâng cao (Advanced).
  - `UI-BACKLOG-05` (Phase 7.3): Điều tra tương thích & đồng bộ lời bài hát (`Love Option` unsynced vs `DNA` synced & `Love Option Instrumental`), giữ thứ tự ưu tiên Custom > External LRC > Embedded.
