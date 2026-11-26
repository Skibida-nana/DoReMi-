# PHASE 6 HANDOFF — PREPARING OPTIONAL SERVER EXTENSION

> **Nguyên tắc**: Tài liệu này chỉ định hướng ranh giới kiến trúc cho Phase 6 tùy chọn trong tương lai. Phase 5.2 / 5.2.1 **vẫn giữ 100% Desktop Standalone Offline** — không cài đặt server/socket/Firebase hay mở cổng mạng trong mã nguồn hiện tại.

---

## 1. Hợp đồng & Điểm nối Kiến trúc An toàn

1. **Ranh giới bảo mật phải giữ nguyên (`Protected Core`)**:
   - Không mở `nodeIntegration`, không tắt `contextIsolation` hay `sandbox` ở `MainWindow`.
   - Mọi kết nối Server trong Phase 6 bắt buộc ở dạng **Opt-In rõ ràng** trong Settings (mặc định TẮT, zero background network activity khi ở chế độ Offline).
   - Không gắn server dependencies vào startup critical path của Desktop Player; dùng dynamic/lazy import tương tự cách cô lập Codec Engine (`out/main/chunks/codec-manager-*.js`) và Settings About / User Guide (`React.lazy`).
2. **Bảo toàn dữ liệu Offline hiện có (`%APPDATA%\Lossless Player`)**:
   - Không thay đổi khóa chính UUID của `tracks`, `playlists`, `listening_sessions`.
   - Tính năng Server Sync (nếu bổ sung) chỉ nên bổ sung bảng phụ hoặc cột sync tách biệt qua SQLite migration tăng dần (`version 9+`), vẫn giữ `createSafeMigrationBackup()` và `verifyDatabaseIntegrity()`.
3. **Tái sử dụng Hợp đồng Shared Contracts**:
   - Sử dụng lại toàn bộ types trong `src/shared/types/*` (`TrackRecord`, `PlaylistRecord`, `AudioAnalysisReport`, `PersonalizationPreferences`, `AppRuntimeInfo`) để làm DTO giữa Host và Client mà không nhân bản định nghĩa.
   - Bộ phát âm thanh `AudioEngine` + `AudioDspGraph` chỉ nhận URL chuẩn từ protocol nội bộ (`lossless-media://` hoặc adapter stream có xác thực rõ ràng), không sửa đổi signal path cốt lõi.

## 2. Trạng thái Baseline Bàn giao

- **Phiên bản tiền đề**: `DoReMi v1.0.0-rc.2` (chờ user nghiệm thu UAT để gắn mốc `v1.0.0` Stable).
- **Automated Tests hiện có**: **`191` test cases (`189 PASS, 0 FAIL, 2 platform-env EPERM SKIP` trên Windows sandbox)** chạy sạch trên Electron `45.4.1`.
- **Kiến trúc hiện tại hoàn toàn sạch**: `0` socket đang nghe, `0` outbound requests, `0` telemetry, **`0` prod dependency CVEs** (`23` prod deps).
