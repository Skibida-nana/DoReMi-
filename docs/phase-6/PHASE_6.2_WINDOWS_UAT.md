# DoReMi Windows — Phase 6.2 Real-Device Security & Pairing UAT Checklist (`v1.0.0-rc.6`)

**Phạm vi**: Kiểm thử nghiệm thu thực tế trên 2 máy Windows kết nối qua mạng LAN Wi-Fi (`Host Windows` & `Client Laptop Windows`).  
**Yêu cầu trước khi bắt đầu**: Cho phép cổng DoReMi Host (mặc định `48620`) qua Windows Defender Firewall ở chế độ **Private Network**.

---

## Nhóm A — Host QR Pairing & Lifecycle (12 mục)
- [ ] **A01**: Khởi động DoReMi lần đầu / bản nâng cấp từ `rc.5`: Host Server vẫn giữ mặc định TẮT, thiết bị cũ trong SQLite `v9` còn nguyên vẹn.
- [ ] **A02**: Bật Host Server → trạng thái chuyển `STANDBY`, không lỗi port/TLS, không giật nhạc Local đang phát.
- [ ] **A03**: Tab **Thiết bị** → bấm **Tạo mã mời ghép nối**: hiển thị ảnh QR rõ nét trên nền trắng, mã mời 12 ký tự, nút tải ảnh `.png` và nút sao chép JSON.
- [ ] **A04**: Đồng hồ đếm ngược `Còn lại: mm:ss` giảm đều từng giây, CPU không tăng đột biến.
- [ ] **A05**: Bấm **Xem Full SPKI SHA-256 Fingerprint** → hiển thị đủ chuỗi 32 cặp hex phân tách `:`.
- [ ] **A06**: Bấm **Tải ảnh QR (.png)** → tải xuống tệp `.png` mở được bằng Windows Photos và quét lại được.
- [ ] **A07**: Bấm **Hủy mã mời** → card QR biến mất và hiển thị thông báo mã ghép nối trước đã bị hủy.
- [ ] **A08**: Tạo mã mời 1 → chưa dùng → bấm **Tạo mã mới** → sinh mã mời 2 mới, đồng thời yêu cầu chờ cũ (nếu có) không thể chấp thuận hay nhận token nữa.
- [ ] **A09**: Để mã mời tự hết hạn (hoặc dùng test TTL ngắn) → không chấp nhận ghép nối từ mã đã hết hạn.
- [ ] **A10**: Tắt checkbox "Tự động duyệt", thiết bị gửi yêu cầu → mục "Yêu cầu ghép nối đang chờ phê duyệt" hiện đúng tên thiết bị và IP LAN.
- [ ] **A11**: Bấm **Chấp thuận** → thiết bị nhận token đúng 1 lần và chuyển sang "Đã cấp quyền / Đang kết nối".
- [ ] **A12**: Tạo mã khác, thiết bị gửi yêu cầu → bấm **Từ chối** → Client báo `ENROLLMENT_REJECTED`, không có bản ghi thiết bị nào được cấp quyền.

