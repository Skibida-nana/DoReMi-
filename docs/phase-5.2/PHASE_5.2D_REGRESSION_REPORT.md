# DOREMI — PHASE 5.2D: FULL REGRESSION & BOUNDARY REPORT

## 1. Phạm vi hồi quy đã kiểm chứng

Toàn bộ bộ kiểm thử Electron thật (`npm run test:electron` với FFmpeg + Foobar2000 Encoders pack) cộng thêm các ca mới trong [`tests/phase52-stability-integrity.test.ts`](file:///g:/Source%20code%20DoReMi/tests/phase52-stability-integrity.test.ts) và [`tests/phase52-security-regression.test.ts`](file:///g:/Source%20code%20DoReMi/tests/phase52-security-regression.test.ts) bao phủ:

1. **Audio Quality & Playback Pipeline**:
   - `AudioEngine` (`play`, `pause`, `resume`, `seek` không reload `src`, fade transitions không làm sai volume, `subscribeCore` lọc `timeupdate` churn).
   - `AudioDspGraph` (10-band / 8-band EQ, click-free branch gain sum === 1.0, bypass fallback khi lỗi).
   - ALAC 16-bit/44.1kHz, 24-bit/96kHz, 192kHz, asymmetric LSB PCM fidelity, FLAC sanitizer & HTTP 206 Byte-Range seeking.
   - Queue & True Shuffle (`#59`), repeat modes, context restoration (`phase2-playback-queue.test.ts`, `phase44-polish-shuffle-queue-overlay.test.ts`).
2. **Library Navigation & Virtualization Matrix (`0 → 50,000` tracks)**:
   - Sự cố double-click điều hướng sang `Library` từ cuối Phase 5.1 giữ nguyên phân loại `INTERMITTENT - NOT REPRODUCED`.
   - Kiểm tra toán học `computeQueueWindowSlice` tại mọi điểm biên: **`0, 1, 24, 79, 80, 81, 100, 500, 1000, 5000, 50000`**.
   - **Phát hiện & gia cố toán học thuần túy ([`src/renderer/src/utils/queue-virtualization.ts`](file:///g:/Source%20code%20DoReMi/src/renderer/src/utils/queue-virtualization.ts))**: Khi `scrollOffsetPx` tạm thời vượt quá `maxScrollPx = Math.max(0, totalItems * rowH - viewH)` (ví dụ thu hẹp/chuyển tab sau khi cuộn sâu danh sách lớn), `startIndex` trước đây có thể lớn hơn `endIndex`, làm slice trả về rỗng. Đã kẹp `clampedScroll <= maxScrollPx` và `startIndex <= endIndex` để luôn bảo toàn render đúng mọi hàng hiển thị mà không đổi UI hay layout.
3. **Personalization, Lyrics, Search, Profile & Codec Isolation**:
   - Multilingual/CJK/UTF-16/UTF-8 lyrics parsing & encoding, Vietnamese diacritic (`đ/Đ`, NFC/NFD) normalization, natural numeric sorting, Profile & GIF avatar, Editorial Gallery 7 thẻ, Theme presets, Codec Engine (`ffmpeg` + native encoder pack `18/18` ca khi đủ env).

## 2. Kết quả Quality Gate B

- `npm run lint` (`tsc --noEmit`): **PASS** (`0` errors)
- `npm run codecs:verify`: **OK** (`manifest.json` verified)
- `npm run test:electron` (Electron `45.4.1`, `FFMPEG_PATH` + `DOREMI_REAL_CODECS_DIR` thật): **`185 tests: 185 PASS, 0 FAIL, 0 SKIP`** (`4,721.65 ms`)
- `npm run build`: **PASS** (`verify-build` OK)
