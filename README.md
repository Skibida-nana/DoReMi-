# Lossless Player — Giai đoạn 1 (Windows Desktop Offline)

Ứng dụng nghe nhạc lossless chạy **100% cục bộ và offline trên Windows PC**, xây dựng bằng **Electron + React + TypeScript + electron-vite + SQLite (`better-sqlite3`) + `music-metadata` + `electron-builder`**.

- Không dùng cloud, không đăng nhập, không API Internet, không telemetry, không auto-updater.
- Không sao chép, di chuyển, chỉnh sửa tag hay xóa file nhạc gốc.
- Lưu danh sách nhạc và đường dẫn gốc trong cơ sở dữ liệu SQLite đặt tại thư mục `userData` của Windows (`%APPDATA%\Lossless Player\library.db`).

---

## 1. Cấu trúc mã nguồn

```text
lossless-player/
├── electron.vite.config.ts        # Cấu hình build Main, Preload (CJS sandbox), Renderer
├── electron-builder.yml           # Cấu hình đóng gói Windows NSIS Installer & Portable EXE
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── shared/
│   │   ├── contracts/
│   │   │   ├── channels.ts        # Danh sách kênh IPC dùng chung
│   │   │   └── media-protocol.ts  # Hợp đồng lossless-media://track/<uuid> & kiểm tra UUID
│   │   └── types/
│   │       ├── track.ts           # Kiểu dữ liệu bài hát
│   │       ├── library.ts         # Kiểu dữ liệu thư mục nguồn, tiến độ quét, báo cáo lỗi
│   │       ├── player.ts          # Trạng thái và interface AudioEngine
│   │       └── ipc.ts             # Interface API qua contextBridge
│   ├── main/
│   │   ├── index.ts               # Điểm vào Electron Main, single-instance lock, userData DB, CSP
│   │   ├── windows/
│   │   │   └── main-window.ts     # Cửa sổ BrowserWindow (contextIsolation, sandbox, nodeIntegration: false)
│   │   ├── database/
│   │   │   ├── connection.ts      # Mở SQLite WAL + PRAGMA foreign_keys = ON
│   │   │   ├── migrations.ts      # Bảng schema_migrations & migration v1 (tracks, library_roots)
│   │   │   ├── track-repository.ts        # Prepared statements & transaction cho bảng tracks
│   │   │   └── library-root-repository.ts # Prepared statements cho bảng library_roots
│   │   ├── services/
│   │   │   ├── path-utils.ts      # Chuẩn hóa đường dẫn Windows, Unicode tiếng Việt NFC
│   │   │   ├── metadata-service.ts        # Đọc metadata chỉ-đọc bằng music-metadata
│   │   │   ├── scanner-service.ts # Quét thư mục con bất đồng bộ, cô lập lỗi
│   │   │   ├── library-service.ts # Điều phối import files/folder, rescan, đánh dấu missing
│   │   │   ├── audio-stream-handler.ts    # Xử lý HTTP Range 206 & chặn path traversal
│   │   │   └── audio-protocol.ts  # Đăng ký custom protocol lossless-media:// trong Electron
│   │   └── ipc/
│   │       ├── validators.ts      # Kiểm tra đầu vào IPC (UUID)
│   │       └── register-ipc.ts    # Handler IPC & hộp thoại chọn file/thư mục Windows
│   ├── preload/
│   │   ├── index.ts               # Expose window.losslessApi qua contextBridge
│   │   └── index.d.ts
│   └── renderer/
│       ├── index.html             # Offline CSP nghiêm ngặt
│       └── src/
│           ├── main.tsx
│           ├── app/App.tsx
│           ├── pages/LibraryPage.tsx
│           ├── components/        # HeaderBar, LibrarySidebar, StatusBanner, TrackList, PlaybackBar
│           ├── player/audio-engine.ts     # Singleton HTMLAudioElement tách biệt khỏi React
│           ├── stores/            # library-store.ts, player-store.ts (tái sử dụng cho Mini Player/Now Playing)
│           ├── utils/formatters.ts
│           └── styles/index.css
└── tests/                         # Kiểm thử tự động bằng node:test (chạy qua npm test)
```

---

