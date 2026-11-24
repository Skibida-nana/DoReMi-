# DOREMI CODEC RECOVERY STATUS — PHASE 01

Cập nhật lần cuối: 2026-11-24  
Phạm vi hiện tại: **Phase 01 — Interrupted Integration Recovery & Source Code Audit**

---

## 1. Trạng thái tích hợp trước khi khôi phục

- Quá trình triển khai yêu cầu `DOREMI - NATIVE AUDIO CODEC ENGINE & DEFAULT ENCODER PACK INTEGRATION` trước đó đã bị dừng (`Cancelled`) ngay sau khi ghi xong tầng **shared contracts/utilities** và **3 main-process services**, trước khi kết nối vào Electron Main Process, IPC Handlers, Preload Bridge, UI Renderer, scripts chuẩn bị Encoder Pack, Electron Builder và GitHub Actions.
- **Git / Checkpoint**: Môi trường workspace hiện tại không có thư mục `.git` (`fatal: not a git repository`), nên không có git commit/checkpoint tự động nào được tạo.
- **Baseline lỗi biên dịch trước khi khôi phục**:
  - `npm run lint` (`tsc --noEmit`): **FAILED** với đúng 1 lỗi `TS2740` tại `src/preload/index.ts(21,7)` vì `LosslessDesktopApi` trong `src/shared/types/ipc.ts` khai báo bắt buộc (`required`) 31 phương thức chưa được triển khai trong `src/preload/index.ts` (gồm 21 phương thức của Native Codec Engine và 10 phương thức dở dang từ Phase 8 trước đó).
  - `npm run build` (`electron-vite build`): **PASSED** (do Vite/Rolldown không chạy `tsc`, và các module codec mới chưa được import vào entry point main/preload/renderer).
  - `npm test`: **73/74 PASSED, 1 FAILED (lỗi có sẵn từ Phase 8, không do Codec Engine)** — `tests/database.test.ts:17` kỳ vọng `applied1.length === 4` trong khi migration `005_phase8_library_exclusions` đã được thêm vào `src/main/database/migrations.ts` từ trước đó.

---

## 2. Danh sách file đã tồn tại (liên quan đến Codec Engine)

| File | Đường dẫn | Trạng thái lưu | Trạng thái tích hợp |
| :--- | :--- | :--- | :--- |
| `codec-engine.ts` | `src/shared/types/codec-engine.ts` | Hoàn chỉnh (231 dòng), không cắt ngang, không lỗi cú pháp | Cô lập (chỉ được import bởi các module codec & `ipc.ts`) |
| `codec-registry.ts` | `src/shared/utils/codec-registry.ts` | Hoàn chỉnh (369 dòng), không lỗi cú pháp | Cô lập; có sai lệch danh sách file so với Free Encoder Pack 2026-03-13 (chuyển Phase 03/04) |
| `codec-command-builder.ts` | `src/shared/utils/codec-command-builder.ts` | Hoàn chỉnh (535 dòng), không lỗi cú pháp | Cô lập; có lỗi logic/tùy chọn cần sửa ở Phase 03/04 |
| `codec-manager.ts` | `src/main/services/codec/codec-manager.ts` | Hoàn chỉnh (673 dòng), không lỗi cú pháp | Cô lập hoàn toàn — chưa khởi tạo trong `src/main/index.ts` |
| `audio-analyzer.ts` | `src/main/services/codec/audio-analyzer.ts` | Hoàn chỉnh (435 dòng), không lỗi cú pháp | Cô lập hoàn toàn — chưa khởi tạo trong `src/main/index.ts` |
| `audio-processing-service.ts` | `src/main/services/codec/audio-processing-service.ts` | Hoàn chỉnh (599 dòng sau khi gia cố), không lỗi cú pháp | Cô lập hoàn toàn — chưa khởi tạo trong `src/main/index.ts` |
| `ipc.ts` (`LosslessDesktopApi`) | `src/shared/types/ipc.ts` | Hoàn chỉnh (184 dòng) | Đã khôi phục tính tương thích bằng optional `?` (đồng bộ quy ước Stage 6) |
| `channels.ts` | `src/shared/contracts/channels.ts` | Hoàn chỉnh (82 dòng) | Có 21 hằng số `CODEC_*`, chưa đăng ký `ipcMain.handle` |
| `manifest.json` | `resources/codecs/manifest.json` | Hoàn chỉnh (28 dòng) | File JSON tham chiếu tĩnh, chưa có binary thực tế & cần đối chiếu lại ở Phase 03/04 |

---

## 3. Danh sách file chưa tồn tại (Not Implemented)

