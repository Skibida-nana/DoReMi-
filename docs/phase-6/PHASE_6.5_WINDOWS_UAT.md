# HƯỚNG DẪN NGHIỆM THU THỰC TẾ TRÊN WINDOWS (PHASE 6.5 UAT — `v1.0.0-rc.9`)

Tài liệu này giúp bạn kiểm tra thực tế các nâng cấp về **Tiết kiệm tài nguyên, Quản lý nguồn điện chống ngủ máy Host và Độ ổn định chạy dài** của bản **`DoReMi v1.0.0-rc.9`** trước khi bước sang đợt rà soát hợp nhất Phase 6.3 + 6.4 + 6.5.

Quy ước đánh dấu kết quả: **`PASS`** (Đạt) · **`FAIL`** (Lỗi) · **`SKIP`** (Bỏ qua có chủ đích) · **`NOT RUN`** (Chưa chạy).

---

## PHẦN 1 — DANH SÁCH ƯU TIÊN KIỂM TRA NHANH (12 BƯỚC QUAN TRỌNG NHẤT — KHUYÊN DÙNG TRƯỚC)

Nếu bạn muốn kiểm tra nhanh trong khoảng **15–20 phút**, hãy thực hiện 12 mục cốt lõi sau:

| Mã | Nội dung kiểm tra nhanh | Cách thực hiện ngắn gọn | Kết quả mong đợi | Trạng thái |
|---|---|---|---|---|
| **Q-01** | Mở bản `rc.9` giữ nguyên toàn bộ dữ liệu cũ | Cài/mở `DoReMi v1.0.0-rc.9` trên máy đang có sẵn thư viện từ `rc.8` | Thư viện cục bộ, Playlist, EQ, thiết bị đã ghép nối và Host đã lưu còn nguyên vẹn 100% | `[ ]` |
| **Q-02** | Nghe nhạc cục bộ khi tắt Server | Để Host ở trạng thái **Tắt**, phát thử 1 bài FLAC và 1 bài ALAC cục bộ | Nhạc phát ngay lập tức, tua mượt, Task Manager ghi nhận CPU rất thấp, không có kết nối mạng ngoài | `[ ]` |
| **Q-03** | Kiểm tra mặc định **"Theo hệ thống"** | Mở trang **Server**, xem mục **Chế độ nguồn điện máy Host** | Mặc định chọn **"Theo hệ thống"**, huy hiệu ghi rõ *Cho phép Windows ngủ tự nhiên* | `[ ]` |
| **Q-04** | Kiểm tra `powercfg /requests` khi chọn **"Giữ thức khi bật Host"** | Mở **Command Prompt (Run as Administrator)**, bật Host, chọn **"Giữ thức khi bật Host"**, gõ `powercfg /requests` | Dưới mục `[SYSTEM]` hoặc `[EXECUTION]` xuất hiện tiến trình `DoReMi.exe`, còn mục `[DISPLAY]` **không** bị giữ sáng | `[ ]` |
| **Q-05** | Kiểm tra nhả khóa chống ngủ ngay khi **Tắt Host** | Nhấn **Tắt Host**, chạy lại `powercfg /requests` trong cửa sổ Admin CMD | `DoReMi.exe` biến mất hoàn toàn khỏi `powercfg /requests` | `[ ]` |
| **Q-06** | Chế độ **"Giữ thức khi đang phát từ xa"** | Bật Host + chọn **"Giữ thức khi đang phát từ xa"**; dùng máy Client phát 1 bài nhạc qua LAN hoặc Remote | Trong lúc đang phát, huy hiệu hiện **Đang giữ máy thức** (và hiện trong `powercfg /requests`); sau khi bấm Dừng trên Client khoảng **45 giây**, khóa giữ thức tự nhả | `[ ]` |
| **Q-07** | Màn hình vẫn tự tắt bình thường | Đặt thời gian tắt màn hình Windows ngắn (ví dụ 1–2 phút) trong lúc đang giữ máy thức | Màn hình tắt tối bình thường để tiết kiệm điện, nhưng nhạc trên máy Client vẫn phát liên tục không đứt | `[ ]` |
| **Q-08** | Tạm dừng bài hát từ xa trên **45 giây** rồi nghe tiếp | Trên máy Client đang nghe FLAC/ALAC từ xa, bấm **Pause**, đợi khoảng 45–60 giây rồi bấm **Play** | Nhạc phát tiếp ngay tại đúng vị trí đang dừng mà không báo lỗi mất kết nối | `[ ]` |
| **Q-09** | Tua nhanh và chuyển bài liên tục từ xa | Trên máy Client, kéo thanh tua 10–15 lần liên tiếp và bấm Next qua nhiều định dạng (FLAC, ALAC, WAV, AAC) | Phản hồi nhanh, RAM của `DoReMi.exe` trong Task Manager giữ ổn định không tăng vọt | `[ ]` |
| **Q-10** | Bàn giao tự động `Wi-Fi nhà ↔ Hotspot 4G/5G` (kết hợp Phase 6.4) | Để Client ở chế độ **Tự động**, đang phát nhạc trên Wi-Fi nhà thì đổi sang Hotspot điện thoại rồi đổi ngược lại | Tự chuyển sang **Remote HTTPS** và tự quay lại **LAN Direct** mà không văng nhạc hay tự phát khi đang Pause | `[ ]` |
| **Q-11** | Cho máy Host **Sleep** rồi đánh thức (**Resume**) | Khi Host đang bật, nhấn **Sleep** trên Windows, đợi 10 giây rồi đánh thức máy dậy | Ứng dụng không treo; kết nối LAN hoạt động lại; nếu tuyến Funnel bị ngắt thì báo rõ trạng thái thay vì tự mở lại ngầm | `[ ]` |
| **Q-12** | Thu nhỏ cửa sổ DoReMi xuống thanh Taskbar | Thu nhỏ cửa sổ DoReMi trên cả máy Host và Client trong khi vẫn nghe nhạc | Nhạc phát ổn định, mức chiếm dụng CPU giảm thấp hơn khi mở giao diện | `[ ]` |

