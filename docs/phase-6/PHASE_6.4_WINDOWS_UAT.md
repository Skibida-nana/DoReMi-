# DoReMi Windows — Phase 6.4 UAT Checklist & Hướng dẫn thử nghiệm chuyển mạng thực tế (`1.0.0-rc.8`)

- **Phiên bản mục tiêu**: `DoReMi v1.0.0-rc.8` (`Phase 6.4 — Smart Connection Manager, Automatic Transport Selection, Network Recovery & Playback Handover`)
- **Tổng số mục nghiệm thu**: **68 mục** (`Nhóm A: 8` · `Nhóm B: 12` · `Nhóm C: 16` · `Nhóm D: 18` · `Nhóm E: 8` · `Nhóm F: 6`)
- **Trạng thái hiện tại**: `AUTOMATED & CHROMIUM SIMULATED HANDOVER VERIFIED` · **`PHYSICAL TWO-DEVICE NETWORK UAT PENDING`**

---

## Hướng dẫn nhanh: Thử nghiệm thực tế với 2 máy Windows (Wi-Fi nhà ↔ Điểm phát sóng 4G/5G điện thoại)

> [!WARNING]
> **Cảnh báo dung lượng dữ liệu di động (4G/5G)**: File nhạc Lossless (`FLAC 16/24-bit`, `WAV`, `ALAC`) có kích thước từ `25 MB – 120 MB` mỗi bài. Khi laptop Client kết nối qua Hotspot điện thoại (`Remote HTTPS`), lưu lượng tải nhạc sẽ tính trực tiếp vào gói dữ liệu 4G/5G của điện thoại và đi qua giới hạn băng thông relay miễn phí của Tailscale Funnel. Hãy kiểm tra gói data trước khi thử nghiệm nhiều bài Hi-Res.

### Bước chuẩn bị tại nhà (Cùng mạng Wi-Fi)
1. **Trên máy PC ở nhà (Host)**:
   - Mở `DoReMi v1.0.0-rc.8` -> mục **Server**.
   - Bật **Host Server**, chọn ít nhất 1 thư mục nhạc chia sẻ (có đủ bài `FLAC`, `ALAC` ví dụ *Có Thể (102112 Version)*, `WAV`, `AAC/M4A`).
   - Bật **Truy cập từ xa qua Internet (Remote HTTPS · Tailscale Funnel)** -> xác nhận trạng thái **READY** (đã cài và đăng nhập Tailscale Windows).
   - Trong tab **Thiết bị**, nếu chưa ghép nối laptop thì tạo mã QR ghép nối; sau khi ghép nối xong, bật công tắc **Cho phép Remote HTTPS** cho thiết bị laptop đó.
2. **Trên Laptop (Client) khi đang bắt Wi-Fi nhà**:
   - Mở mục **Server -> Kết nối tới Host**.
   - Đảm bảo chế độ kết nối của Host đang chọn là **`Tự động`** (mặc định cho Host mới; nếu nâng cấp từ `rc.7`, chuyển từ `Chỉ LAN` / `Chỉ Remote` sang **`Tự động`**).
   - Bấm **Kết nối** -> trạng thái hiển thị **`Đang kết nối qua LAN`**.
   - Bấm nút **`Đồng bộ Remote`** một lần để lưu gói thông tin điểm cuối Remote đã ký và Remote Token vào bộ nhớ mã hóa của Laptop.

### Kịch bản 1 — Rời mạng nhà sang 4G/5G (`LAN -> Remote HTTPS`)
1. Trên Laptop, mở một bài nhạc `FLAC` hoặc `ALAC` từ Host và để nhạc đang phát ở khoảng `0:30 – 1:00`.
2. Trên điện thoại, bật **Điểm truy cập cá nhân (Mobile Hotspot)** bằng mạng 4G/5G (tắt Wi-Fi trên điện thoại để không cầu nối lại Wi-Fi nhà).
3. Chuyển Wi-Fi của Laptop từ Wi-Fi nhà sang **Hotspot điện thoại**:
   - Quan sát nhãn trạng thái chuyển sang **`Đang kết nối lại...` / `Đang chuyển kết nối...`** rồi sang **`Đang kết nối qua Remote HTTPS`**.
   - Bài hát đang nghe tiếp tục phát gần đúng mốc thời gian cũ mà không văng lỗi, không mất Queue / Tìm kiếm.