- **Main / Preload / IPC wiring cho Codec Engine**:
  - Khởi tạo `CodecManager`, `AudioAnalyzerService`, `AudioProcessingService` trong `src/main/index.ts` (cần thiết kế lazy-init ở Phase 02/04).
  - IPC handlers `CODEC_*` trong `src/main/ipc/register-ipc.ts`.
  - Preload bindings trong `src/preload/index.ts`.
- **UI Renderer cho Codec Engine (Phase 05)**:
  - Chưa tồn tại bất kỳ trang, component, route, nút điều hướng, tab Settings hoặc context menu nào cho `Audio & Codecs`, `Codec Manager`, `Audio Converter`, `Batch Converter`, `Audio Analyzer`, hay `Codec Update Manager`.
- **Hệ thống chuẩn bị, đóng gói và kiểm thử Encoder Pack (Phase 04 & Phase 06)**:
  - `scripts/prepare-codec-pack.mjs` (Automated Codec Preparation / Extraction / Verification).
  - Các lệnh npm: `codecs:prepare`, `codecs:verify`, `codecs:test`, `codecs:clean` trong `package.json`.
  - Tài nguyên binary thực tế trong `resources/codecs/win32-x64/` (Default Encoder Pack, FFmpeg, FFprobe, license files).
  - Cấu hình `extraResources` cho `resources/codecs` trong `electron-builder.yml`.
  - Bước kiểm tra/chuẩn bị codec trong `.github/workflows/build-windows.yml`.
  - Bộ unit/integration test riêng cho Codec Engine (`tests/codec-engine.test.ts` chưa tồn tại).

---

## 4. Danh sách file chưa hoàn chỉnh / đang dở dang từ trước

- `src/main/ipc/register-ipc.ts` và `src/preload/index.ts`: chưa nối các phương thức Phase 8 (`LIBRARY_REMOVE_TRACKS`, ...) và chưa nối các phương thức Codec Engine (`CODEC_*`).
- `tests/database.test.ts`: assertion cũ (kỳ vọng 4 migration thay vì 5 sau khi Phase 8 thêm `005_phase8_library_exclusions`). Lỗi này có từ trước khi tích hợp Codec Engine và được giữ nguyên phạm vi theo nguyên tắc Phase 01.

---

## 5. Những lỗi đã phát hiện & đã sửa trong Phase 01

1. **Lỗi TypeScript compilation (`TS2740`) tại `src/preload/index.ts`** *(Đã sửa)*:
   - **Nguyên nhân**: 21 phương thức Codec Engine (và 10 phương thức Phase 8 chưa nối) được khai báo là bắt buộc trong `LosslessDesktopApi` (`src/shared/types/ipc.ts`), khiến `src/preload/index.ts` không thỏa interface.
   - **Cách sửa**: Chuyển các phương thức chưa được triển khai trong preload/IPC sang dạng optional (`?`), đồng nhất với cách khai báo Stage 6 ngay phía trên trong `src/shared/types/ipc.ts`. Không tạo mock giả, không dùng `any`, không tắt `strict`.
   - **Kết quả**: `npm run lint` (`tsc --noEmit`) **PASSED (0 errors)**.
2. **Nguy cơ mất file đầu ra khi ghi đè (`conflictPolicy === 'overwrite'`) trong `src/main/services/codec/audio-processing-service.ts`** *(Đã sửa tối thiểu)*:
   - **Nguyên nhân**: Mã cũ gọi `fs.rm(finalOutputPath)` trước `fs.rename(tempOutputPath, finalOutputPath)`. Nếu `rename` thất bại (file đang bị khóa hoặc lỗi I/O), file đích cũ sẽ bị mất vĩnh viễn.
   - **Cách sửa**: Đổi sang swap có bản sao lưu tạm (`.doremi-bak-*`): di chuyển file cũ sang backup trước khi `rename` file mới, tự khôi phục backup nếu `rename` lỗi, chỉ xóa backup sau khi đổi tên thành công.

---

## 6. Những lỗi chuyển sang Phase 03 (Bug Fix, Security & Resource Management)

### AudioProcessingService
- Concurrency mặc định là `2` và cho phép tối đa `4` thay vì mặc định `1` với chính sách ưu tiên/nhường CPU cho Music Playback.
- Chưa có `Pause Queue` và `Resume Queue`.
- Nguy cơ `retryFailedJobs()` chạy lại tác vụ vừa hủy khi child process cũ chưa dọn dẹp xong.
- Chưa có timeout cho tiến trình chuyển đổi (nguy cơ treo process vĩnh viễn).
- Xác minh file đầu ra mới chỉ kiểm tra `size > 0`, chưa kiểm tra cấu trúc/stream hợp lệ.
- Chưa có cơ chế khóa/khử trùng lặp khi nhiều job trong cùng batch trỏ về cùng `outputPath`.
- Cần xác minh dọn dẹp toàn bộ process tree (đặc biệt trên Windows khi hủy job đang pipe).
- Tiến trình khởi tạo gắn cứng `progressPercent = 2` thay vì phản ánh trạng thái thực.

