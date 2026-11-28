# DoReMi `v1.0.0-rc.4` — Hướng dẫn Nghiệm thu UAT Thực tế Windows & LAN Đa Máy (Phase 6.1.2)

**Phiên bản kiểm thử**: `1.0.0-rc.4` (`release/v1.0.0-rc.4/`)  
**Ứng dụng ID**: `com.losslessplayer.desktop` · **Thư mục dữ liệu**: `%APPDATA%\Lossless Player` (`SQLite WAL v9`)  
**Trạng thái hiện tại**: `AUTOMATED & PACKAGED CHROMIUM E2E VERIFIED — REAL 2-PC LAN UAT PENDING USER`

---

## 1. Hướng dẫn chuẩn bị & cài đặt trên cả Máy Host và Laptop Client

> [!IMPORTANT]
> Cả **máy Host PC** và **Windows Laptop Client** cần cập nhật lên cùng phiên bản **`1.0.0-rc.4`** để nhận toàn bộ bản vá Concurrency Lane tách biệt (Host + Client), Range ALAC WASM Decoder, Disarm Idle Timeout và Chẩn đoán Stream Traces.

1. **Sao lưu dữ liệu an toàn trước khi cài (tùy chọn khuyến nghị)**:
   - Không cần xóa thư mục cũ; dữ liệu thư viện, playlist và danh sách Host đã ghép nối trong `%APPDATA%\Lossless Player` được giữ nguyên 100% (`SQLite v9` không đổi schema).
   - Nếu muốn chạy thử cô lập hoàn toàn trước khi đụng thư viện thật, khởi chạy `qa\DoReMi-QA-Launch.cmd` (chọn `[1]` để dùng `%TEMP%\DoReMi-QA-UserData`).
2. **Xác minh mã băm & Cài đặt lên Máy Host (Windows x64)**:
   - Kiểm tra SHA-256 trong `release/v1.0.0-rc.4/SHA256SUMS.txt` bằng PowerShell (`Get-FileHash`).
   - Chạy `release\v1.0.0-rc.4\DoReMi-1.0.0-rc.4-x64-setup.exe` (hoặc giải nén `DoReMi-1.0.0-rc.4-x64-portable.zip` / `DoReMi-1.0.0-rc.4-x64-portable.exe`).
3. **Copy & Cài đặt lên Windows Laptop Client**:
   - Copy `DoReMi-1.0.0-rc.4-x64-setup.exe` hoặc `DoReMi-1.0.0-rc.4-x64-portable.exe` sang laptop qua USB hoặc mạng LAN.
   - Kiểm tra Windows Firewall trên máy Host ở mạng Wi-Fi/LAN **Private Profile** cho phép `DoReMi.exe` / cổng `48620`.
4. **Kiểm tra nhanh phiên bản trên cả 2 máy**:
   - Mở **Cài đặt → Giới thiệu** xác nhận hiển thị **`1.0.0-rc.4`**.

---

## 2. Danh sách Kiểm thử Nghiệm thu 70 Hạng mục (Nhóm A – F)

### Nhóm A — Cài đặt, Nâng cấp & Local Player Regression (A1 – A12)
- [ ] **A01**: Cài/mở `1.0.0-rc.4` trên dữ liệu `1.0.0-rc.3` giữ nguyên toàn bộ thư viện, playlist, thống kê và thiết bị đã ghép nối.
- [ ] **A02**: Trong **Cài đặt → Giới thiệu** hiển thị đúng `1.0.0-rc.4` và thông số SQLite/Electron.
- [ ] **A03**: Home Editorial Gallery 7 thẻ + Giant Typography mượt mà, không giật hình.
- [ ] **A04**: Tiêu đề tiếng Việt dài (`LẦN CUỐI (đi bên em xót xa người ơi)`) hiển thị đủ dấu thanh trên Now Playing & Mini Player (`BUG-01`).
- [ ] **A05**: Mở Album có >= 10 bài hoặc multi-disc kiểm tra thứ tự `1, 2, ..., 10` chuẩn xác (`BUG-02`).
- [ ] **A06**: Bật **Phát ngẫu nhiên** trên Library Toolbar dùng Smart Shuffle, không dồn cùng album liên tiếp (`IMP-03` & `IMP-06`).
- [ ] **A07**: Tự động phát tiếp hết Album/Playlist chuyển mượt sang bài tiếp theo từ thư viện cục bộ (`IMP-04`).
- [ ] **A08**: Vào Now Playing / Focus Vinyl làm Sidebar ẩn tức thì `0ms`, không chớp (`IMP-05`).
- [ ] **A09**: Phát cục bộ `Có Thể (102112 Version)` (ALAC 24-bit/48kHz) nghe rõ, tua nhanh mượt, EQ hoạt động.
- [ ] **A10**: Phát cục bộ FLAC, FLAC+ID3v2, AAC/M4A, WAV không lỗi.
- [ ] **A11**: Đổi Equalizer 10-band / Preamp / ReplayGain khi đang phát không rách tiếng.
- [ ] **A12**: Đóng/mở lại DoReMi giữ nguyên trạng thái Host mặc định OFF nếu trước đó không bật Auto-Start.