## 2. Yêu cầu chuẩn bị trên máy Windows (dành cho người mới)

Trước khi chạy mã nguồn trên máy Windows 10/11 (64-bit), cần cài đặt:

1. **Node.js 22 LTS (64-bit)**:
   - Tải tại trang chính thức `https://nodejs.org/` (chọn bản **22.x LTS**).
   - Khi cài đặt, giữ nguyên các tùy chọn mặc định.
   - Kiểm tra sau khi cài: mở **PowerShell** hoặc **Command Prompt**, gõ:
     ```powershell
     node -v
     npm -v
     ```
   - **Kết quả mong đợi**: `node -v` hiện `v22.x.x`, `npm -v` hiện `10.x.x` trở lên.

2. *(Chỉ cần nếu máy báo lỗi biên dịch native `better-sqlite3`)*:
   - `better-sqlite3` v13 sử dụng Node-API (`node-addon-api`). Nếu máy không tải được bản biên dịch sẵn hoặc cần `npm run rebuild:electron`, cài thêm **Visual Studio Build Tools** với workload **Desktop development with C++** và **Python 3**.

---

## 3. Hướng dẫn cài đặt và chạy từng bước trên Windows

### Bước 1: Giải nén mã nguồn và mở thư mục dự án

1. Giải nén thư mục dự án vào đường dẫn ngắn, ví dụ: `C:\Apps\lossless-player`.
2. Mở **PowerShell** trong thư mục đó (giữ Shift + chuột phải trong thư mục -> chọn **Open PowerShell window here** hoặc **Open in Terminal**).

### Bước 2: Cài đặt thư viện

```powershell
npm install
```

- **Kết quả mong đợi**: Tải xong các gói trong `package-lock.json`, không báo lỗi đỏ `ERR!`.
- **Nếu gặp lỗi `better-sqlite3` không tương thích Electron ABI**: Chạy thêm:
  ```powershell
  npm run rebuild:electron
  ```

### Bước 3: Chạy kiểm thử tự động

```powershell
npm test
```

- **Kết quả mong đợi**: Tất cả bộ test (`path-utils`, `database`, `metadata-scanner`, `library-service`, `audio-protocol`, `audio-engine`) đều báo **pass** (0 fail).

### Bước 4: Chạy ứng dụng desktop ở chế độ phát triển

```powershell
npm run dev
```

- **Kết quả mong đợi**:
  - Một **cửa sổ ứng dụng Windows riêng** mang tiêu đề **Lossless Player** hiện ra với nền tối (dark theme).
  - Không mở trình duyệt web.
  - Không hiện cảnh báo "ngoài môi trường Electron".
  - Góc dưới thanh bên trái hiển thị đường dẫn file `library.db` nằm trong `C:\Users\<TênUser>\AppData\Roaming\Lossless Player\library.db`.

### Bước 5: Build kiểm tra mã nguồn đóng gói

```powershell
npm run build
```

- **Kết quả mong đợi**: Tạo ra thư mục `out/` chứa `out/main/index.js`, `out/preload/index.cjs`, và `out/renderer/index.html` mà không có lỗi TypeScript/Vite.

### Bước 6: Đóng gói file EXE chạy độc lập trên Windows

```powershell
npm run dist
```

Hoặc tạo riêng từng loại:
- Chỉ tạo bộ cài đặt NSIS: `npm run dist:nsis`
- Chỉ tạo bản chạy ngay Portable EXE: `npm run dist:portable`

- **Artifact được tạo ra trong thư mục `release/`**:
  1. `Lossless Player-0.1.0-x64-nsis.exe` — Bộ cài đặt Windows (NSIS Installer), cho phép chọn thư mục cài, giữ lại `library.db` khi nâng cấp hoặc gỡ cài đặt (`deleteAppDataOnUninstall: false`).
  2. `Lossless Player-0.1.0-x64-portable.exe` — File EXE chạy trực tiếp, không cần cài Node.js trên máy sử dụng.

---

## 4. Các lệnh npm trong `package.json`

