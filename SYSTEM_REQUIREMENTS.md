# DoReMi Desktop (Windows) — System Requirements

**Phiên bản áp dụng**: `1.0.0-rc.2` (Standalone Offline Windows Music Player — `kamisamao`)

## 1. Cấu hình tối thiểu (Tương thích laptop phổ thông)
- **Hệ điều hành**: Windows 10 (64-bit, build 19041+) hoặc Windows 11 (64-bit).
- **CPU**: Intel Core thế hệ 8+ (dòng U tiết kiệm điện như i5-8250U / i5-10210U) hoặc AMD Ryzen 3 3200U tương đương.
- **RAM**: **8 GB** (tiến trình chính + giao diện hoạt động mượt dưới ~150–350 MB tùy quy mô thư viện đến 50,000 bài nhờ Virtualization & `power-saver` mode).
- **Đồ họa**: iGPU tích hợp (Intel UHD / Iris Xe / AMD Radeon Graphics). Hỗ trợ tắt blur nền qua `Cá nhân hóa → Chất lượng giao diện: Tiết kiệm tài nguyên` hoặc tắt `Hiệu ứng nền`.
- **Ổ lưu trữ**: ~300 MB trống cho ứng dụng + dung lượng tùy chọn cho thư viện nhạc và cache ảnh bìa cục bộ (`%APPDATA%\Lossless Player`).
- **Mạng**: **Không yêu cầu Internet** (100% offline-first).

## 2. Cấu hình khuyến nghị
- **Hệ điều hành**: Windows 11 64-bit.
- **CPU**: Intel Core i5/i7 thế hệ 11+ hoặc AMD Ryzen 5/7 5000+ series.
- **RAM**: 16 GB trở lên (khi phát nhạc Hi-Res 24-bit/192kHz kết hợp thư viện >20,000 bài và Audio Lab EQ).
- **Ổ đĩa**: SSD / NVMe (giúp quét incremental 1,000 bài chỉ ~35 ms ấm cache).

## 3. Thành phần giải mã & Công nghệ tích hợp
- **Phát nhạc cốt lõi**: `HTMLAudioElement` (`lossless-media://` HTTP 206 Byte-Range) + Web Audio `AudioDspGraph` (10-Band Graphic / 8-Band Parametric EQ, Preamp, Auto Headroom, ReplayGain, FFT Spectrum).
- **Audio Decoder nội bộ**: Chromium Media Pipeline (`FLAC` với `flac-stream-sanitizer`, `WAV`, `MP3`, `AAC`, `OGG`, `OPUS`) + `@mgz-dev/alac` (`v0.1.1` WebAssembly) cho `ALAC (.m4a)`. Hoạt động độc lập ngay lập tức, **không cần cài thêm Codec Pack hay FFmpeg**.
- **Codec Engine ngoài (Tách biệt / Tùy chọn)**: Không nhúng sẵn `.exe` bên ngoài trong gói phân phối mặc định; lớp Codec Engine giữ trạng thái tách biệt hoàn toàn (`Isolated`) khỏi luồng phát nhạc.
