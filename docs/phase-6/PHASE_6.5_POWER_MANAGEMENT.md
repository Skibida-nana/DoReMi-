# PHASE 6.5 — WINDOWS POWER MANAGEMENT & WAKE-ON-LAN ASSESSMENT (`v1.0.0-rc.9`)

## 1. Triết lý Quản lý Nguồn điện trên Windows

Một máy tính Windows cá nhân để ở nhà làm **DoReMi Personal Hybrid Server** phải cân bằng giữa hai nhu cầu đối lập:
1. **Không tự ý ngốn điện hay phá vỡ cài đặt tiết kiệm năng lượng của người dùng** khi chỉ mở ứng dụng nghe nhạc cục bộ hoặc không bật chế độ giữ thức.
2. **Không tự động chuyển sang trạng thái Ngủ (Sleep / Modern Standby) giữa chừng** khi người dùng đã chủ động cấu hình để nghe nhạc từ xa.

Vì vậy, DoReMi **tuyệt đối không sửa đổi Windows Power Plan toàn cục**, không chạy lệnh hệ thống yêu cầu quyền Administrator, và không giữ sáng màn hình (`prevent-display-sleep`). Thay vào đó, `HostPowerManager` (`src/main/services/connect/host-power-manager.ts`) sử dụng API gốc của Electron `powerSaveBlocker.start('prevent-app-suspension')` kết hợp `powerMonitor` theo **3 chính sách tường minh** do người dùng chọn và lưu bền vững trong bảng `app_preferences` (`connect.host.power_policy`, bảo toàn 100% SQLite schema `v10`).

---

## 2. Ba Chính sách Nguồn điện Máy chủ (`HostPowerPolicy`)

| Mã chính sách | Tên hiển thị trên UI | Mặc định | Khi nào giữ hệ thống thức (`prevent-app-suspension`)? | Hành vi màn hình (Display) |
|---|---|---|---|---|
| `follow-system` | **Theo hệ thống** | **Có (Mặc định)** | **Không bao giờ** — Tôn trọng hoàn toàn bộ hẹn giờ Sleep của Windows | Tắt bình thường theo cài đặt Windows |
| `keep-awake-streaming` | **Giữ thức khi đang phát từ xa** | Tùy chọn | Chỉ khi Host đang bật (`STANDBY`/`ACTIVE`) **và** có ít nhất 1 thiết bị được cấp quyền đang truyền luồng nhạc thực tế, cộng **`45 giây`** thời gian đệm chuyển bài (`gracePeriodActive`) | Tắt bình thường theo cài đặt Windows |
| `keep-awake-host-on` | **Giữ thức khi bật Host** | Tùy chọn | Suốt thời gian người dùng bật Host (`STANDBY` hoặc `ACTIVE`), kể cả khi chưa có thiết bị nào đang phát để máy luôn sẵn sàng truy cập từ xa | Tắt bình thường theo cài đặt Windows |

### Quy tắc Giải phóng Khóa Chống ngủ Tức thì (Zero-Leak Blocker Invariants)
- **Tắt Host (`STOPPED`) hoặc đóng ứng dụng (`dispose` / `before-quit`)**: Hủy ngay mọi bộ đếm đệm `45 giây` và gọi `powerSaveBlocker.stop(id)` ngay lập tức, kể cả khi đang chọn `keep-awake-host-on`.
- **Thu hồi quyền thiết bị (`revokeDevice`) hoặc tắt quyền Remote của thiết bị cuối cùng đang phát qua Remote**: Xóa ngay thiết bị khỏi tập bằng chứng phát nhạc và nhả khóa chống ngủ **tức thì (bỏ qua thời gian đệm `45 giây`)** để thiết bị đã bị thu hồi không thể kéo dài thời gian giữ thức máy Host.
- **Yêu cầu HTTP chưa xác thực (`401`/`403`/`404`) hoặc chỉ duyệt danh sách thư viện tĩnh**: **Không bao giờ** kích hoạt `keep-awake-streaming`; chỉ phiên truyền âm thanh hợp lệ của thiết bị đã xác thực mới được tính là bằng chứng phát nhạc.

---

