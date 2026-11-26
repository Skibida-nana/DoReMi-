# DOREMI — PHASE 5.1: IMPLEMENTATION PLAN (`5.1B → 5.1G`)

**Nguyên tắc bất biến**:
1. Giữ nguyên tuyệt đối **Playback Stability**, **Audio Quality** (zero auto-downsampling/bit-depth drop/lossy transcode/downmix/DSP ngoài ý muốn), **Data Integrity** (Track IDs, Playlists, Favorites, Overrides, Artwork, Lyrics, Stats), và **UI/UX Identity** (Home Editorial Gallery, Now Playing, Focus Vinyl, Lyrics modes, Mini Player, True Shuffle `#59`, Themes, Fonts, Profile).
2. Thực hiện tuần tự từng giai đoạn `5.1B → 5.1G`; sau mỗi giai đoạn chạy test + đo lại benchmark liên quan và xuất báo cáo ngắn gọn.
3. Không sửa bừa **Protected Areas** nếu chưa có bằng chứng bottleneck từ Phase 5.1A; mọi sửa đổi ở Protected Areas bắt buộc kèm regression test.

---

## Roadmap Từng Giai Đoạn

### Phase 5.1B — Startup & Application Lifecycle
- **Mục tiêu**: Giảm chi phí parse/execute lúc khởi động Renderer, bỏ synchronous disk stat dư thừa lúc app boot, giữ lazy-init tuyệt đối cho Codec Engine.
- **Kế hoạch kỹ thuật**:
  1. Code-splitting `App.tsx` bằng `React.lazy` + `Suspense` cho các route ít dùng tức thời lúc cold boot (`LibraryPage`, `SearchPage`, `NowPlayingPage`, `AlbumDetailPage`, `ArtistDetailPage`, `PlaylistDetailPage`, `StatisticsPage`, `AudioLabPage`, `SettingsPage`, `ProfilePage`, `VinylStoryboardPage`) — giữ `HomePage` (`EditorialPlaylistGallery`), `Sidebar`, `TopHeader`, `MiniPlayer`, `OverlayLayer` sẵn sàng ngay lần render đầu.
  2. Tinh gọn `ProfileService` (`getProfile`, `getPreferences`): dùng cached statement + in-memory snapshot invalidation theo mutation thay vì query + `fs.existsSync` lặp đi lặp lại.
  3. Xác minh cleanup khi `before-quit` / `window-all-closed` (`diagnosticsService.flush()`, `disposeSharedAlacStreamManager()`, `dbConnection.close()`).

### Phase 5.1C — Resource Management (Memory, CPU, GPU, Disk I/O, IPC)
- **Mục tiêu**: Giảm allocation rác, dọn cache artwork mồ côi/quá ngưỡng hợp lý, giảm GPU overdraw & CPU wakeups.
- **Kế hoạch kỹ thuật**:
  1. **Bounded Artwork Disk Cache & Cleanup** (`ArtworkService`): thêm cơ chế dọn file cache/thumb không còn được `track_artwork` tham chiếu (safe orphan cleanup + clear-library cleanup) để cache không phình vô hạn khi user import/delete nhiều lần.
  2. **Adaptive Artwork & Blur Optimization** (`adaptive-artwork.ts`): xem xét cache & bounding kích thước snapshot, tránh tạo object/URL thừa khi không đổi track hoặc cùng artwork URL/hash.
  3. **Main/IPC Allocation & Map Lookups**: cache lookup map track theo `id` / `normalized_path` ở renderer (`libraryStore` / `uiStore`), thay `favoriteIds.includes(...)` bằng `Set<string>` $O(1)$.

### Phase 5.1D — Audio Engine Optimization
- **Mục tiêu**: Bảo toàn độ ổn định phát nhạc và audible scrubbing, giảm CPU overhead của `timeupdate` fan-out và session checkpoint mà **không làm mất độ mượt progress/lyrics**.
- **Kế hoạch kỹ thuật**:
  1. Audit & tối ưu `AudioEngine.buildSnapshot()` / `emitState()` để không tái cấp phát hoặc recompute dư khi các field control/queue không đổi (chỉ tính `canPrevious` / `canNext` hoặc tái sử dụng control state khi phù hợp).
  2. Đảm bảo các subscriber không cần `currentTimeSeconds` không phải nhận tick `timeupdate` (hoặc tách selector granular `usePlaybackPosition()` / `usePlaybackCore()` ở `player-store.ts` trong khi giữ tương thích API `usePlaybackState()`).
  3. Giữ nguyên `AudioDspGraph` signal integrity, FLAC zero-copy streaming & ALAC 206 byte-range seeking; viết test hồi quy kiểm tra độ chính xác seek/pause/next/shuffle/DSP.