### Nhóm B — Ghép nối & An toàn DoReMi Connect LAN (B1 – B10)
- [ ] **B01**: Bật Host Server trên PC: trạng thái chuyển `STANDBY`, hiện đúng địa chỉ LAN Private IPv4 & cổng `48620`.
- [ ] **B02**: Tạo mã mời dùng 1 lần trên Host; Laptop dùng mDNS Discovery hoặc nhập IP thủ công thấy được Host.
- [ ] **B03**: Laptop đối chiếu đúng `Short Fingerprint` TLS SPKI và ghép nối thành công (hoặc kết nối lại Host đã nhớ từ `rc.3`).
- [ ] **B04**: Laptop duyệt Thư viện từ xa > 100 bài, có tải nhiều ảnh bìa cuộn danh sách (scroll) mượt, không treo UI.
- [ ] **B05**: Bật `Album` trên Remote Library xác nhận thứ tự bài đúng chuẩn `disc -> track`.
- [ ] **B06**: Trong **Audio Lab** đang bật hoặc chưa ghé trang Server trước đó: mở app trực tiếp và phát bài từ xa hoạt động ngay.
- [ ] **B07**: Không phát sinh file tạm audio rác trong `%TEMP%` hoặc `%APPDATA%\Lossless Player` trên Host hay Client.
- [ ] **B08**: File nhạc gốc trên Host không bị đổi `mtime` hay kích thước khi Client phát hàng loạt bài.
- [ ] **B09**: Kiểm tra CSP & Console DevTools (nếu kiểm định) không rò rỉ kết nối ra Internet.
- [ ] **B10**: Host hiển thị chính xác `ACTIVE` khi Client đang tải luồng và tự về `STANDBY` khi Client xong/ngắt.

