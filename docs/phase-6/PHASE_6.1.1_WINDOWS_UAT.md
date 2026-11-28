# Checklist Nghiệm Thu Thủ Công (Windows UAT) — DoReMi `v1.0.0-rc.3`

**Bản dựng kiểm thử**: `release/v1.0.0-rc.3/DoReMi-1.0.0-rc.3-x64-portable.exe` (hoặc `qa/DoReMi-QA-Launch.cmd` chọn chế độ `[1]` cô lập trước, `[2]` thư viện thật sau khi xác nhận an toàn).

## Nhóm A — Sửa lỗi UI & Sắp xếp (Phase 6.1.1B)
- [ ] **UAT-611-01 (BUG-01)**: Mở bài hát có tiêu đề tiếng Việt dài nhiều dấu (như *"LẦN CUỐI (đi bên em xót xa người ơi)"*), kiểm tra tiêu đề ở: (a) Now Playing Chuẩn, (b) Focus Vinyl Mode, (c) Mini Player — không mất dấu mũ/nét sổ (`g, p, q, y, đ, ộ, ệ`), không đè lên tên nghệ sĩ hay nút điều khiển trên `1366×768` và `1920×1080`.
- [ ] **UAT-611-02 (BUG-02)**: Mở một Album có >= 10 bài hoặc nhiều đĩa (`Disc 1`, `Disc 2`), kiểm tra thứ tự hiển thị 1 → 2 → ... → 10 và bấm **Phát Album** xem Queue phát đúng thứ tự chuẩn. Kiểm tra tương tự khi duyệt Album từ máy Host qua DoReMi Connect.

## Nhóm B — Smart Shuffle, Auto Continue & Phát ngẫu nhiên (Phase 6.1.1C & D)
- [ ] **UAT-611-03 (IMP-03)**: Chọn Playlist nhiều album (~20–100 bài) và bật **Shuffle** → danh sách *Kế tiếp* phân bổ đan xen nhiều album, không bị dồn cùng album về cuối; khi tắt **Shuffle**, thứ tự *Kế tiếp* khôi phục đúng thứ tự gốc.
- [ ] **UAT-611-04 (IMP-04)**: Vào **Cài đặt → Phát nhạc**, xác nhận mục **Tự động phát tiếp khi hết danh sách** mặc định đang **Bật**; thử phát bài cuối của Playlist/Album ngắn khi Repeat = Tắt → nhạc tự nối tiếp vào Thư viện. Thử tắt cài đặt này hoặc đặt Sleep Timer → phát hết bài cuối thì dừng hẳn.
- [ ] **UAT-611-05 (IMP-06)**: Tại **Thư viện nhạc**, bấm nút **Phát ngẫu nhiên** ngay cạnh `+ Tạo playlist` → bắt đầu phát ngay một bài khả dụng cục bộ bất kỳ với chế độ Smart Shuffle.
- [ ] **UAT-611-06 (IMP-05)**: Mở màn hình **Đang phát** (bằng MiniPlayer hoặc bấm mục *Màn hình đang phát* trên Sidebar) → Sidebar ẩn ngay tức thì (`0ms`), không hiện 3 giây rồi tụt, không tự mở lại nếu chuột đang đặt ở Sidebar cũ; đưa chuột ra ngoài rồi chạm sát mép trái (`~10px`) hoặc nhấn `Alt+M` thì Sidebar mở dạng lớp phủ không giật bố cục.

## Nhóm C — Hồi quy & DoReMi Connect LAN Vật Lý (Phase 6.1 + Hardware)
- [ ] **UAT-611-07**: Kiểm tra tắt mở lại app vẫn giữ nguyên dữ liệu `%APPDATA%\Lossless Player` (playlists, favorites, profile, theme, fonts, history, `autoContinueEnabled`).
- [ ] **UAT-61-LAN**: Thử bật Host trên PC #1, ghép nối PIN + xác minh vân tay trên PC #2 cùng mạng LAN (qua mDNS & nhập IP thủ công), phát FLAC/Hi-Res mượt, kiểm tra thu hồi quyền thiết bị hoạt động tức thì, và xác nhận playback Remote không tự động nhảy sang thư viện Local khi hết bài.
- [ ] **UAT-HW**: Thử nghiệm thực tế trên máy cấu hình thấp tham chiếu (`Core i5-5200U / 8GB RAM`, nếu có) và chạy phát nhạc dài giờ để quan sát độ ổn định.
