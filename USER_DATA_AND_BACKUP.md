# Dữ liệu Người dùng, Bảo toàn Thư viện & Sao lưu — DoReMi

## 1. Vị trí lưu dữ liệu (`userData`)
Để bảo toàn 100% thư viện, playlist, bài yêu thích, ảnh bìa custom, lời bài hát, cài đặt giao diện và lịch sử nghe từ các giai đoạn trước:
- **Bản đóng gói Windows (`Setup` / `Portable` / `win-unpacked`)**: Luôn lưu cố định tại:
  `%APPDATA%\Lossless Player`
  (được khóa bởi [`src/main/utils/user-data-path.ts`](file:///G:/Source%20code%20DoReMi/src/main/utils/user-data-path.ts) để việc nâng cấp giữa các phiên bản DoReMi **không tạo** thư mục trống mới hay làm mất dữ liệu cũ).
- **Chế độ chạy QA / Smoke Test**: Dùng `--user-data-dir=%TEMP%\...` hoặc `DOREMI_SMOKE_USER_DATA`, cô lập hoàn toàn khỏi thư viện thật.

## 2. Cấu trúc file dữ liệu bên trong `%APPDATA%\Lossless Player`
- `library.db` (+ `-wal`, `-shm`): Cơ sở dữ liệu SQLite chính (schema v8, bật `WAL` và `foreign_keys = ON`), lưu thông tin track (chế độ đọc-only với file nhạc gốc), playlist, favorites, metadata overrides, custom lyrics, profile, thống kê nghe, watched folders, exclusions.
- `library.db.backup-before-migration-<timestamp>`: Bản sao lưu tự động tạo trước khi chạy schema migration mới.
- `artwork-cache/` & `artwork-thumbs/`: Cache ảnh bìa trích xuất từ tag / thư mục (hỗ trợ dọn file mồ côi qua `pruneOrphanedMediaFiles()`).
- `logs/playback-diagnostics.log` (+ `.1.log`) & `logs/main-crash.log` (+ `.1.log`): Log chẩn đoán và crash cục bộ xoay vòng giới hạn <= 512 KB/file.

## 3. Hướng dẫn Sao lưu & Khôi phục thủ công an toàn
1. **Đóng hoàn toàn DoReMi** trước khi copy trực tiếp bằng Windows Explorer để SQLite hoàn tất checkpoint `-wal` về `library.db`.
2. Copy toàn bộ thư mục `%APPDATA%\Lossless Player` (hoặc tối thiểu `library.db`, `artwork-cache/`, `profile/`) sang ổ lưu trữ dự phòng.
3. Để khôi phục: đóng DoReMi, xóa các file sidecar `-wal`/`-shm` cũ (nếu còn), dán lại bản sao lưu vào `%APPDATA%\Lossless Player` rồi mở ứng dụng. Khi khởi động, DoReMi tự chạy `PRAGMA integrity_check` và `PRAGMA foreign_key_check` để kiểm tra tính toàn vẹn.

> **Lưu ý**: Tiện ích WAL-safe SQLite Online Backup (`createDatabaseSnapshotBackup` & `restoreDatabaseBackupSafely`) đã được kiểm thử đầy đủ trong [`src/main/database/integrity.ts`](file:///G:/Source%20code%20DoReMi/src/main/database/integrity.ts). Nút Export/Restore Backup trên UI Settings vẫn giữ gọn ở chu kỳ RC để ưu tiên bảo toàn trải nghiệm cốt lõi.