## 3. Nhận biết Nguồn Pin (`Battery Awareness`) & Cảnh báo Rõ ràng

- `HostPowerManager` lắng nghe sự kiện `powerMonitor` (`on-ac`, `on-battery`) và truy vấn `powerMonitor.isOnBatteryPower()`.
- Khi phát hiện laptop đang chạy bằng pin (`powerSource === 'battery'`) trong lúc một khóa giữ thức đang hoạt động, `HostPowerSnapshot` gắn cờ cảnh báo tiếng Việt rõ ràng trên trang **Server** để người dùng biết máy đang ưu tiên giữ phiên phát nhạc từ xa và tiêu thụ pin nhiều hơn bình thường (nhưng không tự ý ngắt ngang bài nhạc mà người dùng đã chủ động cho phép).

---

## 4. Xử lý Hệ thống Ngủ (`suspend`) và Thức dậy (`resume`) An toàn

### 4.1. Phía Máy chủ (`ConnectHostService`)
1. **Khi nhận sự kiện `suspend`**:
   - Đẩy ngay các cập nhật `last_activity_at` đang chờ vào SQLite (`flushPendingDeviceActivity()`).
   - Dừng bộ hẹn giờ quét luồng nhàn rỗi và ghi nhận sự kiện kiểm toán `power_suspend`.
2. **Khi nhận sự kiện `resume` (Nguyên tắc Fail-Closed)**:
   - Xóa bộ đệm trạng thái giao diện mạng (`cachedNetworkAvailable = null`), kiểm tra lại cổng lắng nghe LAN HTTPS và làm mới quảng bá mDNS `_doremi._tcp.local` nếu Host đang bật.
   - **Kiểm tra tuyến Remote HTTPS theo nguyên tắc Fail-Closed**: Nếu trước khi ngủ người dùng đang bật Remote Access (`remoteState === 'READY'`), Host kiểm tra lại cổng loopback `RemoteGatewayService` và gọi `verifyOwnedRouteActive` + `detectStatus({ forceRefresh: true })`.
   - Nếu Tailscale bị ngắt hoặc tuyến Funnel không còn hợp lệ sau khi thức dậy, Host **đóng cổng Gateway cục bộ, ngắt các luồng Remote cũ và chuyển sang trạng thái cảnh báo `ERROR` an toàn** — **tuyệt đối không tự ý chạy lệnh mở lại tuyến Funnel công cộng ngầm**.

### 4.2. Phía Máy khách (`ConnectClientService` & `SmartConnectionManager`)
1. **Khi nhận sự kiện `suspend`**:
   - Tạm dừng mọi bộ đếm thử lại/ổn định mạng trong `SmartConnectionManager`, hủy các yêu cầu chuyển mạng đang bay và đóng toàn bộ socket Keep-Alive cũ (`destroyScopedAgents()`) để tránh treo trên TCP socket đã chết.
2. **Khi nhận sự kiện `resume`**:
   - Đánh thức `SmartConnectionManager` kiểm tra lại kết nối ngay với kết nối hiện tại theo đúng chế độ người dùng đã chọn (`Automatic`, `LAN Only`, `Remote Only`), không tự động phát lại nhạc nếu trước khi ngủ người dùng đang bấm **Tạm dừng (Pause)**.

---

## 5. Kết quả Xác minh Thực tế trên Hệ điều hành Windows

