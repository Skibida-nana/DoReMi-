# DoReMi Windows — Release Notes (`1.0.0-rc.2`)

**Trạng thái**: `RELEASE CANDIDATE - PENDING UAT`  
**Loại phát hành**: Desktop Music Player Standalone (100% Offline, Windows x64) · **Developed by `kamisamao`**

---

## Điểm mới trong Release Candidate `1.0.0-rc.2` (Phase 5.2.1)

1. **Tinh chỉnh trải nghiệm Thư viện (`5.2.1A`)**:
   - Nút nổi **"Về đầu trang"** (`ArrowUp`, `40×40px`, tooltip `"Về đầu trang"`) ở góc dưới phải vùng nội dung Library (trên `MiniPlayer`, dưới Modals/`QueueDrawer`), chỉ xuất hiện khi cuộn sâu (`420–600px`), hỗ trợ `prefers-reduced-motion` và giữ nguyên tab, bộ lọc, tìm kiếm, virtualization & phát nhạc.
   - Nút **"+ Tạo playlist"** ngay trên thanh công cụ Thư viện across mọi tab, kiểm tra chống trùng tên NFC/NFD tiếng Việt, chặn tên rỗng/quá dài (`> 80` ký tự), chống double-click và có checkbox xác nhận rõ ràng khi người dùng đang chọn nhiều bài hát.
2. **Đồng nhất Sidebar Focus Player (`5.2.1B`)**:
   - Khi chuyển đổi qua lại giữa **Focus Vinyl** và **Chế độ Chuẩn / Lyrics** trong Màn hình Đang phát, thanh Sidebar giữ nguyên trạng thái ẩn đồng nhất (không tự bật lại 3 giây gây lệch nút Quay lại), đồng thời vẫn mở nhanh bằng `Alt+M` hoặc rê chuột mép trái `12px` và khôi phục Sidebar cố định khi rời trang phát nhạc.
3. **Trang Giới thiệu & Bản sắc nhà phát triển (`5.2.1C`)**:
   - Mục **Cài đặt → Giới thiệu** (lazy-loaded `27.14 kB`) hiển thị nhận diện `DoReMi`, `Designed & Developed by kamisamao`, câu chuyện & triết lý thiết kế (`"Built with passion. Designed for music lovers."`), thông số phiên bản động (`app.getVersion()`), SQLite version thực tế, và mô tả trung thực kiến trúc **Audio Engine (`HTMLAudioElement` + Web Audio `AudioDspGraph`)**, **Decoder (`Chromium Media Pipeline` + `@mgz-dev/alac 0.1.1` WASM)** cùng **Codec Engine tách biệt (`Isolated`, không đóng gói FFmpeg ngoài)** với nút kiểm tra tùy chọn on-demand.
4. **Hướng dẫn sử dụng tích hợp 100% Offline (`5.2.1D`)**:
   - Mục **Cài đặt → Hướng dẫn sử dụng** (lazy-loaded `37.46 kB`) gồm **15 chương** chính xác theo tính năng thực tế, Mục lục nhanh, đóng/mở từng chương, tìm kiếm tiếng Việt hỗ trợ cả có dấu lẫn không dấu, đồng bộ 1 nguồn duy nhất với [`docs/USER_GUIDE.md`](file:///G:/Source%20code%20DoReMi/docs/USER_GUIDE.md).
5. **Tối ưu & Kiểm chứng Đóng gói (`5.2.1E`)**:
   - Main renderer bundle giữ gọn ở **`675.38 kB`** (giảm nhẹ so với `680.95 kB` ở RC1 nhờ lazy chunk cho About, Guide và CodecManager).
   - Bộ kiểm thử tự động Electron: **`191 tests: 189 PASS, 0 FAIL, 2 platform-env EPERM SKIP`** (`6,252.32 ms`), Smoke Test PASS trên cả bản Dev và Packaged `release/v1.0.0-rc.2/win-unpacked/DoReMi.exe`, **`0` prod dependency CVEs** (`23` prod deps).

---

## Điểm cốt lõi được bảo toàn từ `1.0.0-rc.1`

- **Phát nhạc Lossless / Hi-Res chuẩn xác**: FLAC (`flac-stream-sanitizer`), M4A/ALAC (`@mgz-dev/alac` WASM streamed PCM WAV có HTTP 206 seeking), WAV, MP3, AAC, OGG, Opus; `AudioDspGraph` 10-band Graphic / 8-band Parametric EQ, ReplayGain, Auto Headroom, Audible Scrubbing, True Shuffle `#59`, Queue Restoration.
- **Ổn định & Bảo mật**: Global resilience handlers (`<= 512 KB` rotating crash logs), `<AppErrorBoundary>`, `PRAGMA integrity_check` + `foreign_key_check`, WAL-safe `db.backup()`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP `0` network/telemetry, lưu trữ cố định tại `%APPDATA%\Lossless Player`.