## Nhóm B — Windows Client QR Import, Payload & Strict Pinning (11 mục)
- [ ] **B01**: Trên Laptop Client (Host cục bộ vẫn TẮT) mở Server → **Kết nối Server**.
- [ ] **B02**: Bấm **Nhập ảnh QR** và chọn file `.png` vừa tải từ Host → giải mã ngay cục bộ (kể cả khi tắt Internet), điền đúng JSON `doremi-pair` v1 vào khung nhập.
- [ ] **B03**: Khung xem trước (Preview) hiển thị đúng Tên Host, LAN Endpoint (`IP:port`), Full SPKI SHA-256 Fingerprint trước khi bấm ghép nối.
- [ ] **B04**: Dán một URL lạ (ví dụ `https://example.com`) vào khung Payload → Preview báo lỗi `UNSUPPORTED_URI_SCHEME`, nút **Xác nhận & Ghép nối QR** bị khóa.
- [ ] **B05**: Dán JSON chứa khóa `__proto__` hoặc sai IP công cộng (`8.8.8.8`) → bị chặn ngay tại chỗ.
- [ ] **B06**: Dán JSON hợp lệ đã hết hạn `expiresAt` → bị chặn báo hết hạn mà không gửi yêu cầu mạng.
- [ ] **B07**: Ghép nối bằng nút **Xác nhận & Ghép nối QR** → kết nối thành công tới Host, tự động tải thư viện Remote.
- [ ] **B08**: Nhập lại chính ảnh QR/JSON vừa ghép nối lần nữa trên máy khác hoặc cùng máy → bị Host từ chối mã đã sử dụng (`ENROLLMENT_EXPIRED`).
- [ ] **B09**: Kiểm tra phương án ghép nối thủ công (nhập IP + Cổng -> Kiểm tra & Xác minh Host -> nhập mã mời) vẫn hoạt động bình thường.
- [ ] **B10**: Kiểm tra Quét LAN (mDNS) nếu router cho phép multicast vẫn phát hiện Host đúng vân tay.
- [ ] **B11**: Đóng Client, mở lại → bấm **Kết nối** vào "Host đã ghi nhớ" → kết nối lại nhanh không cần ghép nối lại (nhờ DPAPI `safeStorage`).

## Nhóm C — Access Control, Credential Rotation & Revocation (10 mục)
- [ ] **C01**: Khi Client đang phát nhạc FLAC/ALAC bình thường, bấm **Xoay vòng Token** trên Client → thông báo thành công, nhạc tiếp tục hoặc phát bài kế tiếp bình thường.
- [ ] **C02**: Kiểm tra sự kiện bảo mật trên Host/Client trong tab **Chẩn đoán** ghi nhận `credential_rotated` mà không lộ chuỗi token thô.
- [ ] **C03**: Trên Host, đổi tên thiết bị Client → cập nhật ngay trên danh sách thiết bị.
- [ ] **C04**: Trên Host, bấm **Ngắt kết nối** cho thiết bị đang mở → luồng stream đang mở dừng sạch, Client có thể kết nối lại sau đó vì quyền chưa bị thu hồi.
- [ ] **C05**: Client đang phát nhạc Remote → Host bấm **Thu hồi quyền** → âm thanh dừng ngay, Client báo lỗi `ACCESS_REVOKED`, không tự phát bài khác bằng token cũ.
- [ ] **C06**: Tắt Host rồi bật lại (hoặc tắt hẳn app Host mở lại) → thiết bị đã thu hồi vẫn bị chặn `ACCESS_REVOKED`, không thể kết nối lại.
- [ ] **C07**: Xóa thiết bị đã thu hồi khỏi danh sách bằng nút thùng rác → danh sách sạch sẽ, dữ liệu nhạc cục bộ không ảnh hưởng.
- [ ] **C08**: Trên Host có 2 máy Client cùng kết nối, thu hồi máy A → máy B vẫn duyệt và phát nhạc bình thường không gián đoạn.
- [ ] **C09**: Xóa 1 thư mục chia sẻ trên Host trong khi Client đang duyệt/phát → Client không thể tải lại bài thuộc thư mục đó, thư mục khác chia sẻ còn lại vẫn phát bình thường.
- [ ] **C10**: Trên Host bấm **Xoay khóa định danh TLS** (`Rotate Host Identity`) → khi Client cũ kết nối lại qua Probe/Connect, bị cảnh báo `HOST_IDENTITY_MISMATCH` và chặn kết nối tự động.

