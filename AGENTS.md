# AGENTS.md — DoReMi AI Coding Agent Entry Point

DoReMi là trình phát nhạc cá nhân offline trên Windows (**Music Player First**), ưu tiên chất lượng âm thanh nguyên bản, độ ổn định phát nhạc, cá nhân hóa thẩm mỹ và tối ưu laptop phổ thông (dòng U, 8GB RAM, iGPU). Công cụ Codec/Converter/Analyzer chỉ là công cụ phụ trợ tùy chọn.

> **Không giả định mọi AI Coding Agent tự động đọc file này.** Xem hướng dẫn kích hoạt nhanh ở cuối [`README.md`](./README.md).

## 1. Thứ tự ưu tiên bất biến (Priority Hierarchy)
1. **Priority 0 — Playback Stability**: Không giật, không treo, không crash, không phụ thuộc Codec Pack hay Server.
2. **Priority 1 — Audio Quality**: Giữ nguyên bit depth / sample rate / số kênh nguồn; không gắn nhãn `Bit-Perfect` hay `verified-lossless` giả.
3. **Priority 2 — Personalization & UI**: Giữ nguyên bản sắc Home, Editorial Gallery 7 thẻ (2 chiều + Giant Typography), Mini Player, Now Playing, Themes, Custom Fonts/Background, Profile.
4. **Priority 3–4 — Library & Local First**: SQLite cục bộ offline; Server Connection (Phase 06) là tùy chọn bổ sung sau bản cá nhân.
5. **Priority 5–6 — Codec Engine & Audio Tools**: Lazy-init, `concurrency = 1` mặc định (`Power Saving`), cô lập lỗi tuyệt đối.

Chi tiết hiến pháp phát triển: [`DOREMI_CORE_PRINCIPLES.md`](./DOREMI_CORE_PRINCIPLES.md).

## 2. Context Loading Protocol (Đọc có chọn lọc)
1. **Level 1 (Bắt buộc mỗi tác vụ)**: Chỉ đọc `AGENTS.md` → [`.ai-context/CURRENT_STATE.md`](./.ai-context/CURRENT_STATE.md) → [`.ai-context/NEXT_TASK.md`](./.ai-context/NEXT_TASK.md).
2. **Level 2 (Tra cứu theo tác vụ)**: Chỉ đọc phần liên quan trong [`.ai-context/FILE_INDEX.md`](./.ai-context/FILE_INDEX.md), [`ARCHITECTURE_MAP.md`](./.ai-context/ARCHITECTURE_MAP.md), [`FEATURE_STATUS.md`](./.ai-context/FEATURE_STATUS.md), [`KNOWN_ISSUES.md`](./.ai-context/KNOWN_ISSUES.md), [`DECISIONS.md`](./.ai-context/DECISIONS.md), [`TEST_MATRIX.md`](./.ai-context/TEST_MATRIX.md). Không đọc toàn bộ repo hay báo cáo lịch sử nếu không cần.
3. **Level 3 (Source of Truth)**: Đọc source code thực tế, shared types, IPC/Preload contracts, callers và test liên quan. **Nếu tài liệu mâu thuẫn source code, source code là chân lý — sửa tài liệu trước rồi mới tiếp tục.**
4. **Level 4 (Mở rộng)**: Chỉ đọc rộng hơn khi chưa rõ nguyên nhân lỗi, lỗi build, bảo mật, hoặc thay đổi ảnh hưởng nhiều module.

## 3. Quy trình thực hiện chuẩn (8 bước)
1. Đọc Level 1 -> 2. Xác định phạm vi & Protected Areas -> 3. Tra cứu `FILE_INDEX.md` -> 4. Đọc source code liên quan -> 5. Xác định dependency & caller -> 6. Sửa tối thiểu đúng phạm vi -> 7. Chạy test theo `TEST_MATRIX.md` -> 8. Cập nhật `.ai-context/*` bị ảnh hưởng.

## 4. Protected Areas (Chỉ sửa khi có yêu cầu rõ ràng + test hồi quy)
- **Playback**: `audio-engine.ts`, `audio-dsp.ts`, `player-store.ts`, `audio-protocol.ts`, `audio-stream-handler.ts`, `alac-decoder.ts`.
- **UI & Personalization**: `HomePage.tsx`, `EditorialPlaylistGallery.tsx`, `gallery-motion.ts`, `HomeEditorialTypography.tsx`, `MiniPlayer.tsx`, `NowPlayingPage.tsx`, `ProfilePage.tsx`, `theme-presets.ts`, `ui-store.ts`.
- **Data**: `migrations.ts`, repositories trong `src/main/database/*`, `library-service.ts`, `profile-service.ts`, `statistics-service.ts`.

## 5. Bảo mật, Khôi phục & Chống lỗi thời
- **Bảo mật**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `shell: false` khi `spawn`, `fs.realpath` chống path traversal/symlink escape, Trust Policy trước khi chạy binary, chống SSRF/DNS rebinding. **Cấm lưu secret, đường dẫn cá nhân, dữ liệu nhạc thật trong `.ai-context/`.**
- **Khôi phục sau Cancelled / Quota Exceeded**: Ghi Task ID, phạm vi, file dự kiến sửa và `IN_PROGRESS` vào `NEXT_TASK.md` trước khi làm; lưu checkpoint vào `CURRENT_STATE.md` & `NEXT_TASK.md` sau mỗi bước nhất quán. Khi tiếp tục: đọc Level 1, kiểm tra file thực tế trên đĩa, không làm lại phần đã xong, **không tự chạy `git reset --hard` hay `git clean`**.
- **Incremental Memory Update**: Chỉ cập nhật các file `.ai-context/*` thực sự thay đổi; không nhân bản tài liệu trùng lặp; không tuyên bố `Passed` hoặc giảm token khi chưa đo/chạy thực tế.