- **Kiểm thử tự động**: `tests/phase65-power-management.test.ts` vượt qua **100%** tất cả **22 kịch bản** máy trạng thái nguồn điện, thời gian đệm `45s`, thu hồi thiết bị nhả tức thì, chặn kích hoạt từ HTTP không xác thực (`401`), lưu bền vững qua khởi động lại DB và khôi phục `suspend`/`resume` fail-closed.
- **Kiểm chứng API Electron & OS thực tế (`qa/logs/phase65-windows-power-verification.json`)**:
  - Chạy tiến trình Electron `45.4.1` thực tế trên Windows x64 (`scripts/verify-windows-power-phase65.mjs`):
    - `powerSaveBlocker.start('prevent-app-suspension')` -> `isStartedWhileActive: true`, `displaySleepAllowedNormally: true`.
    - `powerSaveBlocker.stop(id)` -> `isStoppedAfterRelease: true`.
    - `powerMonitor.isOnBatteryPower()` -> `false` (máy bàn chạy nguồn AC).
  - Lệnh `powercfg /requests` trong phiên người dùng tiêu chuẩn không nâng quyền trả về thông báo chuẩn của Windows: *"This command requires administrator privileges and must be executed from an elevated command prompt."* (`powerCfgElevated: false`). Hướng dẫn kiểm tra trực tiếp `powercfg /requests` bằng Command Prompt (Run as Administrator) được cung cấp đầy đủ trong `docs/phase-6/PHASE_6.5_WINDOWS_UAT.md` (Nhóm C).
  - Kiểm thử chờ bộ đếm tự động Sleep vật lý của Windows được ghi nhận trung thực là **`NOT RUN`** vì tác nhân tự động tuyệt đối không ép máy tính đang làm việc của người dùng chuyển sang Sleep.

---

## 6. Đánh giá Khả thi Kỹ thuật: Đánh thức Máy chủ từ Xa (Wake-on-LAN Assessment)

Theo yêu cầu Mục 38 của đặc tả Phase 6.5, bảng dưới đây đánh giá trung thực khả năng hỗ trợ **Wake-on-LAN (WoL)** cho kiến trúc DoReMi:

| Kịch bản | Mức khả thi kỹ thuật | Yêu cầu Phần cứng / BIOS / Windows / Router | Rủi ro Bảo mật & Độ tin cậy | Quyết định Kiến trúc |
|---|---|---|---|---|
| **1. Đánh thức trong cùng mạng nội bộ (Local LAN WoL)** | **Khả thi có điều kiện** (chỉ khi Host cắm dây Ethernet LAN) | Mainboard bật *Wake on PCI-E/LAN* trong BIOS/UEFI; tắt *Fast Startup* hoặc cấu hình đúng S3/S4/S5; bật *Allow this device to wake the computer* + *Only allow a magic packet* trong Windows Device Manager; hầu hết card **Wi-Fi laptop phổ thông không hỗ trợ WoWLAN tin cậy** | Magic Packet UDP quảng bá lớp 2 (`FF:FF:FF:FF:FF:FF` + 16 lần địa chỉ MAC) không có xác thực mật mã nhưng chỉ giới hạn trong broadcast domain nội bộ | **Có thể cân nhắc làm tiện ích tùy chọn chỉ-trong-LAN ở giai đoạn tương lai** (cần lưu địa chỉ MAC LAN khi ghép nối), không cần thiết cho Phase 6.5 |
| **2. Đánh thức qua Internet công cộng / Tailscale Funnel** | **KHÔNG KHẢ THI (Infeasible)** với kiến trúc không phần cứng phụ | Khi máy Host Windows đã vào trạng thái **Sleep (S3)**, **Hibernate (S4)** hoặc **Shutdown (S5)**, tiến trình `tailscaled` và DoReMi đều đã ngừng chạy trên CPU -> kết nối relay Tailscale Funnel đã đóng hoàn toàn; ngoài ra Tailscale Funnel chỉ chuyển tiếp lưu lượng TCP/HTTPS lớp 7 tới localhost, không thể phát gói UDP Magic Packet lớp 2 vào card mạng nội bộ | Mở cổng UDP chuyển tiếp từ Internet vào broadcast mạng nhà (Sub-net Directed Broadcast / Port Forwarding UDP 7/9) trên router gia đình gây rủi ro bảo mật nghiêm trọng (amplification / đánh thức trái phép) và bị hầu hết ISP CGNAT chặn | **TỪ CHỐI TRIỂN KHAI (Rejected by Architecture)** — Không mở bất kỳ endpoint đánh thức công cộng nào; giải pháp thực tế duy nhất cho người dùng cá nhân không có thiết bị phụ luôn bật (như router tùy biến/Raspberry Pi trong nhà) là dùng chính sách **`Giữ thức khi bật Host`** hoặc **`Giữ thức khi đang phát từ xa`** khi dự định đi ra ngoài |