### AudioAnalyzerService
- Gắn nhãn `verified-lossless` chỉ dựa vào tên codec (chưa phân biệt lossless thật với upsampled/transcoded).
- Phân loại WavPack là lossless dù chưa kiểm tra chế độ hybrid/lossy.
- Fallback suy đoán codec từ phần mở rộng file khi thiếu thông tin stream.
- Mặc định `channels = 2` và `bitDepth = 16` khi chưa đọc được thông số thực tế để ước tính PCM bitrate.
- Có thể nhầm `R128_TRACK_GAIN` với `Integrated LUFS`.
- `decoderStrategy` mới suy luận theo phần mở rộng & danh sách codec, chưa xác minh khả năng phát thực tế.
- Cảnh báo "chưa cài FFprobe" có thể gây hiểu nhầm khi `ffprobe` đã cài nhưng thực thi thất bại.

### CodecManager
- Xác thực binary mới chủ yếu kiểm tra file header (MZ/ELF/Mach-O), chưa xác minh kiến trúc CPU (x64 vs x86/ARM64) và dependency DLL đi kèm.
- `computeFileSha256` đọc toàn bộ file binary vào RAM (`fs.readFile`) thay vì streaming hash (`fs.createReadStream`).
- Chưa đối chiếu SHA-256 với bảng checksum tham chiếu đáng tin cậy.
- `getInventory` probe toàn bộ codec đồng thời bằng `Promise.all` (cần giới hạn concurrency + lazy probe).
- `probeBinaryVersion` đánh dấu `ready` ngay cả khi mã thoát khác `0` chỉ vì có output text.
- Mặc định `allowSystemPathLookup = true` (tìm executable trên System PATH).
- Chưa fallback sang pack/bundled nếu Custom Codec bị lỗi/hỏng.
- Thực thi binary `--version` trước khi xác minh đầy đủ độ tin cậy.
- `importCustomBinary` xóa thư mục custom codec cũ trước khi sao chép & xác minh bản mới.
- `importEncoderPackFromFolder` chưa dùng cơ chế staging atomic đầy đủ và chưa bảo toàn đầy đủ license files (`*_license.txt`).
- `rollbackPack` chưa khôi phục đầy đủ metadata phiên bản/ngày cài đặt trong `codec-state.json`.
- `validateSafeUpdateManifestUrl` mới kiểm tra chuỗi hostname/IP cơ bản, chưa chống DNS rebinding, redirect sang private IP, hoặc giới hạn dung lượng/schema phản hồi JSON.

### Codec Command Builder
- `normalizeConvertOptions` đặt `concurrency` mặc định là `2`.
- `bitDepth = 'source'` có thể xuất WAV PCM 24-bit cố định; FFmpeg pipe decoder mặc định `pcm_s24le`.
- Một số tùy chọn bit depth chưa được áp dụng đồng nhất cho từng encoder.
- Một số Native Encoder (`flac`, `lame`, `opusenc`, `oggenc2`, `wavpack`, `qaac`) chưa nhận đầy đủ cờ metadata và artwork khi chuyển đổi qua pipe.
- `-map 0:v?` trong FFmpeg chưa phân biệt `attached_pic` (album cover) với video stream thông thường.
- FFmpeg fallback chưa kiểm tra encoder cụ thể (`libmp3lame`, `libopus`, `libvorbis`, ...) có thực sự được biên dịch trong bản FFmpeg đang dùng hay không.
- `lan-lossless-flac` đang giới hạn tối đa 2 kênh (`clampInt(..., 1, 2)`).
- `isPathStrictlyWithinDirectory` mới so sánh chuỗi đường dẫn, chưa xử lý symlink/junction bằng `fs.realpath`.

---

## 7. Những thành phần cần hoàn thiện ở Phase 04 (Native Audio Engine, Default Encoder Pack & FFmpeg Integration)

