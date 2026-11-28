# Hướng dẫn cài đặt Tailscale Funnel & Kiểm thử nghe nhạc qua Internet (Phase 6.3)

Tài liệu này hướng dẫn từng bước cách cấu hình **Tailscale Funnel (miễn phí trên gói Personal)** trên máy **Windows Host ở nhà**, để máy **Windows Client ở mạng khác** (hoặc ứng dụng di động tương lai) có thể nghe nhạc lossless trực tiếp mà **máy Client KHÔNG cần cài Tailscale hay VPN**.

> **Lưu ý trước khi bắt đầu**: Trên máy build hiện tại chưa cài sẵn `tailscale.exe`, vì vậy phần bật Tailscale Funnel thực tế và bài thử UAT 2 máy khác mạng (Nhóm E) chưa thể chạy tự động tại chỗ và cần bạn thực hiện theo hướng dẫn dưới đây.

---

## Phần 1 — Chuẩn bị trên máy Windows Host (Máy chứa thư viện nhạc ở nhà)

### Bước 1: Cài đặt Tailscale cho Windows
1. Truy cập trang chính thức: `https://tailscale.com/download/windows`
2. Tải và cài đặt bộ cài Tailscale Windows chính thức (mặc định sẽ cài vào `C:\Program Files\Tailscale\tailscale.exe`).
3. Mở Tailscale từ khay hệ thống (System Tray) góc dưới phải và nhấn **Sign in** bằng tài khoản cá nhân (Google, Microsoft, GitHub hoặc Passkey).
4. Tài khoản miễn phí (**Personal Plan**) đã bao gồm Tailscale Funnel; bạn không cần nâng cấp gói trả phí.

### Bước 2: Bật MagicDNS và HTTPS Certificates trong Tailscale Admin Console
1. Đăng nhập trang quản trị Tailscale tại trình duyệt: `https://login.tailscale.com/admin/dns`
2. Kiểm tra hai tùy chọn sau đều ở trạng thái **Enabled (Bật)**:
   - **MagicDNS**: Nhấn **Enable MagicDNS** (giúp máy có tên miền nội bộ dạng `ten-may.tailxxxx.ts.net`).
   - **HTTPS Certificates**: Kéo xuống cuối trang DNS, nhấn **Enable HTTPS** để Tailscale tự cấp chứng chỉ TLS Let's Encrypt hợp lệ công cộng cho tên miền của máy Host.

### Bước 3: Kiểm tra quyền Funnel trong Tailscale ACL
Tailscale Funnel yêu cầu node của bạn có quyền (capability) `funnel` trong Access Controls (`ACL`):
1. Mở trang **Access Controls**: `https://login.tailscale.com/admin/acls`
2. Trong cấu hình JSON mặc định mới, quyền `funnel` cho thành viên thường đã có sẵn dưới mục `nodeAttrs`. Nếu DoReMi báo thiếu quyền `Funnel ACL capability` (`tailscale.com/cap/funnel`), hãy đảm bảo phần `nodeAttrs` trong ACL có nội dung:
   ```json
   "nodeAttrs": [
     {
       "target": ["autogroup:member"],
       "attr": ["funnel"]
     }
   ]
   ```
3. Nhấn **Save** trên trang ACL nếu vừa chỉnh sửa.

---

## Phần 2 — Thiết lập DoReMi Host & Ghép nối Client lần đầu (Trong mạng LAN)

1. Mở **DoReMi (`v1.0.0-rc.7`)** trên máy **Host** -> vào mục **Server (DoReMi Connect)**.
2. Chọn thư mục nhạc cần chia sẻ và bật **Bật Host Server (LAN Direct)**.
3. Mở **DoReMi** trên máy **Client** khi cả hai máy còn đang ở **cùng mạng Wi-Fi/LAN ở nhà**:
   - Vào **Server** -> ghép nối với Host bằng **Mã QR (`doremi-pair`)**, dán JSON, hoặc nhập mã thủ công.
   - Đảm bảo trạng thái kết nối LAN đã thành công ít nhất một lần (mục Host đã lưu hiển thị trong danh sách).
4. Quay lại màn hình **Server** trên máy **Host**:
   - Trong khối **Remote HTTPS (Tailscale Funnel)**, kiểm tra trạng thái sẵn sàng (Tailscale cài đặt >= 1.52.0, MagicDNS ON, HTTPS ON, ACL Funnel OK).
   - Chọn cổng công cộng (`443` khuyến nghị; hoặc `8443` / `10000` nếu muốn tránh cổng 443), tick **Xác nhận mở quyền truy cập qua Internet có kiểm soát**, rồi nhấn **Bật Remote HTTPS (Tailscale Funnel)**.
   - DoReMi sẽ chỉ mở duy nhất đường dẫn `/doremi-connect` trỏ vào cổng Gateway `127.0.0.1` cục bộ, **tuyệt đối không dùng `tailscale funnel reset`** hay ghi đè các dịch vụ Tailscale Serve riêng tư khác.
