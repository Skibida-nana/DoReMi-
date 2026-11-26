# Hướng dẫn Cài đặt & Sử dụng trên Windows — DoReMi v1.0.0-rc.2

**Trạng thái bản dựng**: `RELEASE CANDIDATE - PENDING UAT` (chưa gắn nhãn Stable v1.0.0 cuối cùng cho tới khi bạn hoàn tất UAT thực tế trên Windows).

---

## 1. Các định dạng phân phối (`release/v1.0.0-rc.2/`)

1. **DoReMi Portable EXE (`DoReMi-1.0.0-rc.2-x64-portable.exe`)** — Khuyên dùng để thử nhanh:
   - Không cần cài đặt vào Windows Registry hoặc Program Files.
   - Nhấp đúp chuột vào file `.exe` để chạy ngay (nếu Windows SmartScreen hiện thông báo "Windows protected your PC" do app chưa ký chứng thư số EV thương mại → bấm **More info → Run anyway**).
   - Toàn bộ thư viện nhạc SQLite, playlist, ảnh bìa, lời bài hát vẫn lưu an toàn trong `%APPDATA%\Lossless Player`.
2. **DoReMi Portable ZIP (`DoReMi-1.0.0-rc.2-x64-portable.zip`)**:
   - Giải nén ra bất kỳ thư mục nào (hỗ trợ đường dẫn có dấu cách và tiếng Việt) rồi chạy `DoReMi.exe`.
3. **DoReMi Setup Installer (`DoReMi-1.0.0-rc.2-x64-setup.exe`)**:
   - Trình cài đặt NSIS chuẩn (`asInvoker`, không bắt buộc quyền Administrator nếu cài vào thư mục user, cho phép chọn đường dẫn cài, tạo shortcut Desktop & Start Menu).
   - Gỡ cài đặt **không xóa** dữ liệu thư viện của bạn (`deleteAppDataOnUninstall: false`).

## 2. Xác minh tính toàn vẹn file tải (`SHA256SUMS.txt`)
Mọi file phát hành trong `release/v1.0.0-rc.2/` đều có mã băm SHA-256 trong `release/v1.0.0-rc.2/SHA256SUMS.txt`. Bạn có thể kiểm tra bằng PowerShell (`Get-FileHash <ten-file> -Algorithm SHA256`) và đối chiếu khớp từng ký tự.

## 3. Tài liệu Hướng dẫn Sử dụng tích hợp & Offline
- **Ngay trong ứng dụng**: Mở **Cài đặt → Hướng dẫn sử dụng** (15 chương đầy đủ, hỗ trợ tìm kiếm tiếng Việt có dấu / không dấu hoàn toàn offline).
- **Bản Markdown đồng bộ**: [`docs/USER_GUIDE.md`](file:///G:/Source%20code%20DoReMi/docs/USER_GUIDE.md).

## 4. Bộ One-Click QA Launchers (`qa/`)
Nếu muốn tự động kiểm thử nhanh chỉ bằng nhấp đúp chuột (không cần nhập lệnh Terminal):
- [`qa/DoReMi-QA-Launch.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-Launch.cmd): Mở RC2 mặc định ở profile cô lập `%TEMP%` (hoặc chọn mở profile thật kèm cảnh báo).
- [`qa/DoReMi-QA-SmokeTest.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-SmokeTest.cmd): Chạy toàn bộ `doctor`, `codecs:verify`, `lint`, `docs:sync -- --check`, `verify:build`, `smoke:electron`.
- [`qa/DoReMi-QA-Performance.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-Performance.cmd): Đo hiệu năng & xuất JSON trong `%TEMP%`.
- [`qa/DoReMi-QA-SoakTest.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-SoakTest.cmd): Chạy full test suite Electron + stress soak benchmark.
