# DOREMI — PHASE 5.2C: SECURITY & PRIVACY AUDIT REPORT

## 1. Electron & Chromium Hardening

- **Cấu hình `BrowserWindow`** ([`src/main/windows/main-window.ts`](file:///g:/Source%20code%20DoReMi/src/main/windows/main-window.ts)):
  - `nodeIntegration: false`
  - `contextIsolation: true`
  - `sandbox: true`
  - `webSecurity: true`
  - `allowRunningInsecureContent: false`
  - `setWindowOpenHandler(() => ({ action: 'deny' }))` chặn mọi popup / cửa sổ ngoài.
  - `will-navigate` chặn điều hướng khỏi ứng dụng (chỉ cho phép `ELECTRON_RENDERER_URL` trong chế độ dev).
- **Content Security Policy** ([`src/main/index.ts`](file:///g:/Source%20code%20DoReMi/src/main/index.ts)):
  - Production CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';`.

## 2. Custom Protocol, Path Traversal & Input Boundaries

- **`lossless-media://` Protocol** ([`src/shared/contracts/media-protocol.ts`](file:///g:/Source%20code%20DoReMi/src/shared/contracts/media-protocol.ts), [`src/main/services/audio-stream-handler.ts`](file:///g:/Source%20code%20DoReMi/src/main/services/audio-stream-handler.ts)):
  - Yêu cầu UUID chuẩn (`TRACK_UUID_REGEX`) hoặc ID font regex hợp lệ (`EDITORIAL_FONT_ID_REGEX`), từ chối `..`, `\`, `%2f`, `%5c`, `%00`, query/port/username/hash bất thường.
  - Đường dẫn file thực tế được truy vấn từ SQLite `tracks`, tuyệt đối không nhận path trực tiếp từ Renderer URL.
  - Chặn CORS origin lạ ngoài `file://`, `lossless-media://`, `localhost`/`127.0.0.1` bằng HTTP `403`.
- **IPC & CLI Boundary** ([`src/main/ipc/validators.ts`](file:///g:/Source%20code%20DoReMi/src/main/ipc/validators.ts), [`src/main/utils/cli-audio-args.ts`](file:///g:/Source%20code%20DoReMi/src/main/utils/cli-audio-args.ts)):
  - Giới hạn `MAX_BATCH_IDS = 10_000`, chuẩn hóa và lọc trùng UUID ở Main process.
  - Explorer "Open With" (`argv`) lọc bỏ flags `-`/`--`, URI scheme (`http://`, `file://`), NUL bytes, đường dẫn tương đối, extension không được hỗ trợ.
  - `LyricsService` giới hạn file lyric sidecar/import tối đa `2 MB` (`MAX_LYRICS_FILE_BYTES`); `ArtworkService`/`ProfileService` kiểm tra magic bytes ảnh JPG/PNG/WEBP/GIF trước khi lưu.
- **Codec Process Security** ([`src/main/services/codec/process-execution.ts`](file:///g:/Source%20code%20DoReMi/src/main/services/codec/process-execution.ts)):
  - `defaultNativeProcessAdapter` luôn dùng `shell: false`, `windowsHide: true`, kiểm tra NUL bytes và thực thi qua Trust Policy / PE header verification.

## 3. Dependency Vulnerability & Offline Privacy Audit

- **Offline / Zero Telemetry**: Grep toàn bộ `src/` xác nhận `0` cuộc gọi `fetch`, `openExternal`, `http://`/`https://` (ngoài dev `localhost`), `WebSocket`, `dgram`, hoặc listening port mạng; ứng dụng chạy thuần offline 100%.
- **Kiểm tra `npm audit`** (chạy trực tiếp ngày 2026-11-26):
  - **Production Dependencies (`23` packages)**: **`0` lỗ hổng** (`info: 0, low: 0, moderate: 0, high: 0, critical: 0`).
  - **All Dependencies (`465` packages)**: `6` mức `moderate` nằm trong chuỗi công cụ đóng gói devDependency (`electron-builder` → `@electron/universal` → `minimatch`), **`0` high, `0` critical**, không nằm trong gói runtime production (`asar` chỉ đóng gói runtime dependencies).