### Kịch bản 2 — Quay lại Wi-Fi nhà (`Remote HTTPS -> LAN Direct` · Make-Before-Break)
1. Trong khi nhạc vẫn đang phát qua Hotspot (`Đang kết nối qua Remote HTTPS`), chuyển Wi-Fi của Laptop quay về **Wi-Fi nhà**.
2. Sau vài giây xác nhận mạng LAN ổn định (`~2.5s`), DoReMi tự xác minh LAN ở nền rồi chuyển mượt sang **`Đang kết nối qua LAN`** mà không cần bấm kết nối lại thủ công.

---

## Bảng Checklist Nghiệm thu 68 Mục (`Groups A – F`)

### Nhóm A — Bảo toàn dữ liệu & Trình phát nhạc Offline cục bộ (`8 mục`)
- [ ] **A01**: Khởi chạy `DoReMi v1.0.0-rc.8` trên dữ liệu sẵn có từ `rc.7` mà không mất thư viện, lịch sử nghe hay cấu hình cá nhân.
- [ ] **A02**: Toàn bộ Playlist, bài hát Yêu thích, ảnh bìa tùy chỉnh và lời bài hát tùy chỉnh được giữ nguyên 100%.
- [ ] **A03**: Phát nhạc cục bộ các định dạng `FLAC`, `ALAC (.m4a)`, `WAV`, `MP3`, `AAC`, `OGG`, `Opus` hoạt động bình thường khi Server tắt.
- [ ] **A04**: Tua nhạc (Seek), Tạm dừng / Phát tiếp, Bài kế / Bài trước, Smart Shuffle, Repeat và Auto Continue cục bộ hoạt động đúng.
- [ ] **A05**: Audio Lab (10-Band Graphic EQ, Parametric EQ, Preamp, ReplayGain, Spectrum) hoạt động ổn định trên nhạc cục bộ.
- [ ] **A06**: Giao diện Trang chủ (Editorial Gallery 7 thẻ + Giant Typography), Mini Player, Now Playing, Focus Vinyl, Themes & Custom Fonts giữ nguyên bản sắc.
- [ ] **A07**: Khi không kết nối Server, ứng dụng không phát sinh kết nối mạng nền hay chu kỳ quét mDNS/Tailscale.
- [ ] **A08**: Đóng mở lại ứng dụng lưu đúng âm lượng, bài đang dừng, giao diện và chế độ hiệu năng.

### Nhóm B — Lựa chọn chế độ kết nối (`Automatic`, `Chỉ LAN`, `Chỉ Remote`) (`12 mục`)
- [ ] **B01**: Host mới ghép nối mặc định được gán chế độ **`Tự động` (`Automatic`)**.
- [ ] **B02**: Host cũ nâng cấp từ `rc.7` giữ nguyên chính sách người dùng đã chọn trước đó (`Chỉ LAN` hoặc `Chỉ Remote`) cho đến khi người dùng đổi sang `Tự động`.
- [ ] **B03**: Ở chế độ **`Tự động`** khi cả LAN và Remote HTTPS đều khả dụng, Client luôn ưu tiên chọn **`Đang kết nối qua LAN`**.
- [ ] **B04**: Ở chế độ **`Tự động`** khi khác mạng LAN (chỉ có Internet), Client tự chọn **`Đang kết nối qua Remote HTTPS`**.
- [ ] **B05**: Ở chế độ **`Chỉ LAN`** khi cùng mạng LAN, Client kết nối thành công qua LAN Direct.
- [ ] **B06**: Ở chế độ **`Chỉ LAN`** khi ngoài mạng LAN (dù Remote HTTPS đang bật), Client báo `Không tìm thấy Host` và **tuyệt đối không** dùng Remote HTTPS.
- [ ] **B07**: Ở chế độ **`Chỉ Remote`** khi Remote HTTPS sẵn sàng (dù đang ngồi cùng mạng LAN), Client kết nối qua **`Remote HTTPS`** và không dùng LAN Direct.
- [ ] **B08**: Ở chế độ **`Chỉ Remote`** khi Remote HTTPS tắt (dù LAN đang mở), Client báo lỗi kết nối và **không tự chuyển về LAN**.
- [ ] **B09**: Đổi chế độ trực tiếp từ `Tự động (LAN)` sang `Chỉ Remote` ngay khi đang kết nối thực hiện chuyển sang `Remote HTTPS` tức thì.
- [ ] **B10**: Đổi chế độ từ `Chỉ Remote` về `Tự động` khi đang ở mạng LAN nhà tự động nâng cấp về `Đang kết nối qua LAN`.
- [ ] **B11**: Chế độ kết nối đã chọn cho từng Host được lưu bền vững vào SQLite sau khi thoát và mở lại ứng dụng.
- [ ] **B12**: Nếu có 2 Host đã lưu (kể cả trùng tên hiển thị), mỗi Host giữ riêng chế độ kết nối, khóa SPKI và token độc lập.