| Lệnh | Mục đích |
| :--- | :--- |
| `npm install` | Cài toàn bộ thư viện theo `package-lock.json` |
| `npm run dev` | Tự động chạy ứng dụng desktop Windows Electron (`electron-vite dev`); chỉ chuyển sang xem trước giao diện Renderer nếu chạy trong môi trường web sandbox headless truyền cờ `--port`/`--host` |
| `npm run dev:electron` | Chạy trực tiếp ứng dụng desktop Electron (`electron-vite dev`) |
| `npm run build` | Build Main, Preload và Renderer vào `out/` (`electron-vite build`) |
| `npm run dist` | Build và đóng gói cả NSIS Installer + Portable EXE vào `release/` |
| `npm run dist:nsis` | Chỉ đóng gói Windows NSIS Installer |
| `npm run dist:portable` | Chỉ đóng gói Windows Portable EXE |
| `npm run rebuild:electron` | Biên dịch lại native module `better-sqlite3` cho phiên bản Electron hiện tại |
| `npm test` | Chạy toàn bộ kiểm thử tự động (`tsx --test tests/*.test.ts`) |
| `npm run lint` | Kiểm tra kiểu TypeScript (`tsc --noEmit`) |
| `npm run dev:ui` | *(Chỉ dùng cho dev kiểm tra giao diện Renderer độc lập trên trình duyệt, không có SQLite/filesystem)* |

---

## 5. Định dạng âm thanh

- **Phạm vi kiểm thử bắt buộc Giai đoạn 1**: `FLAC`, `MP3`, `WAV`.
- **Hỗ trợ mở rộng theo khả năng giải mã của Chromium** *(chưa tuyên bố hỗ trợ mọi biến thể codec)*: `M4A`, `AAC`, `OGG`, `OPUS`.
  - Ví dụ: file `.m4a` dùng codec AAC thường phát được, nhưng `.m4a` chứa ALAC có thể không giải mã được bởi Chromium `HTMLAudioElement`. Khi gặp trường hợp này, ứng dụng sẽ hiện thông báo lỗi rõ ràng ở thanh phát nhạc và **không bị crash**.
- **Lưu ý kỹ thuật**: Giai đoạn 1 sử dụng `HTMLAudioElement` qua custom protocol `lossless-media://` có hỗ trợ HTTP Range (`206 Partial Content`). Ứng dụng chưa dùng WASAPI Exclusive và **không tuyên bố bit-perfect**.

---

## 6. Hướng dẫn kiểm thử thủ công trên Windows (T01 – T12)

> **Lưu ý trung thực**: Các bài kiểm thử liên quan đến cửa sổ Windows Electron, âm thanh thực tế và file EXE (`T01`, `T05`, `T06`, `T10`, `T11`, `T12`) **chưa thể chạy trực tiếp trong môi trường Linux cloud sandbox** (trạng thái: `NOT RUN`). Hãy thực hiện lần lượt từng mục trên máy Windows của bạn:

