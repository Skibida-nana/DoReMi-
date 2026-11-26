# DOREMI — PHASE 5.1B: STARTUP & APPLICATION LIFECYCLE

**Trạng thái**: `COMPLETED`  
**Mục tiêu**: Giảm chi phí parse/compile JavaScript lúc khởi động Renderer, loại bỏ truy vấn SQLite + `fs.existsSync` lặp lại ở `ProfileService`, và đảm bảo teardown scan/DB an toàn khi thoát ứng dụng.

---

## 1. Thay đổi đã thực hiện

1. **Route & Drawer Code-Splitting** ([App.tsx](file:///g:/Source%20code%20DoReMi/src/renderer/src/app/App.tsx)):
   - Chuyển 10 trang phụ (`LibraryPage`, `AlbumDetailPage`, `PlaylistDetailPage`, `ArtistDetailPage`, `NowPlayingPage`, `AudioLabPage`, `SearchPage`, `StatisticsPage`, `SettingsPage`, `ProfilePage`) và `QueueDrawer` sang `React.lazy(...)` + `<Suspense fallback={null}>`.
   - `HomePage` (`EditorialPlaylistGallery`), `Sidebar`, `TopHeader`, `MiniPlayer`, `OverlayLayer` giữ nguyên eager mount để lần mở app đầu tiên không giật/nháy khung.
   - `QueueDrawer` chỉ mount và load chunk khi `ui.isQueueOpen === true`.
2. **Prepared Statements & Cached Snapshot trong `ProfileService`** ([profile-service.ts](file:///g:/Source%20code%20DoReMi/src/main/services/profile-service.ts)):
   - Chuẩn bị sẵn `stmtGetProfile`, `stmtGetPref`, `stmtWritePref`.
   - Cache `cachedProfile` và `cachedPreferences` trong bộ nhớ và invalidate ngay trên mọi mutation (`updateDisplayName`, `importAvatarFromFile`, `removeAvatar`, `writePreferenceJson`, `removeCustomBackground`).
3. **Graceful Teardown khi thoát app** ([index.ts](file:///g:/Source%20code%20DoReMi/src/main/index.ts)):
   - Lưu `activeLibraryService` và gọi `activeLibraryService?.cancelActiveScan()` trong `before-quit` trước khi `dbConnection?.close()`.

---

## 2. Kết quả đo lường (Before vs After)

| Chỉ số | Baseline (5.1A) | After (5.1B) | Thay đổi |
|---|---:|---:|---|
| Renderer Entry JS (`out/renderer/assets/index-*.js`) | `1,743.17 kB` (1 chunk đơn) | `676.72 kB` (+ `288.93 kB` runtime chunk) | **Giảm `~778 kB` tải ban đầu**; các trang nặng như `NowPlayingPage` (`270.82 kB`), `LibraryPage` (`156.33 kB`), `AudioLabPage` (`75.45 kB`) load on-demand |
| `ProfileService` (`getProfile` + `getPreferences` × 200) | `8.33 ms` | **`0.03 ms`** | **~277× nhanh hơn**, 0 `fs.existsSync` lặp |
| `tsc --noEmit` (`npm run lint`) | 0 errors | **0 errors** | PASS |
| `npm run test:electron` | 158 tests: 152 PASS, 0 FAIL, 6 SKIP | **158 tests: 152 PASS, 0 FAIL, 6 SKIP** | PASS |
| `npm run build` + `verify-build` | OK | **OK** | PASS (`./assets/` relative paths verified) |