### Nhóm C — Chuyển mạng & Khôi phục kết nối (`Network Transitions & Hysteresis`) (`16 mục`)
- [ ] **C01**: Đang kết nối `LAN` ở chế độ `Tự động`, chuyển Laptop sang Hotspot điện thoại -> tự động chuyển sang `Đang kết nối qua Remote HTTPS`.
- [ ] **C02**: Đang kết nối `Remote HTTPS` ở chế độ `Tự động`, chuyển Laptop về Wi-Fi nhà -> tự động xác minh nền và chuyển về `Đang kết nối qua LAN`.
- [ ] **C03**: Tắt hẳn Wi-Fi trên Laptop khi đang ở `LAN` -> hiển thị rõ **`Mất kết nối mạng`** mà không treo giao diện hay lặp kết nối vô tận.
- [ ] **C04**: Tắt hẳn Wi-Fi trên Laptop khi đang ở `Remote HTTPS` -> hiển thị **`Mất kết nối mạng`**.
- [ ] **C05**: Bật lại Wi-Fi nhà sau khi mất mạng -> tự động khôi phục về `Đang kết nối qua LAN` mà không cần mở lại cài đặt Server.
- [ ] **C06**: Bật lại Hotspot điện thoại sau khi mất mạng -> tự động khôi phục về `Đang kết nối qua Remote HTTPS`.
- [ ] **C07**: Máy Host đổi IP LAN (do Router cấp lại DHCP hoặc đổi cổng) trong cùng mạng LAN -> Client tự quét mDNS có xác minh SPKI và cập nhật địa chỉ mới.
- [ ] **C08**: Kết nối vào Wi-Fi lạ có dải IP trùng `192.168.1.x` khi đang dùng `Remote HTTPS` -> Client không gửi token cho thiết bị lạ và giữ nguyên `Remote HTTPS` không gián đoạn.
- [ ] **C09**: Nhấp nháy mạng ngắn dưới ngưỡng lỗi -> hấp thụ mượt (`DEGRADED` -> `CONNECTED`), không ngắt bài nhạc không cần thiết.
- [ ] **C10**: Bật/tắt đổi mạng liên tục nhiều lần trong vài giây -> cơ chế Debounce & Cooldown chặn hiện tượng nhảy qua lại liên tục (`flapping`).
- [ ] **C11**: Tắt hoàn toàn cả Host LAN và Funnel Remote -> Client thử lại theo chu kỳ giãn dần tối đa 6 lần rồi dừng nghỉ ở **`Không tìm thấy Host`** (`0` CPU/network storm).
- [ ] **C12**: Bấm nút **`Thử kết nối lại`** thủ công sau khi Host bật lại -> kết nối thành công ngay lập tức.
- [ ] **C13**: Bấm **`Ngắt kết nối`** trong lúc đang thử kết nối lại -> hủy ngay mọi tác vụ và bộ đếm hẹn giờ đang chạy.
- [ ] **C14**: Máy Host vẫn phát nhạc cục bộ mượt mà trong suốt quá trình Laptop chuyển mạng nhiều lần.
- [ ] **C15**: Số lượng thiết bị đang kết nối trên Host không bị nhân đôi giả tạo sau nhiều lần chuyển đổi `LAN <-> Remote` (vẫn tính đúng 1 thiết bị).
- [ ] **C16**: Kết nối đồng thời tới 3 thiết bị được cấp phép (trộn LAN và Remote) hoạt động đúng trong giới hạn `maxActiveClients = 3`.