5. Ngay bên dưới trong danh sách **Thiết bị đã ghép nối**, tìm máy Client của bạn và bật công tắc **Cho phép truy cập từ xa (`Remote Access`)**. *(Lưu ý: Quyền này mặc định TẮT với mọi thiết bị).*
6. Trên máy **Client** (khi vẫn còn trong LAN), nhấn **Đồng bộ cấu hình Remote (`Đồng bộ Remote qua LAN`)** để Client nhận:
   - `RemoteEndpointDescriptorV1` đã ký ECDSA P-256 (chứa tên miền HTTPS `https://ten-may.tailxxxx.ts.net/doremi-connect/api/v1`).
   - Scoped Remote Token (`r1.<deviceId>.<secret>`) được mã hóa riêng qua Windows DPAPI.

---

## Phần 3 — Kiểm thử UAT qua Internet thật (Client ở mạng khác, KHÔNG VPN)

1. Đưa máy **Client** sang một **mạng Internet khác** (ví dụ: phát Wi-Fi / 4G Hotspot từ điện thoại, hoặc mạng quán cà phê/văn phòng khác hoàn toàn mạng nhà).
2. **Đảm bảo máy Client KHÔNG bật Tailscale và KHÔNG bật VPN.**
3. Mở **DoReMi** trên máy Client -> vào mục **Server** -> tìm Host đã lưu:
   - Chuyển chế độ truyền tải tường minh từ `LAN Direct` sang **`Remote HTTPS (Internet)`**.
   - Nhấn **Kết nối**.
4. Các bước cần kiểm chứng thực tế:
   - Kết nối thành công, hiển thị huy hiệu `Remote HTTPS` cùng địa chỉ `https://ten-may.tailxxxx.ts.net`.
   - Duyệt thư viện nhạc, xem ảnh bìa, tìm kiếm bài hát và lấy lời bài hát từ xa hoạt động bình thường.
   - Phát nhạc liên tục các định dạng có sẵn (`FLAC 16/24-bit`, `ALAC 16/24-bit .m4a`, `WAV`, `AAC`, `MP3`), thử **tua nhanh (Seek)** và **Tạm dừng > 30 giây rồi phát tiếp**.
   - Kiểm tra nút **Xoay vòng Remote Token (`Rotate`)**: nhấn xoay vòng khi đang nối Remote HTTPS -> kết nối vẫn tiếp tục dùng token mới, token cũ bị vô hiệu hóa.
   - Trên Host, tắt **Quyền Remote Access** của máy Client (hoặc nhấn **Tắt Remote HTTPS**): luồng phát nhạc từ xa trên Client dừng ngay lập tức với thông báo lỗi rõ ràng; khi mang Client về nhà chọn lại `LAN Direct`, kết nối nội bộ vẫn hoạt động bình thường.

---

## Lưu ý về Băng thông & Xử lý nhanh sự cố thường gặp

- **Giới hạn băng thông relay của Tailscale Funnel (Gói miễn phí)**: Gói Tailscale Personal hỗ trợ Funnel miễn phí nhưng lưu lượng đi qua Tailscale Funnel có giới hạn băng thông do phía Tailscale điều tiết (không cấu hình tăng được trong app). Nếu nghe file Hi-Res bitrate quá cao (`24-bit / 192 kHz` hoặc `WAV` chưa nén) qua kết nối Internet yếu hoặc bị relay throttle, có thể xuất hiện buffering — điều này hoàn toàn bình thường do băng thông mạng ngoài và giới hạn của Tailscale Funnel.
- **Báo lỗi cổng 443 đang chạy Tailscale Serve riêng tư**: DoReMi chủ động từ chối đè lên dịch vụ khác trên cổng `443`. Hãy chọn cổng `8443` hoặc `10000` trong phần cài đặt Remote HTTPS của Host, hoặc tự thu hồi rule Serve cũ nếu không dùng nữa.
- **Client báo `Remote Endpoint Descriptor` chưa đồng bộ**: Cần đồng bộ nút **Đồng bộ Remote qua LAN** một lần khi hai máy còn trong mạng nhà sau khi Host đã bật Remote HTTPS và cấp quyền thiết bị.