### Nhóm C — Khôi phục Phát nhạc Từ xa Đa định dạng trên Laptop Thật (C1 – C18)
- [ ] **C01**: **Remote FLAC (16-bit/44.1kHz)** — Phát ngay lần bấm đầu tiên, có tiếng rõ ràng qua loa laptop, không `ERR_CONTAINER_CORRUPT_HEADER`.
- [ ] **C02**: **Remote FLAC Hi-Res (24-bit/96kHz)** — Phát mượt qua Wi-Fi LAN, không giật buffer khi vừa cuộn ảnh bìa danh sách.
- [ ] **C03**: **Remote FLAC có ID3v2 hoặc ảnh nhúng cũ** — Phát mượt từ xa mà file gốc trên Host vẫn giữ nguyên 100%.
- [ ] **C04**: **Remote ALAC `Có Thể (102112 Version)` (24-bit/48kHz)** — Phát nghe rõ ngay trên Laptop Client, lặp lại 5 lần liên tiếp 5/5 PASS (không còn `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`).
- [ ] **C05**: **Remote ALAC 16-bit/44.1kHz** — Phát thành công, thông số hiển thị đúng, EQ/DSP tác dụng lên âm thanh.
- [ ] **C06**: **Remote ALAC có `moov` ở cuối file** — Mở bài không phải chờ tải hết cả tệp, bắt đầu phát nhanh (`< 1s` trên LAN tốt).
- [ ] **C07**: **Remote AAC / M4A** — Phát mượt trên Laptop Client không báo lỗi demuxer.
- [ ] **C08**: **Remote WAV PCM (16-bit & 24-bit)** — Phát mượt, âm thanh nguyên bản sạch sẽ.
- [ ] **C09**: **Remote MP3 / OGG / Opus** — Phát bình thường nếu có trong thư viện chia sẻ.
- [ ] **C10**: Bật danh sách 100+ bài từ xa có ảnh bìa, **cuộn nhanh lên xuống** trong lúc bấm phát bài FLAC khác ngay lập tức -> Không nghẽn `429`.
- [ ] **C11**: Mở bài từ xa từ trang khác (sau khi đã kết nối) khi thoát khỏi màn hình `ServerPage` (MiniPlayer / Now Playing) vẫn phát và điều khiển ổn định.
- [ ] **C12**: Chuyển đổi qua lại giữa **Chuẩn**, **Lyrics**, và **Focus Vinyl** khi đang nghe nhạc Remote không khựng âm thanh.
- [ ] **C13**: Bật Equalizer / Preamp trên Laptop khi nghe Remote FLAC & Remote ALAC -> Âm sắc thay đổi mượt mà.
- [ ] **C14**: Nghe trọn vẹn 1 bài FLAC/ALAC từ xa từ đầu đến cuối tự chuyển sang bài Remote kế tiếp trong hàng đợi.
- [ ] **C15**: Kiểm tra danh sách bài Remote hết hàng đợi tuyệt đối **không tự nhảy sang nhạc cục bộ** của Laptop.
- [ ] **C16**: Bấm Pause bài đang phát từ xa (WAV/FLAC/ALAC), chờ **15–20 giây** rồi bấm Play lại -> Phát tiếp mượt, không đứt socket timeout `10s`.
- [ ] **C17**: Bấm Pause bài ALAC **30 giây**, tua sang đoạn khác rồi Play -> Hoạt động ổn định.
- [ ] **C18**: Trên Laptop dùng loa Bluetooth/Jack 3.5mm chuyển thiết bị ra Windows khi đang nghe Remote không crash app.

### Nhóm D — Seeking, Rapid Track Switching & Đa thiết bị (D1 – D10)
- [ ] **D01**: **Tua tiến** Remote FLAC đến 50% và 85% thời lượng -> Âm thanh nhảy tức thì, không đứng im hay lỗi.
- [ ] **D02**: **Tua lùi** Remote FLAC từ 80% về 10% -> Âm thanh phát ngay, đồng hồ thời gian chuẩn.
- [ ] **D03**: **Tua liên tiếp 6 lần** trên thanh tiến trình (scrubbing) ở Remote FLAC -> Không sập luồng, không `ERR_CONTAINER_CORRUPT_HEADER`.
- [ ] **D04**: **Tua tiến & Tua lùi** trên Remote ALAC `Có Thể (102112 Version)` (25%, 75%, 10%) -> Seek nhanh, tiếng khớp chuẩn không rè.
- [ ] **D05**: **Tua tiến & Tua lùi** trên Remote WAV và Remote AAC/M4A -> Phản hồi mượt.
- [ ] **D06**: **Chuyển bài nhanh (Next/Prev 10 lần liên tiếp)** giữa các định dạng hỗn hợp (`FLAC -> ALAC -> WAV -> AAC -> FLAC`) -> Luôn phát đúng bài cuối cùng, không chồng tiếng bài cũ.
- [ ] **D07**: Kiểm tra RAM tiến trình Host và Client sau 20 lần chuyển bài nhanh không tăng vọt bất thường.
- [ ] **D08**: Kiểm tra **Tab Tài nguyên** trên Host thấy số luồng `Active Playback Sessions` giảm về `0` khi Client bấm Stop/đóng app (không rò rỉ handle).
- [ ] **D09**: Thử phát cùng lúc từ 2–3 thiết bị (nếu có) không vượt quá trần `maxActiveClients`.
- [ ] **D10**: Thử mở luồng từ thiết bị thứ `4` khi 3 thiết bị khác đang phát tích cực -> Client thứ 4 nhận thông báo rõ `ERR_REMOTE_RESOURCE_LIMIT` (không báo nhầm hỏng header file).

