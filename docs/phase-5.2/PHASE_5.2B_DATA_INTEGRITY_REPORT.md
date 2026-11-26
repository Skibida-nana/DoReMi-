# DOREMI — PHASE 5.2B: DATA INTEGRITY & RECOVERY REPORT

## 1. Hạng mục rà soát & gia cố

1. **Kiểm tra toàn vẹn SQLite tự động ([`src/main/database/integrity.ts`](file:///g:/Source%20code%20DoReMi/src/main/database/integrity.ts), [`src/main/database/connection.ts`](file:///g:/Source%20code%20DoReMi/src/main/database/connection.ts))**:
   - Mở `openLibraryDatabase()` luôn thiết lập `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, `busy_timeout = 5000` và tạo bản sao lưu trước migration (`createSafeMigrationBackup`).
   - Đã bổ sung `verifyDatabaseIntegrity(db)` chạy `PRAGMA integrity_check` và `PRAGMA foreign_key_check` ngay khi mở DB, gắn kết quả vào `DatabaseConnection.integrity` và ghi cảnh báo vào `DiagnosticsService` nếu phát hiện bất thường — tuyệt đối không ghi đè hay xóa DB của người dùng.
   - Đóng DB trong `close()` thực hiện `wal_checkpoint(PASSIVE)` trước khi `db.close()` để đồng bộ WAL sạch xuống file `.db`.

2. **Sao lưu & Khôi phục an toàn WAL-Safe (`createDatabaseSnapshotBackup`, `restoreDatabaseBackupSafely`)**:
   - `createDatabaseSnapshotBackup(db, destinationPath)` dùng SQLite Online Backup API (`await db.backup(tempPath)`), kiểm tra `verifyDatabaseIntegrity` ở chế độ `readonly` trên file tạm trước khi rename nguyên tử tới đích (hỗ trợ đầy đủ đường dẫn Unicode tiếng Việt).
   - `restoreDatabaseBackupSafely(backupPath, targetDbPath)` xác thực file backup không rỗng và đạt `integrity_check` + `foreign_key_check` **trước** khi chạm tới file DB đích; tạo bản rollback `.pre-restore-*` và dọn sidecar `-wal` / `-shm` cũ trước khi hoán đổi nguyên tử.

3. **Bảo vệ dữ liệu người dùng & Cache Consistency**:
   - Đường dẫn dữ liệu packaged giữ nguyên `%APPDATA%\Lossless Player` ([`src/main/utils/user-data-path.ts`](file:///g:/Source%20code%20DoReMi/src/main/utils/user-data-path.ts)).
   - Rà soát `ArtworkService.pruneOrphanedMediaFiles()`, `LyricsService`, `MetadataOverrideRepository`, `PlaylistRepository`, `ProfileService`, `StatisticsService`: ID bài hát, playlist, favorites, lyrics/artwork custom, metadata overrides, thống kê nghe đều tách biệt với trạng thái file thiếu (`missing`) và tự làm mới cache trong RAM khi ghi/xóa.
   - Lưu ý minh bạch: các channel `BACKUP_CREATE`, `BACKUP_VALIDATE`, `BACKUP_RESTORE` đã khai báo trong `channels.ts` từ Stage 6 nhưng chưa gắn UI/IPC công khai trong bản Player v1.0.0; tiện ích lõi WAL-safe tại `integrity.ts` đã sẵn sàng và được kiểm thử đầy đủ.

## 2. Kết quả kiểm thử (Quality Gate A)

- Kiểm chứng qua [`tests/phase52-stability-integrity.test.ts`](file:///g:/Source%20code%20DoReMi/tests/phase52-stability-integrity.test.ts):
  - Integrity & FK check trên WAL SQLite với đường dẫn Unicode.
  - Online `db.backup()` tạo snapshot và `restoreDatabaseBackupSafely` từ chối file backup hỏng (`corrupt.db`) mà không làm mất DB sống.
  - Phát hiện bản ghi vi phạm Foreign Key khi kiểm tra `foreign_key_check`.
  - Mô phỏng rollback giữa chừng transaction trên WAL và reopen toàn vẹn (`integrity.ok === true`).