### Phase 5.1E — UI Rendering & Animation Optimization
- **Mục tiêu**: Loại bỏ cơn bão re-render 4 Hz từ `timeupdate`, cache derived data (`getUnifiedTracks`, `getDerivedAlbums`), virtualize danh sách lớn (`100..50,000`), và tối ưu tìm kiếm tiếng Việt / CJK.
- **Kế hoạch kỹ thuật**:
  1. **`player-store.ts` Granular Subscriptions**: tách `usePlaybackTrackMeta()` / `usePlaybackTime()` / `usePlaybackStatus()` để `LibraryPage`, `TrackList`, `AudioLabPage` không re-render khi chỉ `currentTimeSeconds` nhảy 4 lần/giây; tách thanh progress + time label của `MiniPlayer` (hoặc cô lập `time` sub-component) để phần còn lại của `MiniPlayer` đứng yên trong lúc phát.
  2. **`NowPlayingPage.tsx` Tick Isolation**: tách các phần phụ thuộc `currentTimeSeconds` (progress bar / circular progress / synced lyric active highlight) khỏi các vùng tĩnh (metadata card, artwork backdrop crossfade, tabs, controls) hoặc memoize ổn định bằng `useMemo`/`React.memo` + `Map` lookup $O(1)$ thay `library.tracks.find(...)`.
  3. **`ui-store.ts` Memoized Derived Cache**: cache `getUnifiedTracks()`, `getUnifiedTrackMap()`, `getDerivedAlbums()` theo `library.tracks` reference (zero stale state, tự invalidate ngay khi `library.tracks` đổi).
  4. **Windowed Virtualization cho `LibraryPage` (`TrackList` nếu cần)**: áp dụng `computeQueueWindowSlice` (threshold `80` dòng) để thư viện `5,000–50,000` bài chỉ render ~30–45 DOM nodes hiển thị, không giật khi cuộn hay multi-select!
  5. **Search & Sort Optimization (`vietnamese-search.ts`, `LibraryPage`, `SearchPage`)**: thêm `normalizeVietnameseText` memoized query / precomputed search index cho danh sách lớn + Schwartzian transform (precompute sort key) cho sort ở `50,000` bài.

### Phase 5.1F — Library, Database & Cache Optimization
- **Mục tiêu**: Rút `ArtworkService.enrichTracks(50k)` từ `~3,358 ms` xuống `< 100 ms`, tăng tốc incremental rescan nhiều lần, bổ sung SQLite indexes thiếu.
- **Kế hoạch kỹ thuật**:
  1. **`ArtworkService` In-Memory Stat / Cache Manifest**: duy trì tập/cache file hiện có trong `customDir` / `cacheDir` / `thumbDir` (lập chỉ mục batch hoặc bounded existence cache được invalidate ngay khi write/delete/clear), loại bỏ `fsSync.existsSync()` lặp `3N` lần trong `enrichTracks()`!
  2. **Incremental `rescanLibrary()` Fast-Path**:
     - Batch/bounded concurrency (`CONCURRENCY = 16` hoặc `8`) khi `inspectFile` các `scopedTracks` thay vì await tuần tự 1-by-1.
     - Pre-compute `root` matching hiệu quả.
     - Khi `discoverAudioFilesInFolder()` trả về danh sách file thuộc các root, **lọc bỏ trước các file đã khớp `size`, `modified_at_ms`, `status === 'available'`, `metadata_version >= CURRENT_TRACK_METADATA_VERSION`, `file_name` present** — KHÔNG đẩy hàng nghìn file không đổi sang `importFiles()` / `upsertBatch()` / IPC progress từng file!
     - Trong `syncAutoArtworkForTrack`: tránh re-parse tag cho track đã kiểm tra cùng `modified_at_ms` (khi chưa thay đổi file gốc trên đĩa).
  3. **SQLite Indexes Migration (`v9`)**: bổ sung index hữu ích cho `listening_sessions(started_at_ms)`, `listening_sessions(track_id)`, `tracks(modified_at_ms)` nếu truy vấn thống kê/quét sử dụng, giữ migration an toàn có backup tự động.

### Phase 5.1G — Codec Engine Optimization
- **Mục tiêu**: Giữ nguyên cô lập tuyệt đối (`0` runtime imports vào Music Player), kiểm tra FFmpeg lifecycle, cache capability & verification, resource policy contention khi user vừa nghe nhạc vừa convert, và verify clean temp-file cancellation.
- **Kế hoạch kỹ thuật**:
  1. Audit toàn bộ `src/main/services/codec/` (`codec-manager.ts`, `audio-processing-service.ts`, `audio-analyzer.ts`, `ffmpeg-capabilities.ts`, `resource-policy.ts`, `process-execution.ts`).
  2. Tinh gọn nếu có redundant disk access / temp cleanup gap / capability cache miss / playback contention hysteresis.
  3. Chạy đầy đủ test Codec Engine (kể cả với `FFMPEG_PATH` thật trong môi trường sẵn có nếu chạy được trong sandbox).

---

## Rủi ro & Rollback Guardrails
- Đã có backup toàn bộ source trước Phase 5.1 ngoài workspace (`backup-PHASE-5.1-PRE-OPT-BASELINE`).
- Mỗi stage kết thúc bằng:
  - `npm run lint` (`0` errors)
  - `npm run test:electron` (`0` failures)
  - `npm run codecs:verify`
  - `npm run build` (`verify-build` OK)
  - Re-run benchmark liên quan để chứng minh cải thiện đo được.