---

## PHẦN 2 — BỘ CHECKLIST ĐẦY ĐỦ 72 HẠNG MỤC NGHIỆM THU (NHÓM A – G)

### Nhóm A — Bảo toàn Phát nhạc Cục bộ & Dữ liệu Người dùng (10 mục)
- [ ] **A-01**: Phát tệp FLAC `16-bit/44.1kHz` cục bộ bình thường khi Host tắt (`PASS` / `FAIL` / `SKIP` / `NOT RUN`).
- [ ] **A-02**: Phát tệp Hi-Res FLAC `24-bit/96kHz+` cục bộ không giật tiếng, giữ nguyên thông số gốc.
- [ ] **A-03**: Phát tệp ALAC (`.m4a`, ví dụ *Có Thể (102112 Version)*) cục bộ qua bộ giải mã WASM mượt mà.
- [ ] **A-04**: Phát các định dạng WAV, MP3, AAC, OGG, Opus cục bộ và tua `HTTP 206` chính xác.
- [ ] **A-05**: Toàn bộ thư viện SQLite, Playlist, Yêu thích, Lịch sử nghe và Thống kê từ `rc.8` được giữ nguyên.
- [ ] **A-06**: Audio Lab (Preamp, 10-band Graphic EQ, 8-band Parametric EQ, ReplayGain) hoạt động bình thường.
- [ ] **A-07**: Giao diện Trang chủ (Editorial Gallery 7 thẻ + Giant Typography), MiniPlayer, Now Playing, Theme và Font cá nhân hóa giữ nguyên bản sắc.
- [ ] **A-08**: Lời bài hát cục bộ giữ đúng thứ tự ưu tiên `Custom > External LRC > Embedded`.
- [ ] **A-09**: Khi không bật Server và không kết nối Host nào, ứng dụng không mở cổng lắng nghe mạng và không phát sinh lưu lượng nền.
- [ ] **A-10**: Đóng và mở lại ứng dụng nhiều lần không làm hỏng cơ sở dữ liệu `library.db`.