- Đồng bộ chính xác `codec-registry.ts`, `codec-engine.ts`, `codec-manager.ts`, và `resources/codecs/manifest.json` với bộ **foobar2000 Free Encoder Pack 2026-03-13 thực tế**:
  - Bổ sung Codec ID riêng cho `refalac64.exe` (Reference ALAC Encoder) và `fhgaacenc.exe` (Fraunhofer AAC Encoder).
  - Sửa `qaac64.exe` thành `includedInFoobarPack: true`.
  - Tách bạch rõ các binary thực sự có trong Free Encoder Pack 2026-03-13 (`fhgaacenc.exe`, `flac.exe`, `lame.exe`, `mpcenc.exe`, `oggenc2.exe`, `opusenc.exe`, `qaac64.exe`, `refalac64.exe`, `wavpack.exe`, `nsutil.dll` + các file `*_license.txt`) khỏi các codec tùy chọn/bổ sung ngoài pack (`fdkaac`, `opusdec`, `wvunpack`, `mpcdec`, `tak`, `mac`, `ffmpeg`, `ffprobe`).
  - Thêm `nsutil.dll` vào `SUPPORTING_DLL_ALLOWLIST` và lưu/hiển thị đầy đủ file bản quyền `*_license.txt`.
  - Xem xét hỗ trợ target cho `mpcenc.exe` hoặc gắn nhãn rõ ràng phạm vi hỗ trợ.
- Xây dựng script chuẩn bị/kiểm tra/dọn dẹp Encoder Pack (`npm run codecs:prepare`, `codecs:verify`, `codecs:test`, `codecs:clean`) hỗ trợ nhập trực tiếp thư mục đã giải nén trên Windows.
- Kết nối IPC/Preload theo nguyên tắc **lazy-init, không ảnh hưởng khởi động & playback**.
- Cấu hình `extraResources` trong `electron-builder.yml` và tích hợp bước kiểm tra trong `.github/workflows/build-windows.yml`.

---

## 8. Những giao diện cần triển khai ở Phase 05 (UI & User Experience Integration)

- Thiết kế tối giản, không làm rối Music Player chính, bảo toàn 100% giao diện Home / Playlist Gallery / Now Playing / Mini Player / Themes / Personalization:
  - Mục **Audio & Codecs** trong Settings (hoặc khu vực công cụ phụ không chiếm chỗ trải nghiệm nghe nhạc).
  - **Codec Manager** (hiển thị trạng thái thực, nhập thư mục Free Encoder Pack, nhập custom binary, kiểm tra/khôi phục).
  - **Audio Converter & Batch Converter** (hàng đợi, tạm dừng/tiếp tục/hủy, chọn preset/định dạng/thư mục đích).
  - **Audio Analyzer** (chạy theo yêu cầu từ bài hát hoặc file cục bộ, không tự động chạy khi mở app).
  - Phân biệt trung thực trạng thái Web Preview (không có Desktop Runtime) vs Windows Desktop (không hiển thị trạng thái codec giả).

---

## 9. Những kiểm thử cần thực hiện ở Phase 06 (Testing, Performance Verification & Windows Packaging)

- Unit & integration test đầy đủ cho `codec-registry`, `codec-command-builder`, `CodecManager`, `AudioAnalyzerService`, `AudioProcessingService`.
- Kiểm thử thực thi native binary thật trên Windows x64 (`flac.exe`, `lame.exe`, `opusenc.exe`, `oggenc2.exe`, `wavpack.exe`, `qaac64.exe`, `refalac64.exe`, `fhgaacenc.exe`, `mpcenc.exe`, `ffmpeg.exe`, `ffprobe.exe`).
- Kiểm thử hiệu năng & tài nguyên trên laptop dòng U (8GB RAM, iGPU) khi phát nhạc đồng thời với batch convert (đảm bảo không giật/rớt tiếng).
- Kiểm thử đóng gói Windows NSIS Setup EXE + Portable ZIP với `extraResources` và xác minh không tạo binary/checksum giả.

---

## 10. Tổng kết trạng thái xác minh cuối Phase 01

- **Music Player**: Cô lập hoàn toàn khỏi Codec Engine; không có tiến trình codec/FFmpeg/FFprobe chạy ngầm; 38/38 bài test playback, ALAC WASM, Audio DSP, Fade, Vinyl, Playlist Gallery, Lyrics, Profile & Statistics đều **PASSED**.
- **TypeScript (`npm run lint`)**: **PASSED** (`tsc --noEmit`, 0 lỗi).
- **Build (`npm run build`)**: **PASSED** (`electron-vite build` tạo đủ `out/main/index.js`, `out/preload/index.cjs`, `out/renderer/index.html`).
- **Web Preview (`http://localhost:3000`, Chromium 1440×900)**: **PASSED** — 0 lỗi console, 0 cảnh báo; xác minh thành công Home, Playlist Gallery (chuyển tới/lùi 2 chiều `01/07 <-> 02/07`), Mini Player, Library, Search, Favorites, Statistics, Audio Lab, Now Playing, Settings, Profile.
- **Desktop Verification (Windows EXE, native binaries, real audio output)**: **Pending Desktop Verification** (không thể chạy trong sandbox Linux Web Preview).
- **Bước cuối cùng đã hoàn thành**: **Step 6 — Handover Report (Phase 01 Completed)**.