### Nhóm E — Chẩn đoán, Thu hồi quyền & Xử lý lỗi Trung thực (E1 – E10)
- [ ] **E01**: Tạm thời xóa/đổi tên 1 file gốc trên Host (chưa rescan) rồi bấm phát trên Laptop -> Hiển thị rõ `ERR_REMOTE_TRACK_NOT_FOUND` (không báo nhầm `ERR_CONTAINER_CORRUPT_HEADER`).
- [ ] **E02**: Thu hồi quyền thiết bị Client ngay khi Laptop đang nghe nhạc -> Luồng bị ngắt tức thì, Laptop hiện thông báo thu hồi `ERR_REMOTE_ACCESS_REVOKED`.
- [ ] **E03**: Thử kết nối lại bằng thiết bị vừa bị thu hồi -> Bị từ chối `403`, buộc ghép nối lại hợp lệ.
- [ ] **E04**: Tắt Host đột ngột hoặc ngắt Wi-Fi trên Laptop -> Laptop xử lý mất kết nối an toàn (`ERR_REMOTE_STREAM_INTERRUPTED` / `CONNECTION_FAILED`), không treo đơ app.
- [ ] **E05**: Bật lại Host & bấm Kết nối lại trên Laptop -> Khôi phục thư viện và phát nhạc bình thường.
- [ ] **E06**: Bỏ chọn chia sẻ thư mục trên Host khi đang phát bài trong thư mục đó -> Luồng ngắt ngay và chặn phát tiếp.
- [ ] **E07**: Mở **DoReMi Connect → Tab Chẩn đoán** kiểm tra phần **Host Stream Traces** và **Client Stream Traces** hiển thị đủ mã HTTP (`200/206/404/403`) & độ trễ (`ms`), không chứa đường dẫn ổ đĩa Host hay Bearer token.
- [ ] **E08**: Bấm nút **"Sao chép báo cáo Connect"** dán ra Notepad kiểm tra JSON sạch sẽ, dễ gửi gỡ lỗi.
- [ ] **E09**: Phát lại 1 bài lỗi để xác nhận mục "Lỗi luồng gần nhất" cập nhật đúng; seek/pause bình thường không tạo báo lỗi giả.
- [ ] **E10**: Sao chép **"Xem chi tiết"** trên khung báo lỗi Player (nếu thử lỗi cố ý) kiểm tra `Code`, `Stage`, `remote.code`, `remote.http` trùng khớp với Stream Trace.

### Nhóm F — Phần cứng tham chiếu & Soak Dài hạn (F1 – F10)
- [ ] **F01**: Máy Host giữ `STANDBY` 1 giờ không phát: CPU trung bình ~`0–1%`, RAM ổn định.
- [ ] **F02**: Phát liên tục playlist hỗn hợp FLAC + ALAC + WAV + AAC qua Wi-Fi trong **>= 2 giờ** không giật/đơ, không rò rỉ bộ nhớ.
- [ ] **F03**: Nếu có máy tham chiếu **Core i5-5200U / RAM 8GB / HDD/SSD**: chạy Client & Host kiểm tra mức RAM tổng và độ mượt giao diện.
- [ ] **F04**: Kiểm tra SSD/HDD Host trong lúc Client phát ALAC 24-bit qua LAN không có hoạt động ghi file tạm liên tục.
- [ ] **F05**: Kiểm tra Focus Vinyl ở chế độ Power Saver trên laptop pin giữ FPS ổn định, không quá nhiệt.
- [ ] **F06**: Đưa laptop vào Sleep rồi đánh thức (Wake) trong lúc dừng phát -> Ngắt/kết nối lại Host mượt không treo app.
- [ ] **F07**: Tắt hoàn toàn Host Server -> Mọi socket đóng, về trạng thái `STOPPED`, Local Music Player vẫn chạy độc lập 100%.
- [ ] **F08**: Khởi động lại cả 2 máy khi auto-start OFF -> Cả 2 mở lên trong chế độ Offline Player mặc định sạch sẽ.
- [ ] **F09**: Gỡ cài đặt hoặc nâng cấp đè bộ cài mới kiểm tra dữ liệu cá nhân trong `%APPDATA%\Lossless Player` còn nguyên vẹn.
- [ ] **F10**: Ký duyệt nghiệm thu thực tế cho `1.0.0-rc.4` (hoặc ghi chú mã Stream Trace nếu phát sinh điểm cần tinh chỉnh).