### Nhóm B — Hiệu quả Tài nguyên Máy chủ & Máy khách (12 mục)
- [ ] **B-01**: Khi `Host OFF`, RAM và CPU của tiến trình `DoReMi.exe` ở mức nền tối thiểu (`~0%` CPU khi nghỉ).
- [ ] **B-02**: Khi bật `Host STANDBY` (chưa có Client nghe nhạc), CPU nghỉ gần `0%`, không tự quét dựng toàn bộ danh sách thư viện cho tới khi có Client mở xem.
- [ ] **B-03**: Khi 1 Client phát FLAC qua **LAN Direct**, kết nối TLS được tái sử dụng mượt mà giữa các đoạn Range (không giật hay tăng CPU).
- [ ] **B-04**: Khi 1 Client phát FLAC qua **Remote HTTPS (Tailscale Funnel)**, luồng phát ổn định không phải bắt tay TLS lại liên tục khi tua.
- [ ] **B-05**: Khi 1 Client phát ALAC từ xa, bộ nhớ của Client ổn định và tự giảm xuống sau khi chuyển sang bài FLAC/MP3 khác.
- [ ] **B-06**: Khi 3 thiết bị Client cùng phát nhạc đồng thời (`maxActiveClients = 3`), máy Host vẫn phản hồi mượt và phát nhạc cục bộ không bị khựng.
- [ ] **B-07**: Cuộn nhanh danh sách bài hát có nhiều ảnh bìa trong Thư viện Remote không gây lỗi `429` làm ngắt tiếng bài nhạc đang phát.
- [ ] **B-08**: Xem lời bài hát từ xa liên tiếp và khi chuyển mạng không phải tải lặp lại không cần thiết; nếu sửa lời bài hát trên Host và làm mới thì nhận nội dung mới.
- [ ] **B-09**: Sửa hoặc thay tệp FLAC trên Host khi Client kiểm tra lại tính nhất quán không dùng nhầm kế hoạch header cũ.
- [ ] **B-10**: Thu nhỏ cửa sổ DoReMi (Minimize) tạm dừng các bộ cập nhật giao diện không cần thiết mà không ảnh hưởng phát nhạc.
- [ ] **B-11**: Bấm **Ngắt kết nối** trên Client đóng sạch các kết nối mạng đang giữ tới Host.
- [ ] **B-12**: Bấm **Tắt Host** giải phóng ngay cổng LAN, cổng loopback Remote Gateway, tuyến Funnel do DoReMi tạo và các bộ đệm RAM của Server.

### Nhóm C — Chính sách Nguồn điện Windows & Chống ngủ Máy chủ (14 mục)
- [ ] **C-01**: Lần đầu mở trang Server, chính sách nguồn điện mặc định là **Theo hệ thống (`follow-system`)**.
- [ ] **C-02**: Chọn đổi chính sách nguồn điện sang **Giữ thức khi đang phát từ xa** hoặc **Giữ thức khi bật Host**, đóng hoàn toàn DoReMi rồi mở lại -> lựa chọn đã lưu vẫn được giữ nguyên.
- [ ] **C-03**: Ở chế độ **Theo hệ thống**, bật Host và phát nhạc từ xa -> chạy `powercfg /requests` (Admin CMD) xác nhận `DoReMi.exe` **không** chặn Windows Sleep.
- [ ] **C-04**: Ở chế độ **Giữ thức khi đang phát từ xa**, bật Host nhưng **chưa phát nhạc** -> `powercfg /requests` xác nhận chưa giữ thức máy.
- [ ] **C-05**: Ở chế độ **Giữ thức khi đang phát từ xa**, chỉ mở xem danh sách bài hát / ảnh bìa từ xa mà không bấm Play -> vẫn không giữ thức máy vô thời hạn.
- [ ] **C-06**: Ở chế độ **Giữ thức khi đang phát từ xa**, bắt đầu phát nhạc từ Client được cấp quyền -> huy hiệu trên Host báo **Đang giữ máy thức** và `powercfg /requests` hiện `DoReMi.exe`.
- [ ] **C-07**: Khi chuyển sang bài kế tiếp trong Hàng đợi (khoảng nghỉ ngắn vài giây giữa 2 bài), thời gian đệm `45 giây` giữ trạng thái thức liền mạch không bị nhấp nháy tắt/bật.
- [ ] **C-08**: Bấm Dừng / Tạm dừng trên Client và đợi quá `45 giây` không có luồng âm thanh -> khóa giữ thức tự động được nhả sạch trong `powercfg /requests`.
- [ ] **C-09**: Đang giữ thức ở chế độ **Giữ thức khi đang phát từ xa** mà Host bấm **Thu hồi quyền** thiết bị đó -> khóa giữ thức nhả **ngay lập tức** (không chờ hết 45 giây).
- [ ] **C-10**: Chọn chế độ **Giữ thức khi bật Host** khi Host đang bật (kể cả chưa có ai nghe) -> `powercfg /requests` hiện `DoReMi.exe` giữ thức hệ thống.
- [ ] **C-11**: Đang ở **Giữ thức khi bật Host** mà nhấn **Tắt Host** -> `powercfg /requests` xác nhận khóa giữ thức được nhả ngay lập tức.
- [ ] **C-12**: Trong mọi chế độ giữ thức của DoReMi, mục `[DISPLAY]` trong `powercfg /requests` luôn trống để màn hình máy tính vẫn tắt tự nhiên theo cài đặt Windows.
- [ ] **C-13**: Trên laptop dùng pin (rút sạc AC) khi đang có khóa giữ thức hoạt động, giao diện trang Server hiển thị dòng lưu ý rõ ràng rằng máy đang chạy bằng pin.
- [ ] **C-14**: Thoát hẳn ứng dụng DoReMi (`Quit`) trong lúc đang giữ thức -> không bao giờ để sót yêu cầu giữ thức mồ côi trong Windows.

