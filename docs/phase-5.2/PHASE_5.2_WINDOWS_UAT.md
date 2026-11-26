# DOREMI — PHASE 5.2.1: WINDOWS UAT CHECKLIST (ONE-CLICK NON-TERMINAL GUIDE)

> **Lưu ý**: Bạn **không cần** tự gõ bất kỳ lệnh Terminal nào. Toàn bộ kiểm thử có thể thực hiện bằng **nhấp đúp chuột** vào file trong thư mục `qa/` hoặc file đóng gói trong `release/v1.0.0-rc.2/`.

---

## 1. Khởi chạy & Kiểm tra nhanh bằng 1 click
1. **Chạy Smoke Check tự động**: Nhấp đúp [`qa/DoReMi-QA-SmokeTest.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-SmokeTest.cmd) → đợi cửa sổ hiện `[PASS]` (dùng thư mục `%TEMP%`, không chạm thư viện nhạc thật).
2. **Mở DoReMi RC2 (`v1.0.0-rc.2`)**:
   - Dùng profile thử nghiệm cô lập: Nhấp đúp [`qa/DoReMi-QA-Launch.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-Launch.cmd) (mặc định chọn `[1]`).
   - Hoặc nhấp đúp trực tiếp bản Portable độc lập [`release/v1.0.0-rc.2/DoReMi-1.0.0-rc.2-x64-portable.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.2/DoReMi-1.0.0-rc.2-x64-portable.exe) để mở với dữ liệu cá nhân thật (`%APPDATA%\Lossless Player`).

---

## 2. Bảng nghiệm thu UAT cho Người dùng

| # | Kịch bản kiểm thử thực tế | Kỳ vọng đạt (`PASS`) | Kết quả của bạn |
|---:|---|---|---|
| 1 | Khởi động lạnh ứng dụng RC2 (`v1.0.0-rc.2`) | Mở cửa sổ nhanh, không trắng màn hình, giữ nguyên thư viện cũ, playlist, profile, theme | `[ ] PASS / [ ] FAIL` |
| 2 | Library Toolbar & Cuộn danh sách dài (`5.2.1A`) | Thấy nút `+ Tạo playlist` ở góc phải toolbar trên mọi tab (kể cả khi đang chọn nhiều bài có checkbox xác nhận); cuộn sâu thấy nút nổi `"Về đầu trang"`, bấm cuộn mượt lên đầu không mất filter | `[ ] PASS / [ ] FAIL` |
| 3 | Unified Focus Player Layout (`5.2.1B`) | Chuyển qua lại giữa Focus Vinyl và chế độ Chuẩn / Lyrics: Sidebar giữ trạng thái ẩn đồng nhất, không nhô ra 3s hay làm lệch nút Quay lại; `Alt+M` / hover mép trái vẫn hoạt động | `[ ] PASS / [ ] FAIL` |
| 4 | Trang Giới thiệu (`5.2.1C`) | Vào `Cài đặt → Giới thiệu`: hiển thị đúng `DoReMi`, `v1.0.0-rc.2` động, `Designed & Developed by kamisamao`, câu chuyện & triết lý thiết kế, Audio Engine/Decoder chính xác | `[ ] PASS / [ ] FAIL` |
| 5 | Hướng dẫn sử dụng tích hợp (`5.2.1D`) | Vào `Cài đặt → Hướng dẫn sử dụng`: đủ 15 chương, mục lục nhảy đúng chương, tìm kiếm tiếng Việt có dấu/không dấu chính xác, hiển thị đẹp ở Dark/Light theme | `[ ] PASS / [ ] FAIL` |
| 6 | Phát nhạc đa định dạng (`FLAC`, `ALAC .m4a`, `WAV`, `MP3`), Audio Lab EQ & Relink | Âm thanh sạch, seek mượt, Relink file thiếu hoạt động bình thường | `[ ] PASS / [ ] FAIL` |
| 7 | Kiểm tra Task Manager khi phát nhạc liên tục 10–15 phút | RAM ổn định, CPU thấp lúc idle/minimize, đóng app sạch không còn tiến trình treo ngầm | `[ ] PASS / [ ] FAIL` |

---

## 3. Quyết định Phát hành
- Nếu **tất cả đạt PASS**: xác nhận đồng ý nâng nhãn từ **`1.0.0-rc.2` (`RELEASE CANDIDATE - PENDING UAT`)** lên **`v1.0.0` Stable**.
- Bản RC trước (`release/v1.0.0-rc.1/`) và bản dự phòng Phase 5.1 (`release/DoReMi-0.1.0-x64-portable.exe`) vẫn được bảo toàn nguyên vẹn.
