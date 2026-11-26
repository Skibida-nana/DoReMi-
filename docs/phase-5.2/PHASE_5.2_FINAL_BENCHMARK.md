# DOREMI — PHASE 5.2: FINAL BENCHMARK SUMMARY

**Thời điểm đo cuối**: `2026-11-25T20:31:23.006Z` (`2026-11-26T03:31+07:00`)  
**Cấu hình máy đo**: Windows 11 Pro `10.0.26200` (`win32 x64`), Intel Core i5-14600K (`20` threads), `31.65 GB RAM`, Electron `45.4.1`.

| Hạng mục đo | Baseline trước tối ưu Phase 5.1 | Kết quả Final Phase 5.2 | Mức cải thiện / Ghi chú |
|---|---:|---:|---|
| Cold DB Open + 8 Migrations + Integrity/FK Check | `14.54 ms` | **`13.09 ms`** | Thêm `PRAGMA integrity_check` + `foreign_key_check` vẫn nhanh hơn |
| Warm DB Re-open + Integrity Check | `1.59 ms` | **`1.96 ms`** | Đã bao gồm xác thực toàn vẹn mỗi lần mở |
| `ProfileService` (200 calls) | `8.33 ms` | **`1.48 ms`** | **`5.6×`** nhờ snapshot caching & lazy validation |
| `ArtworkService.enrichTracks(50,000)` | `3,358.16 ms` | **`64.61 ms`** | **`~52×`** nhờ manifest file cache thay `fsSync.existsSync()` `3N` lần |
| `LibraryService.getSnapshot(50,000)` | `3,578.66 ms` | **`333.25 ms`** | **`~10.7×`** |
| `rescanLibrary(1,000)` Steady-State (warm OS) | `2,514.14 ms` *(gồm backfill)* | **`35.50 ms`** (`488.40 ms` cold) | Fast-path skip `0` writes khi file không đổi |
| `normalizeVietnameseText(50,000)` Cache Hit | N/A | **`6.38 ms`** (`163.45 ms` cold) | **`25.6×`** hit speedup; `~11.88 MB` heap cho 50k entries |
| Online SQLite `db.backup()` + Verify (`10,000` tracks) | Chưa có | **`47.31 ms`** | Snapshot nhất quán khi WAL đang hoạt động |
| Soak Stress `30 × (5k Queue Shuffle/Next + Virtualize)` | Chưa đo | **`145.80 ms`** | Post-GC Heap `+5.57 MB` ổn định |
| Renderer Production JS Main Chunk | `1,743.17 kB` | **`680.95 kB`** | Route code-splitting bằng `React.lazy` (~60.9% giảm chunk chính) |

> **Giới hạn đo đạc môi trường**: Các số liệu Renderer DOM live (First Paint ms thực tế trên GPU, Idle/Playing Task Manager RAM, GPU % Blur 60fps trên máy thật) cần xác minh trực tiếp qua phiên Windows UAT ngoài sandbox sử dụng bản đóng gói `v1.0.0-rc.1` và bộ `qa/*.cmd`.