### Nhóm D — Bàn giao phát nhạc không gián đoạn (`Playback Handover`) (`18 mục`)
- [ ] **D01**: Phát bài **`FLAC 16-bit/44.1kHz`** và chuyển `LAN -> Remote HTTPS` -> nhạc tự phát tiếp gần đúng vị trí thời gian đang nghe.
- [ ] **D02**: Phát bài **`FLAC 16-bit/44.1kHz`** và chuyển `Remote HTTPS -> LAN` (`Make-Before-Break`) -> chuyển mượt về LAN gần như không khựng tiếng.
- [ ] **D03**: Phát bài **`ALAC (.m4a)`** (bao gồm bài mẫu *Có Thể (102112 Version)*) và chuyển `LAN -> Remote -> LAN` -> phát tiếp chuẩn xác, không tải toàn bộ file về RAM.
- [ ] **D04**: Phát bài **`ALAC 24-bit/48kHz`** (kể cả `moov` cuối file) qua chuyển đổi `LAN <-> Remote` -> âm thanh nguyên vẹn, tua mượt.
- [ ] **D05**: Phát bài **`WAV`** qua chuyển đổi `LAN <-> Remote` -> phát tiếp đúng vị trí.
- [ ] **D06**: Phát bài **`AAC (.m4a)`** qua chuyển đổi `LAN <-> Remote` -> phát tiếp đúng vị trí.
- [ ] **D07**: Phát bài **`Hi-Res FLAC (24-bit/96kHz)`** qua chuyển đổi `LAN <-> Remote` -> giữ nguyên thông số mẫu gốc (lưu ý băng thông mạng di động).
- [ ] **D08**: Nếu người dùng đang **Tạm dừng (Paused)** bài hát lúc chuyển mạng -> sau khi chuyển mạng xong bài hát **vẫn giữ trạng thái Tạm dừng** ở đúng giây đó (không tự phát ngoài ý muốn).
- [ ] **D09**: Bấm **Phát tiếp (Resume)** sau khi chuyển mạng lúc đang tạm dừng -> phát ngay trên đường truyền mới.
- [ ] **D10**: Thao tác **Tua (Seek)** ngay sau khi bàn giao kết nối hoạt động chính xác.
- [ ] **D11**: Nút **Bài kế (Next)**, **Bài trước (Previous)** và **Tự chuyển bài (Auto Next)** cuối bài hoạt động đúng với Hàng đợi hiện tại sau khi chuyển mạng.
- [ ] **D12**: Hàng đợi phát (Queue), trạng thái **Smart Shuffle** và **Repeat** được giữ nguyên vẹn xuyên suốt quá trình chuyển mạng.
- [ ] **D13**: Âm lượng (Volume), Mute, cấu hình **EQ** và **ReplayGain** không bị reset hay nhảy âm lượng khi bàn giao đường truyền.
- [ ] **D14**: Ô tìm kiếm, từ khóa đang lọc và bộ lọc Album/Nghệ sĩ của Thư viện Remote không bị xóa trắng hay kẹt khi mạng đang kết nối lại / chuyển đường truyền.
- [ ] **D15**: Lời bài hát từ xa (Remote Lyrics) tiếp tục hiển thị và tải bình thường sau khi chuyển đổi `LAN <-> Remote`.
- [ ] **D16**: Chọn phát một bài nhạc **cục bộ trên Laptop** bất kỳ lúc nào (kể cả khi Server đang kết nối lại) phát ngay lập tức không bị chặn.
- [ ] **D17**: Thống kê phiên nghe nhạc (Listening Statistics) không bị nhân đôi lượt nghe giả và không cộng thời gian chờ mạng đứt vào thời gian nghe thực tế.
- [ ] **D18**: Nếu file gốc trên Host bị xóa hoặc ngừng chia sẻ giữa chừng -> chỉ dừng bài hát đó với thông báo rõ ràng mà không lặp chuyển mạng sai.