### Nhóm D — Hệ thống Ngủ (`Suspend`), Thức dậy (`Resume`) & Thay đổi Mạng (10 mục)
- [ ] **D-01**: Máy Host đang bật LAN Direct -> cho Windows **Sleep** rồi đánh thức dậy -> cổng HTTPS LAN vẫn truy cập lại được từ Client mà không cần khởi động lại ứng dụng.
- [ ] **D-02**: Máy Host đang bật Remote Access qua Tailscale Funnel -> cho Windows **Sleep** rồi đánh thức dậy khi Tailscale vẫn kết nối tốt -> trạng thái được kiểm tra lại chính xác.
- [ ] **D-03**: Máy Host đang bật Remote Access -> tắt Tailscale (hoặc rút mạng) trong lúc máy ngủ rồi đánh thức dậy -> Host chuyển Remote Access sang cảnh báo lỗi an toàn (**Fail-Closed**), đóng cổng Gateway cục bộ và **không** tự ý mở lại tuyến công cộng ngầm.
- [ ] **D-04**: Máy Host đang ở trạng thái **Tắt (`STOPPED`)** -> sau khi Windows Sleep và thức dậy, Host vẫn giữ nguyên trạng thái **Tắt**.
- [ ] **D-05**: Máy Client đang kết nối tới Host -> cho máy Client **Sleep** rồi đánh thức dậy -> `SmartConnectionManager` tự kiểm tra lại kết nối sạch sẽ mà không bị treo ở socket cũ.
- [ ] **D-06**: Máy Client đang ở trạng thái **Tạm dừng (Pause)** trước khi máy ngủ -> khi thức dậy và khôi phục kết nối, nhạc vẫn đứng ở trạng thái **Pause**, tuyệt đối không tự phát tiếng bất ngờ.
- [ ] **D-07**: Đổi Wi-Fi trên máy Client từ mạng nhà sang Hotspot điện thoại -> chế độ **Tự động** chuyển sang **Remote HTTPS** an toàn.
- [ ] **D-08**: Đổi Wi-Fi trên máy Client từ Hotspot quay về mạng nhà -> chế độ **Tự động** nâng cấp êm (`Make-Before-Break`) về **LAN Direct**.
- [ ] **D-09**: Router cấp lại địa chỉ IP LAN mới cho máy Host -> Client tự tìm lại qua mDNS và xác minh đúng vân tay mật mã SPKI SHA-256 trước khi kết nối.
- [ ] **D-10**: Tắt hoàn toàn Wi-Fi trên Client quá 6 nhịp thử lại -> Client dừng ở trạng thái chờ mạng (`0` vòng lặp quét ngốn CPU) và tự nối lại ngay khi bật Wi-Fi.

### Nhóm E — Bảo mật, Phân tách Quyền & Chống Lạm dụng (10 mục)
- [ ] **E-01**: Ghép nối thiết bị mới qua mã QR / JSON ngoại tuyến dùng 1 lần trong LAN hoạt động chính xác.
- [ ] **E-02**: Thử gửi yêu cầu ghép nối hoặc quản trị qua địa chỉ công cộng Tailscale Funnel -> bị từ chối cứng (`403 PUBLIC_ROUTE_FORBIDDEN`).
- [ ] **E-03**: Dùng Token LAN gọi vào đường dẫn Remote HTTPS (hoặc ngược lại) -> bị từ chối xác thực (`401`).
- [ ] **E-04**: Thiết bị chưa được bật công tắc **Cho phép truy cập từ xa (`remoteAccessEnabled`)** không thể kết nối qua Internet.
- [ ] **E-05**: Tắt công tắc quyền truy cập từ xa của 1 thiết bị đang nghe qua Remote HTTPS -> luồng Remote bị ngắt ngay lập tức nhưng kết nối LAN nội bộ của thiết bị đó vẫn hợp lệ.
- [ ] **E-06**: Khi kết nối đồng thời/lần lượt với 2 máy Host khác nhau, socket và token trong `ScopedHttpsAgentPool` được cách ly hoàn toàn, không bao giờ gửi nhầm token của Host A sang Host B.
- [ ] **E-07**: Các yêu cầu HTTP không có token từ Internet không thể kích hoạt chế độ giữ thức máy Host (`keep-awake-streaming`).
- [ ] **E-08**: Thử truy cập tệp nằm ngoài thư mục đã chia sẻ (hoặc qua symlink trỏ ra ngoài) -> bị chặn hoàn toàn bởi `SharedFilesystemGuard`.
- [ ] **E-09**: Gói thông tin Remote Endpoint hết hạn (`REMOTE_ENDPOINT_EXPIRED`) bị từ chối kết nối cho tới khi đồng bộ lại an toàn qua mạng LAN.
- [ ] **E-10**: Mục Nhật ký bảo mật & Sao chép báo cáo chẩn đoán không bao giờ để lộ Bearer Token, mã mời gốc hay đường dẫn thư mục cá nhân nhạy cảm.

