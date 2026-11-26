# DOREMI — PHASE 5.1D: AUDIO ENGINE OPTIMIZATION

**Trạng thái**: `COMPLETED`  
**Mục tiêu**: Giảm chi phí snapshot và loại bỏ fan-out re-render không cần thiết trên tick `timeupdate` (~4 Hz) mà không làm suy giảm độ ổn định phát nhạc, audible scrubbing, Fade In/Out, ReplayGain hay AudioDSP.

---

## 1. Thay đổi đã thực hiện

1. **Core vs Position Subscription Split & Cached `canNext` trong `AudioEngine`** ([audio-engine.ts](file:///g:/Source%20code%20DoReMi/src/renderer/src/player/audio-engine.ts)):
   - Thêm `coreListeners`, `cachedCoreSnapshot`, `getCorePlaybackState()` và `subscribeCore()`.
   - Khi `timeupdate` phát ra mà không có thay đổi nào ở `status`, `currentTrackId`, `currentQueueEntryId`, `currentTrack`, `durationSeconds`, `volume`, `muted`, `errorMessage`, `playbackError`, `canPrevious` (ngưỡng > 3 giây), `canNext`, `playbackGeneration`, `shuffleEnabled`, `repeatMode`, `autoNextEnabled`, `remainingReplays`, tham chiếu `cachedCoreSnapshot` được giữ nguyên và `coreListeners` **không bị đánh thức**.
   - Cache `cachedCanNext` với cờ `canNextDirty` (chỉ invalid khi `queueController`, `syncTrackCatalog` hoặc luồng queue thay đổi) thay vì duyệt mảng `upcoming`/`context.trackIds` 4 lần/giây mỗi `timeupdate`.
   - Thêm guard tránh `emitState()` trùng lặp khi `currentTime` không đổi ở trạng thái không `playing`.
2. **Granular React Hooks trong `player-store.ts`** ([player-store.ts](file:///g:/Source%20code%20DoReMi/src/renderer/src/stores/player-store.ts)):
   - Nâng cấp `usePlaybackStatus()` dùng `subscribeCore()`.
   - Bổ sung `usePlaybackTrackId()`, `usePlaybackCoreState()`, và `usePlaybackTimeSeconds()` để các component lớn tách hẳn khỏi tick `timeupdate`.
   - Bảo toàn 100% API `usePlaybackState()` để không gãy các caller cũ.

---

## 2. Xác minh & Kiểm thử hồi quy

- Thêm test `Phase 5.1D: subscribeCore suppresses pure timeupdate churn while preserving 3s canPrevious & metadata updates` trong [`tests/audio-engine.test.ts`](file:///g:/Source%20code%20DoReMi/tests/audio-engine.test.ts).
- Toàn bộ Audio Engine / Fade / ALAC / AudioDSP tests đều PASS:
  - `npm run lint` (`tsc --noEmit`): **0 errors**.
  - `npm run test:electron`: **160 tests — 154 PASS, 0 FAIL, 6 SKIP** (`3,596.83 ms`).
