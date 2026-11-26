# DOREMI — PHASE 5.2A: STABILITY ENGINEERING REPORT

## 1. Hạng mục rà soát & gia cố

1. **Main Process Global Exception & Child Process Safety ([`src/main/index.ts`](file:///g:/Source%20code%20DoReMi/src/main/index.ts), [`src/main/utils/runtime-resilience.ts`](file:///g:/Source%20code%20DoReMi/src/main/utils/runtime-resilience.ts))**:
   - Trước Phase 5.2: chưa đăng ký global `process.on('uncaughtException')`, `process.on('unhandledRejection')`, `render-process-gone`, hoặc `child-process-gone`.
   - Đã bổ sung `registerGlobalMainSafetyHandlers()`:
     - Lọc bỏ `AbortError` / `ABORT_ERR` vô hại khi hủy scan/request (`isIgnorableAbortError`).
     - Tuần tự hóa lỗi an toàn với object vòng lặp và loại bỏ ký tự điều khiển (`formatUnexpectedErrorDetail`).
     - Ghi log crash giới hạn dung lượng `<= 512 KB` có xoay vòng `.1.log` (`writeBoundedCrashDumpSync` vào `<userData>/logs/main-crash.log`) đồng thời ghi vào `DiagnosticsService`.
   - Bổ sung listener `render-process-gone` cho `mainWindow.webContents`: bỏ qua `clean-exit`, ghi log crash + diagnostic, tự phục hồi tối đa 1 lần trong cửa sổ 15 giây (`createCrashRecoveryLimiter(15_000)` để tránh vòng lặp reload vô tận) và hiện hộp thoại tiếng Việt bảo toàn SQLite nếu lỗi lặp lại.

2. **Renderer View Error Isolation ([`src/renderer/src/components/AppErrorBoundary.tsx`](file:///g:/Source%20code%20DoReMi/src/renderer/src/components/AppErrorBoundary.tsx), [`src/renderer/src/app/App.tsx`](file:///g:/Source%20code%20DoReMi/src/renderer/src/app/App.tsx))**:
   - Bổ sung `<AppErrorBoundary>` bọc phần nội dung route/lazy `<Suspense>` trong `<main>`, giữ nguyên `Sidebar`, `TopHeader`, `MiniPlayer` và `AudioEngine` không bị sập hoặc màn hình trắng toàn app nếu một view con lỗi bất ngờ.
   - Tự động reset state lỗi khi đổi `resetKey` (chuyển route/album/playlist/artist) hoặc khi người dùng bấm "Thử tải lại trang" / "Về Trang chủ".

3. **Device, Storage & Decode Isolation (Rà soát xác nhận giữ nguyên)**:
   - Thiết bị lưu trữ rời bị rút / file mất: `library-service` đánh dấu `missing` / `source_unavailable` qua `verifyTrackAvailability` không xóa mất metadata/playlist/history; `audio-stream-handler` trả 404/lỗi rõ ràng mà không crash Main process.
   - ALAC / FLAC stream lỗi: `alac-decoder.ts` + `flac-stream-sanitizer.ts` cô lập từng stream; `AudioDspGraph` tự fallback bypass khi lỗi Pre-bind/Post-bind để giữ audio tiếp tục phát.
   - Timer & Listener cleanup: `before-quit` hủy scan đang chạy, flush `DiagnosticsService`, giải phóng `disposeSharedAlacStreamManager()` và đóng DB.

## 2. Kết quả kiểm thử

- Kiểm chứng bằng [`tests/phase52-stability-integrity.test.ts`](file:///g:/Source%20code%20DoReMi/tests/phase52-stability-integrity.test.ts) (case `Phase 5.2A`): kiểm tra circular error formatting, control character sanitization, `AbortError` filtering, recovery cooldown limiter (`15_000 ms`) và rotation crash log (`main-crash.log` -> `main-crash.1.log`).
- Kiểm chứng `npm run smoke:electron` sau build production xác nhận Main + Preload + Renderer + `AppErrorBoundary` khởi động sạch (`rootChildren=2`).