### Nhóm F — Độ ổn định Chạy dài & Dọn dẹp Vòng đời (8 mục)
- [ ] **F-01**: Bật Host ở trạng thái chờ (`STANDBY`) liên tục trên 30–120 phút -> bộ nhớ RAM giữ phẳng, ứng dụng phản hồi tức thì khi có Client kết nối vào.
- [ ] **F-02**: Phát danh sách nhạc dài hỗn hợp (FLAC + Hi-Res + ALAC + WAV + AAC) liên tục trên 1–2 giờ từ Client -> không đứt quãng, không tăng RAM tích lũy.
- [ ] **F-03**: Thực hiện tua nhanh liên tiếp 20–30 lần trên một bài nhạc dài -> không để sót luồng treo hay khóa tệp nhạc trên đĩa cứng máy Host (vẫn đổi tên/kiểm tra tệp sau khi dừng phát bình thường).
- [ ] **F-04**: Bật và tắt Host kết hợp bật/tắt Remote Access lặp lại 5–10 lần liên tiếp -> không báo lỗi trùng cổng, không để sót tuyến Tailscale Funnel mồ côi (`tailscale funnel status` sạch sẽ khi tắt).
- [ ] **F-05**: Tạm dừng bài nhạc từ xa trên 1–2 phút rồi bấm phát tiếp -> không bị đứt luồng do timeout nhầm.
- [ ] **F-06**: Đóng đột ngột cửa sổ DoReMi trên máy Client khi đang phát nhạc -> máy Host tự động giải phóng phiên truyền và đóng file handle sạch sẽ.
- [ ] **F-07**: Chạy công cụ kiểm thử ngâm tự động 2 giờ khi cần (`node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 120`) -> `errorCount = 0`.
- [ ] **F-08**: Chạy công cụ kiểm thử ngâm qua đêm 8 giờ khi cần (`node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 480`) -> `errorCount = 0`.

### Nhóm G — Đối chiếu Ranh giới Phạm vi & Các Hạng mục Hoãn sang Phase 7 (8 mục)
- [ ] **G-01**: Xác nhận bản đóng gói cài đặt (`setup.exe`), bản chạy ngay (`portable.exe`) và bản giải nén (`portable.zip`) trong `release/v1.0.0-rc.9/` khớp mã băm `SHA256SUMS.txt`.
- [ ] **G-02**: Xác nhận không có tiến trình dịch vụ ngầm lạ nào tự khởi động cùng Windows khi người dùng không mở DoReMi.
- [ ] **G-03**: Xác nhận tài liệu hướng dẫn tích hợp trong ứng dụng (**Cài đặt → Hướng dẫn sử dụng**) hiển thị đầy đủ nội dung mới về Quản lý nguồn điện & Tài nguyên ở Chương 13 và Chương 15.
- [ ] **G-04**: Xác nhận `UI-BACKLOG-01` (hiệu ứng quay đĩa than khi phát Remote Playback) vẫn giữ nguyên chưa tự ý sửa sớm ngoài phạm vi Phase 6.5 (dành cho Phase 7.3).
- [ ] **G-05**: Xác nhận `UI-BACKLOG-02` (gộp Thư viện chính All / Local / Remote Sources) chưa tự ý sửa sớm (dành cho Phase 7.2).
- [ ] **G-06**: Xác nhận `UI-BACKLOG-03` (đồng hồ đo tài nguyên Host trực quan trên giao diện) chỉ mới có API nền, chưa vẽ đồng hồ UI (dành cho Phase 7.4).
- [ ] **G-07**: Xác nhận `UI-BACKLOG-04` (thiết kế lại trang Server tối giản kèm mục Nâng cao) chưa tự ý làm lại toàn trang (dành cho Phase 7.4).
- [ ] **G-08**: Xác nhận `UI-BACKLOG-05` (điều tra chuyên sâu đồng bộ lời bài hát *Love Option* vs *DNA*) giữ nguyên trong sổ theo dõi Phase 7.3 để rà soát có kiểm soát.
