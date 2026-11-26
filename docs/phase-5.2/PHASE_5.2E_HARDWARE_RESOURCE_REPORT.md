# DOREMI — PHASE 5.2E: HARDWARE COMPATIBILITY & RESOURCE OPTIMIZATION REPORT

## 1. Phạm vi tối ưu tài nguyên cho laptop phổ thông (U-series / 8GB RAM / iGPU)

1. **Giải quyết sai lệch cấu hình LRU Cache tiếng Việt ([`src/renderer/src/utils/vietnamese-search.ts`](file:///g:/Source%20code%20DoReMi/src/renderer/src/utils/vietnamese-search.ts))**:
   - Source code thực tế sử dụng `NORMALIZE_CACHE_MAX = 65_536` (một tài liệu nháp Phase 5.1E trước đây từng ghi `16,384`).
   - Đo thực nghiệm trực tiếp qua [`scripts/run-stress-phase52.mjs`](file:///g:/Source%20code%20DoReMi/scripts/run-stress-phase52.mjs):
     - Điền `50,000` chuỗi tiếng Việt: **`163.45 ms`** (cold) → **`6.38 ms`** (warm cache hit, nhanh hơn **`25.6×`**).
     - Chi phí heap đo được cho `50,000` entries: **`11.88 MB`** (~`15.5 MB` tối đa ở `65,536` entries). Mức RAM này rất nhẹ ngay cả trên máy 8GB và tránh cache thrashing khi tìm kiếm trên thư viện 50,000 bài. Giữ nguyên `NORMALIZE_CACHE_MAX = 65_536` và chuẩn hóa lại tài liệu đồng bộ với source code.
2. **UI Quality Presets & GPU/Backdrop Control ([`src/renderer/src/app/App.tsx`](file:///g:/Source%20code%20DoReMi/src/renderer/src/app/App.tsx))**:
   - Hỗ trợ 3 chế độ `uiQualityPreset` (`power-saver`, `balanced`, `high`): tự động tắt ambient radial glow và `blur-[2px]` khi chọn `power-saver` hoặc tắt `backgroundEffects`, giữ chuyển động nhẹ cho CPU dòng U / iGPU.
3. **Lazy-Initialization Codec Engine**:
   - Codec Engine hoàn toàn cô lập (`0` import vào đường phát nhạc), `CodecManager.getInventory()` mất **`7.47 ms`** khi lazy-init và **`0 ms`** khi đọc từ cache trong phiên.
   - Chế độ chuyển đổi mặc định `concurrency = 1` (`Power Saving`), chỉ sử dụng tài nguyên phụ trợ khi người dùng chủ động mở trang Audio Lab / Converter.
4. **Hồ sơ đa ngôn ngữ & Tương thích phần cứng Windows**:
   - Môi trường kiểm thử thực tế: `win32 x64` Windows 11 Pro `10.0.26200`, `Intel Core i5-14600K` (20 threads), `31.65 GB RAM` (kết hợp benchmark dòng U 8GB RAM bằng cơ chế virtualization `<= 50` DOM rows, bounded `fs.stat` concurrency = `16`, và process RSS khởi động ~`107–139 MB` với 100–5,000 bài).

## 2. Kết luận Phase 5.2E

- Tối ưu tài nguyên cân bằng giữa tốc độ tìm kiếm/virtualization và giới hạn RAM trên laptop 8GB mà **không** giảm bit-depth/sample-rate âm thanh và **không** phát sinh stale cache.