## Nhóm D — Security Hardening & Diagnostics Hygiene (10 mục)
- [ ] **D01**: Nhập sai mã mời quá 5 lần liên tiếp trên Client → Host trả về `429 RATE_LIMITED` (tạm khóa ngắn theo IP).
- [ ] **D02**: Kiểm tra file `%APPDATA%\Lossless Player\connect\secrets.json` bằng trình soạn thảo văn bản → token/privateKey đều nằm trong phong bì `dpapi-safe-storage`, không thấy chuỗi plaintext `deviceToken` hay `BEGIN PRIVATE KEY`.
- [ ] **D03**: Mở tab **Chẩn đoán** → xem mục **Cấu trúc bảo vệ** hiển thị `TLS >= 1.2 + SPKI Pinning · DPAPI SafeStorage` (không hiển thị % điểm bảo mật giả).
- [ ] **D04**: Mở rộng **Chi tiết kỹ thuật & Nhật ký** → kiểm tra mục **Sự kiện bảo mật Host / Client** hiển thị rõ ràng timeline sự kiện.
- [ ] **D05**: Bấm **Sao chép báo cáo Connect** → dán vào Notepad kiểm tra: **KHÔNG** chứa `inviteCode`, `pairingPayload`, `deviceToken`, `pollToken`, `privateKeyPem`, hay mật khẩu.
- [ ] **D06**: Kiểm tra `library.db` hoặc file backup database không lưu token thô hay Private Key PEM.
- [ ] **D07**: Mở Cài đặt → **Hướng dẫn sử dụng** → tìm từ khóa `QR` hoặc `SPKI` → chương 13 hiển thị thông tin Phase 6.2 chính xác.
- [ ] **D08**: Kiểm tra DevTools (nếu kiểm tra bản Dev) không báo lỗi CSP violation hay uncaught promise rejection khi dùng QR import.
- [ ] **D09**: Nếu tạo thư mục symlink/junction trỏ ra ngoài thư mục chia sẻ → không được phát/truy cập qua API stream.
- [ ] **D10**: Thử chọn ảnh không phải QR hoặc ảnh hỏng vào nút **Nhập ảnh QR** → hiển thị thông báo lỗi tiếng Việt rõ ràng, app không crash.

## Nhóm E — Audio Stability, Remote Regression & Low-End Hardware Check (10 mục)
- [ ] **E01**: Phát nhạc **FLAC 16-bit & 24-bit Hi-Res** qua LAN từ Client vừa ghép nối QR → mượt, không click/pop.
- [ ] **E02**: Phát nhạc **ALAC `.m4a`** (bao gồm `Có Thể (102112 Version)` và 1 bài ALAC khác) qua LAN → phát chuẩn, không `DEMUXER_ERROR`.
- [ ] **E03**: Phát nhạc **AAC `.m4a`**, **WAV**, **MP3** qua LAN → tất cả phát bình thường.
- [ ] **E04**: Tua (Seek) tới/lui nhiều lần liên tục trên FLAC & ALAC → phản hồi nhanh, không `429`.
- [ ] **E05**: Tạm dừng (Pause) nhạc Remote quá **35 giây** rồi bấm Resume → tiếp tục phát mượt không đứt stream.
- [ ] **E06**: Tìm kiếm bài hát trên Remote Library -> bấm Phát -> mở Now Playing -> quay lại -> bấm `X` / `Xóa bộ lọc` (regression Phase 6.1.3) → danh sách khôi phục đúng ngay lập tức, nhạc vẫn phát liên tục.
- [ ] **E07**: Phát nhạc Local trên máy Host đồng thời khi Client đang stream LAN → cả hai phát độc lập, không giật tiếng.
- [ ] **E08**: Kiểm tra Audio Lab (EQ, Headroom, ReplayGain, Spectrum) và Next/Previous/Auto Next hoạt động chuẩn trên Client.
- [ ] **E09**: Quan sát CPU & RAM trên laptop i5-1035G1 / 8GB RAM ở chế độ Standby & khi stream FLAC/ALAC trong 15–30 phút (không rò rỉ bộ nhớ, quạt ổn định).
- [ ] **E10**: Tắt Host Server gọn gàng rồi thoát app DoReMi → tiến trình đóng hoàn toàn không treo ngầm trong Task Manager.
