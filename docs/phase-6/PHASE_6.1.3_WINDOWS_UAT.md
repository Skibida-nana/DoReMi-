# DoReMi `v1.0.0-rc.5` — Checklist Nghiệm thu Nhanh Phase 6.1.3 (Windows LAN UAT)

**Mục tiêu**: Xác nhận sửa lỗi kẹt tìm kiếm thư viện từ xa (`BUG-P613-01`) đồng thời kiểm tra ổn định phát nhạc FLAC & ALAC trên cặp Host PC + Windows Laptop Client (`1.0.0-rc.5`), giữ nguyên dữ liệu `%APPDATA%\Lossless Player` và thiết bị đã ghép nối.

1. **Chuẩn bị**:
   - Cài hoặc giải nén bản [`release/v1.0.0-rc.5/`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.5/) trên cả **Host PC** và **Laptop Client** (hoặc cập nhật Laptop Client khi Host chạy `rc.4`/`rc.5`).
   - Mở **Cài đặt → Giới thiệu** xác nhận phiên bản `1.0.0-rc.5`.
   - Kiểm tra thiết bị Laptop trước đó vẫn được công nhận ở trạng thái đã cấp quyền (`authorized`), không phải ghép nối lại.
2. **Kịch bản Kiểm tra (`BUG-P613-01` & Phát nhạc)**:
   - [ ] **UAT-01**: Kết nối Laptop tới Host PC -> Mở Thư viện nhạc từ xa -> xác nhận toàn bộ danh sách gốc ban đầu hiển thị đầy đủ.
   - [ ] **UAT-02**: Gõ từ khóa tìm kiếm (vd. `Có Thể`) và nhấn **Tìm** -> chỉ hiện kết quả khớp và thanh tìm kiếm hiển thị rõ `Có Thể` kèm nút `X` và dải `"Đang hiển thị kết quả đã lọc"`.
   - [ ] **UAT-03**: Bấm **Phát** một bài từ kết quả tìm kiếm -> bài hát bắt đầu phát bình thường.
   - [ ] **UAT-04**: Mở màn hình **Đang phát (Now Playing)** -> quay lại Thư viện từ xa: xác nhận ô tìm kiếm và danh sách đồng nhất (không bị ô trống mà danh sách kẹt).
   - [ ] **UAT-05**: Bấm nút **`X`**, hoặc xóa trống ô tìm kiếm, hoặc bấm **`Xóa bộ lọc` / `Về thư viện đầy đủ`** -> danh sách thư viện đầy đủ ban đầu được khôi phục ngay lập tức (không cần gõ từ khóa khác).
   - [ ] **UAT-06**: Tìm tiếp một từ khóa khác (vd. bài FLAC hoặc bài ALAC khác) -> kết quả cập nhật đúng, phân trang reset sạch sẽ.
   - [ ] **UAT-07**: Xác nhận trong suốt lúc xóa tìm kiếm / quay về thư viện / tìm từ khóa mới, **bài hát đang phát tiếp tục phát liên tục không bị ngắt quãng**.
   - [ ] **UAT-08**: Phát **FLAC** qua LAN -> âm thanh mượt, seek OK.
   - [ ] **UAT-09**: Phát lại bài **ALAC `Có Thể (102112 Version)`** -> phát ổn định, tua seek mượt.
   - [ ] **UAT-10**: Phát thử **thêm một bài ALAC M4A khác** trong thư viện -> xác nhận phát và tua seek hoạt động.
   - [ ] **UAT-11**: Xác nhận thiết bị đã ghép nối trước đó vẫn giữ nguyên quyền truy cập và dữ liệu cục bộ/cài đặt không bị mất.
