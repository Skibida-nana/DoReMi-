# DOREMI — PHASE 5.1C: RESOURCE MANAGEMENT (MEMORY, CPU, DISK I/O & IPC)

**Trạng thái**: `COMPLETED`  
**Mục tiêu**: Chặn bão IPC thừa trong quá trình quét thư viện và kiểm soát dung lượng cache artwork trên đĩa khi xóa bài/xóa thư viện.

---

## 1. Các vấn đề tài nguyên đã xử lý

1. **Loại bỏ IPC Storm trong quá trình Scan thư viện** ([ui-store.ts](file:///g:/Source%20code%20DoReMi/src/renderer/src/stores/ui-store.ts#L588-L611)):
   - Trước đó, `uiStore` lắng nghe `libraryStore.subscribe()` và kích hoạt `refreshPlaylistsAndFavorites()` (IPC `PLAYLIST_GET_SNAPSHOT`) + `uiStore.emit()` trên **mọi event `scanProgress`** miễn là người dùng có ≥ 1 playlist hoặc bài yêu thích.
   - Đã sửa để so sánh reference `snap.tracks === lastTracksRef`: các event chỉ cập nhật tiến độ quét (`scanProgress`, `isScanning`) giữ nguyên `tracks` reference nên **0 IPC roundtrip dư & 0 re-render toàn UI** mỗi file được quét.
2. **Dọn Artwork Cache Mồ Côi an toàn theo Content-Hash** ([artwork-service.ts](file:///g:/Source%20code%20DoReMi/src/main/services/artwork-service.ts#L568-L629), [library-service.ts](file:///g:/Source%20code%20DoReMi/src/main/services/library-service.ts#L364-L475)):
   - Thêm `ArtworkService.pruneOrphanedMediaFiles()` thu thập tập tên file & hash đang được `track_artwork` tham chiếu trước khi xóa các file mồ côi trong `artwork-custom/`, `artwork-cache/` và `artwork-thumbs/`.
   - Kích hoạt non-blocking sau `removeTracks()`, `removeWatchedFolder(..., 'remove-tracks')` và `clearAllImportedMusic()`.
   - Bảo toàn 100% ảnh dùng chung theo SHA-256 nếu vẫn còn bài hát khác trong album đang dùng.
3. **Kiểm toán giới hạn cache & timers hiện hữu**:
   - Xác nhận `adaptive-artwork.ts` đã giới hạn `MAX_ADAPTIVE_CACHE_ENTRIES = 48` (LRU) và tái sử dụng 2 offscreen canvas.
   - Xác nhận `AlacStreamManager` (`alac-decoder.ts`) giới hạn `MAX_OPEN_ALAC_TRACKS = 2` và `.unref()` timer 30s, tự dừng timer khi cache rỗng.

---

## 2. Xác minh & Kiểm thử hồi quy

- Thêm test `Phase 5.1C: pruneOrphanedMediaFiles removes unreferenced artwork files while keeping shared covers` vào [`tests/artwork-service.test.ts`](file:///g:/Source%20code%20DoReMi/tests/artwork-service.test.ts).
- `npm run lint` (`tsc --noEmit`): **0 errors**.
- `npm run test:electron`: **159 tests — 153 PASS, 0 FAIL, 6 SKIP** (`3,686.44 ms`).
