# DoReMi Windows — Release Notes (`1.0.0-rc.9`)

**Trạng thái**: `RELEASE CANDIDATE - AUTOMATED RESOURCE, POWER & SOAK VERIFIED · PHYSICAL MULTI-DEVICE UAT PENDING`  
**Loại phát hành**: Test Build (`1.0.0-rc.9`) trên nền `1.0.0-rc.8` · **Developed by `kamisamao`**

---

## Nâng cấp trong `1.0.0-rc.9` (Phase 6.5 — Quản lý Tài nguyên, Nguồn điện Windows & Ổn định Máy chủ Chạy dài)

1. **Tối ưu hóa tài nguyên thực tế cho cả Local Player, Host và Client**:
   - **Tái sử dụng kết nối Scoped HTTP/HTTPS Keep-Alive**: Cách ly tuyệt đối theo từng `(hostId, transport, chứng chỉ)`, xác minh lại SPKI SHA-256 trên cả kết nối tái sử dụng, giảm **64,8%** kết nối TCP LAN mới (`108 -> 38`) và **81,5%** bắt tay TLS Remote (`108 -> 20`) trên bộ benchmark 25 kịch bản, đồng thời bảo toàn luồng nhạc tạm dừng trên 30 giây.
   - **Giảm 93,9% lượt ghi SQLite lặp lại khi stream (`165 -> 10`)**: Gom nhịp cập nhật `last_activity_at` (`30 giây/lần`) và bộ đệm xác thực thiết bị `10 giây` (tự xóa tức thì khi thu hồi quyền hoặc xoay vòng token).
   - **Quản lý vòng đời bộ đệm & giải mã ALAC/FLAC**: Không giữ con trỏ bộ nhớ WASM sau khi giải mã cửa sổ PCM ALAC, tự dọn cửa sổ nghỉ sau `20 giây` / chỉ mục sau `60 giây`, gộp yêu cầu ảnh bìa/lời bài hát trùng lặp (`inflight deduplication`), và tự xóa khóa riêng khỏi RAM khi tắt Host (`STOPPED`).
2. **Quản lý nguồn điện Windows tường minh (`HostPowerManager`) & Xử lý Ngủ/Thức an toàn**:
   - Cung cấp 3 chế độ lưu bền vững trên trang **Server**:
     - **`Theo hệ thống` (`follow-system` — Mặc định)**: Tôn trọng hoàn toàn cài đặt Sleep của Windows, không giữ thức ngầm.
     - **`Giữ thức khi đang phát từ xa` (`keep-awake-streaming`)**: Chỉ ngăn máy ngủ (`prevent-app-suspension`) khi có thiết bị được phép đang phát nhạc thực sự (kèm `45 giây` đệm chuyển bài), tự nhả ngay khi dừng phát, ngắt kết nối hoặc thu hồi quyền.
     - **`Giữ thức khi bật Host` (`keep-awake-host-on`)**: Giữ hệ thống thức suốt phiên bật Host để sẵn sàng truy cập từ xa; nhả ngay khi tắt Host hoặc thoát ứng dụng.
   - **Cho phép màn hình tắt tự nhiên**: Chỉ dùng `prevent-app-suspension` (không dùng `prevent-display-sleep`).
   - **Khôi phục sau Sleep theo nguyên tắc Fail-Closed**: Khi Windows thức dậy, Host kiểm tra lại cổng LAN và tuyến Tailscale Funnel hiện hữu; nếu tuyến không còn hợp lệ sẽ chuyển sang trạng thái cảnh báo an toàn thay vì tự ý mở lại đường truyền công cộng ngầm.
3. **Hạ tầng đo tài nguyên nhẹ cho Phase 7.4 & Chuẩn bị Rà soát Ổn định Hợp nhất Phase 6.3–6.5**:
   - Bổ sung `HostResourceSampler` (`0` bộ đếm thời gian nền khi không mở bảng chẩn đoán; tách bạch rõ tiến trình DoReMi và tiến trình Tailscale đọc chỉ-đọc) và tạm dừng bộ đếm giao diện khi thu nhỏ cửa sổ.
   - Bảo toàn nguyên vẹn `library.db` (`SQLite schema v10`), thiết bị đã ghép nối, token đã mã hóa, chất lượng âm thanh gốc và giữ nguyên chưa can thiệp sớm **5 hạng mục UI Phase 7 (`UI-BACKLOG-01`..`UI-BACKLOG-05`)**.
   - Xem hướng dẫn UAT thực tế tại [`docs/phase-6/PHASE_6.5_WINDOWS_UAT.md`](./docs/phase-6/PHASE_6.5_WINDOWS_UAT.md) và sổ rà soát hợp nhất Phase 6.3–6.5 tại [`docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`](./docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md).
