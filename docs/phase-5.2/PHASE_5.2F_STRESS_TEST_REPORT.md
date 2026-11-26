# DOREMI — PHASE 5.2F: STRESS TEST & STABILITY SOAK REPORT

**Công cụ chạy**: [`scripts/run-stress-phase52.mjs`](file:///g:/Source%20code%20DoReMi/scripts/run-stress-phase52.mjs) → [`scripts/stress-benchmark-phase52.ts`](file:///g:/Source%20code%20DoReMi/scripts/stress-benchmark-phase52.ts)  
**Runtime**: Electron `45.4.1` (`ELECTRON_RUN_AS_NODE=1 --expose-gc`, dữ liệu hoàn toàn trong `%TEMP%`, không chạm DB người dùng).

---

## 1. Kiểm thử quy mô lớn (`100 → 50,000` tracks SQLite + Artwork + Search + Sort)

| Quy mô | `TrackRepo.findAll()` | `ArtworkService.enrichTracks()` | `LibraryService.getSnapshot()` | Tìm kiếm tiếng Việt | `naturalCompare()` Sort | Heap Delta | Process RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| **100** | `0.58 ms` | `0.65 ms` | `0.64 ms` | `0.35 ms` | `0.31 ms` | `0.70 MB` | `107.17 MB` |
| **1,000** | `3.53 ms` | `1.75 ms` | `4.74 ms` | `2.38 ms` | `2.02 ms` | `0.00 MB` | `113.53 MB` |
| **5,000** | `14.95 ms` | `7.03 ms` | `22.01 ms` | `11.24 ms` | `9.31 ms` | `17.40 MB` | `138.68 MB` |
| **10,000** | `36.00 ms` | `11.34 ms` | `49.34 ms` | `13.12 ms` | `18.54 ms` | `9.89 MB` | `202.11 MB` |
| **50,000** | `222.33 ms` | `64.61 ms` | `333.25 ms` | `140.68 ms` | `100.92 ms` | `142.16 MB` | `347.83 MB` |

- Tại **10,000 bài**: `verifyDatabaseIntegrity()` mất **`26.56 ms`**, SQLite Online Backup + verify `createDatabaseSnapshotBackup()` mất **`47.31 ms`**, cả 2 đều đạt `ok === true`.

---

## 2. Steady-State Rescan vs Legacy Backfill & Concurrency Sweep (`1,000` files `.flac` trên đĩa)

| Kịch bản quét (`1,000` files) | Thời gian | `updatedCount` | `skippedCount` | Ghi chú đối chiếu Phase 5.1 |
|---|---:|---:|---:|---|
| **Steady-State** (`file_name` đã có sẵn — lần 1) | `488.40 ms` | `0` | `1000` | File I/O cold cache; fast-path bỏ qua toàn bộ 1,000 bài |
| **Legacy Backfill** (`file_name = NULL`) | `664.85 ms` | `1000` | `0` | Tương đương nguyên nhân khiến lần đo baseline Phase 5.1 có `updatedCount = 1000` |
| **Steady-State** (sau backfill — warm OS cache) | **`35.50 ms`** | `0` | `1000` | Bỏ qua gần như tức thì |

**Khảo sát `fs.stat` song song trên 1,000 file (`VERIFY_CONCURRENCY` sweep)**:
- `concurrency = 2`: `9.95 ms`
- `concurrency = 4`: `5.67 ms`
- `concurrency = 8`: `3.67 ms`
- `concurrency = 16`: **`2.43 ms`** → Xác nhận hằng số `VERIFY_CONCURRENCY = 16` trong [`src/main/services/library-service.ts`](file:///g:/Source%20code%20DoReMi/src/main/services/library-service.ts) tối ưu nhất trên Windows NVMe/SSD.

---

## 3. Soak Stress Loop (`30` vòng lặp liên tục `5,000` bài + Virtualization Sweep)

- Mỗi vòng lặp chạy: khởi tạo context 5,000 bài → bật True Shuffle → `50` lần `advanceManualNext()` → tắt Shuffle khôi phục ngữ cảnh gốc → kiểm tra `computeQueueWindowSlice` qua 7 ngưỡng (`0, 79, 80, 81, 500, 5000, 50000`).
- **Tổng thời gian `30` vòng**: **`145.80 ms`**.
- **Bộ nhớ sau `--expose-gc` settle**:
  - Heap trước → sau: `215.05 MB → 220.62 MB` (`+5.57 MB`)
  - RSS trước → sau: `339.09 MB → 354.23 MB` (ổn định, không tăng tuyến tính hay rò rỉ đối tượng).