| Mã | Kịch bản kiểm thử | Các bước thao tác | Kết quả mong đợi |
| :--- | :--- | :--- | :--- |
| **T01** | Mở ứng dụng desktop | Chạy `npm run dev` (hoặc mở EXE). | Mở cửa sổ Windows riêng "Lossless Player", dark theme, không mở Chrome/Edge. |
| **T02** | Import file FLAC | Nhấn **Import Files** -> chọn 1 hoặc nhiều file `.flac`, `.mp3`, `.wav`. | Bài hát xuất hiện trong bảng kèm Tên bài, Nghệ sĩ, Album, định dạng/thông số thật và thời lượng. File gốc giữ nguyên tại chỗ. |
| **T03** | Import thư mục có thư mục con | Nhấn **Import Folder** -> chọn thư mục nhạc có nhiều thư mục con lồng nhau. | Thanh tiến độ hiển thị khi quét, giao diện không bị đơ; toàn bộ bài hát trong thư mục con được thêm và thư mục xuất hiện ở cột **Thư mục nguồn**. |
| **T04** | Import lại cùng thư mục | Nhấn **Import Folder** chọn lại chính thư mục vừa import ở T03. | Thông báo `Thêm mới 0 · Không đổi N`. Không có bài hát nào bị nhân đôi. |
| **T05** | Phát, pause, resume, seek | Nhấn nút Play trên một bài FLAC -> nhấn Pause -> nhấn Play lại -> kéo thanh tua đến giữa bài. | Âm thanh phát mượt, dừng đúng chỗ, tiếp tục đúng vị trí, tua đến đúng giây đã chọn mà không bị phát lại từ đầu. |
| **T06** | Chuyển bài & chỉnh âm lượng | Nhấn **Bài tiếp theo**, **Bài trước**, kéo thanh âm lượng và bấm nút tắt/bật tiếng. | Chuyển bài chính xác; âm lượng thay đổi ngay theo thanh trượt. |
| **T07** | Đóng mở app giữ thư viện | Đóng hẳn cửa sổ Lossless Player -> mở lại ứng dụng. | Toàn bộ danh sách bài hát và thư mục nguồn tải lại ngay từ `library.db`, không cần import lại. |
| **T08** | File bị xóa hoặc di chuyển | Tạm di chuyển 1 file nhạc sang thư mục khác -> nhấn **Rescan** (hoặc bấm phát bài đó). | Bài hát hiện nhãn **Thiếu file** (màu hổ phách, gạch ngang nhẹ), bản ghi vẫn được giữ trong SQLite; bấm phát hiện thông báo lỗi rõ ràng, không crash. Di chuyển file về chỗ cũ rồi nhấn **Rescan** sẽ khôi phục trạng thái sẵn sàng. |
| **T09** | Đường dẫn tiếng Việt | Import thư mục và file có dấu tiếng Việt + khoảng trắng (vd: `D:\Nhạc Việt\Trịnh Công Sơn\Diễm Xưa.flac`). | Quét, lưu SQLite và phát nhạc bình thường, không lỗi font hoặc lỗi không tìm thấy file. |
| **T10** | Tắt hoàn toàn Internet | Ngắt Wi-Fi / rút dây mạng trên Windows -> mở ứng dụng và phát nhạc. | Ứng dụng mở nhanh, hiển thị thư viện và phát FLAC/MP3/WAV bình thường, không có lỗi mạng. |
| **T11** | Bản EXE chạy không cần Node.js | Chép file `Lossless Player-0.1.0-x64-portable.exe` (hoặc cài bản NSIS) sang máy Windows không cài Node.js và chạy. | Ứng dụng chạy hoàn chỉnh, import và phát nhạc bình thường. |
| **T12** | Thay bản EXE không mất `library.db` | Import nhạc bằng bản EXE cũ -> đóng app -> thay bằng bản EXE mới (hoặc cài đè bản NSIS mới) -> mở lại. | Thư viện trong `%APPDATA%\Lossless Player\library.db` vẫn còn nguyên vẹn đầy đủ bài hát. |

---

## 7. Xử lý sự cố thường gặp trên Windows

1. **Lỗi `The module '...better_sqlite3.node' was compiled against a different Node.js version` (`NODE_MODULE_VERSION`)**:
   - Nguyên nhân: Native addon `better-sqlite3` chưa khớp ABI của phiên bản Electron.
   - Cách xử lý: Chạy `npm run rebuild:electron`, sau đó chạy lại `npm run dev` hoặc `npm run dist`.
2. **Lỗi `electron-builder` tạo symbolic link (`Cannot create symbolic link : A required privilege is not held by the client`)**:
   - Nguyên nhân: Windows chặn tạo symlink khi giải nén winCodeSign cache nếu chưa bật Developer Mode.
   - Cách xử lý: Mở **Settings -> System -> For developers -> bật Developer Mode**, hoặc mở PowerShell bằng **Run as Administrator** rồi chạy lại `npm run dist`.
3. **Không tìm thấy file `library.db` để kiểm tra**:
   - Mở Windows Explorer, dán `%APPDATA%\Lossless Player` vào thanh địa chỉ rồi nhấn Enter. File `library.db` nằm ngay trong thư mục này.
4. **Một file `.m4a` không phát được**:
   - Kiểm tra xem file đó có dùng codec ALAC hay không. Giai đoạn 1 sử dụng `HTMLAudioElement` của Chromium nên ưu tiên `FLAC`, `MP3`, `WAV` (và AAC trong M4A).