### Nhóm E — Bảo mật, Thu hồi quyền & Xác minh định danh (`8 mục`)
- [ ] **E01**: Thiết bị chỉ mới ghép nối LAN (chưa được cấp quyền Remote trên Host) -> chế độ `Tự động` dùng LAN bình thường nhưng không thể truy cập qua Internet.
- [ ] **E02**: Host tắt công tắc **Cho phép Remote HTTPS** của thiết bị khi thiết bị đang nghe qua Remote -> ngắt ngay luồng Remote; nếu thiết bị đang ở Wi-Fi nhà thì vẫn nghe được qua LAN ở chế độ `Tự động`.
- [ ] **E03**: Host bấm **Thu hồi quyền (Revoke Device)** toàn phần -> chặn ngay lập tức cả LAN và Remote HTTPS (`Đã thu hồi quyền`), dừng phát nhạc từ xa và không tự thử lại.
- [ ] **E04**: Host thực hiện **Xoay vòng khóa định danh (Rotate Host Identity)** -> Client phát hiện lệch vân tay mật mã, chặn kết nối (`Xác minh bảo mật thất bại`) trên cả LAN và Remote, không gửi bất kỳ token nào.
- [ ] **E05**: Gói thông tin Remote Endpoint Descriptor hết hạn (`expiresAt`) -> Client từ chối kết nối Remote hết hạn và hướng dẫn đồng bộ lại khi về mạng LAN tin cậy.
- [ ] **E06**: Thiết bị mDNS giả mạo trong mạng LAN công cộng quảng bá trùng `hostId` -> bị từ chối ở bước kiểm tra SPKI, không lộ token và không làm sập kết nối `Remote HTTPS` đang nghe.
- [ ] **E07**: Nhật ký Chẩn đoán (`SmartConnectionDiagnostics`) hiển thị rõ lịch sử chuyển đổi nhưng tuyệt đối không chứa chuỗi Bearer Token hay khóa bí mật.
- [ ] **E08**: Khi tắt Remote Access trên Host, chỉ đúng route `/doremi-connect` do DoReMi tạo được gỡ bỏ, không đụng chạm cấu hình Tailscale khác của người dùng.

### Nhóm F — Ổn định đóng gói & Giải phóng tài nguyên (`6 mục`)
- [ ] **F01**: Bản cài đặt `NSIS Setup`, `Portable EXE` và `Portable ZIP` (`1.0.0-rc.8`) khởi chạy mượt, hiển thị đúng phiên bản `1.0.0-rc.8` trong mục **Giới thiệu**.
- [ ] **F02**: Nội dung **Hướng dẫn sử dụng** tích hợp trong ứng dụng (Chương 13 & Chương 15) hiển thị đầy đủ hướng dẫn chế độ `Tự động / Chỉ LAN / Chỉ Remote`.
- [ ] **F03**: Theo dõi Task Manager trên Laptop phổ thông (CPU dòng U, 8 GB RAM) khi nghe ở chế độ `Tự động`: CPU và RAM giữ mức nhẹ tương đương `rc.7`, không tăng dần theo thời gian.
- [ ] **F04**: Đóng ứng dụng DoReMi khi đang phát từ xa -> tiến trình thoát sạch hoàn toàn trong Task Manager, không treo tiến trình ngầm.
- [ ] **F05**: Kiểm tra mã băm `SHA256SUMS.txt` khớp 100% với các tệp phát hành trong `release/v1.0.0-rc.8/`.
- [ ] **F06**: Các thư mục phát hành trước (`release/v1.0.0-rc.1` đến `v1.0.0-rc.7`) vẫn còn nguyên vẹn để đối chiếu hoặc khôi phục khi cần.
