# Third-Party Notices & Licenses — DoReMi Desktop (`1.0.0-rc.2`)

DoReMi (designed & developed by **kamisamao**) sử dụng các thư viện mã nguồn mở sau trong bản phân phối desktop Windows x64 (tất cả đều có giấy phép tương thích phân phối miễn phí/thương mại; **không nhúng** bất kỳ thành phần Codec bị hạn chế phân phối lại nào như `qaac`, `CoreAudioToolbox.dll`, `fhgaacenc`, `enc_fhgaac.dll`, `fdkaac`, `takc.exe`).

## 1. Runtime Application Dependencies
| Package | Version | License | Vai trò trong DoReMi |
|---|---|---|---|
| `electron` | `45.4.1` | MIT (+ Chromium BSD-3-Clause) | Desktop runtime (Node + Chromium) |
| `react` | `19.0.1` (`^19.0.1`) | MIT | Giao diện người dùng |
| `react-dom` | `19.0.1` (`^19.0.1`) | MIT | Renderer DOM |
| `better-sqlite3` | `13.2.0` | MIT (SQLite engine: Public Domain) | Cơ sở dữ liệu thư viện offline (`library.db`) |
| `music-metadata` | `12.8.0` (`^12.8.0`) | MIT | Đọc thẻ tag âm thanh chỉ đọc |
| `@mgz-dev/alac` | `0.1.1` | MIT | Giải mã WASM cho M4A ALAC lossless offline |
| `lucide-react` | `0.546.0` | ISC | Bộ biểu tượng vector UI |
| `@fontsource/poppins` | `5.3.0` | OFL-1.1 | Font chữ offline mặc định |

## 2. Optional External Codecs (Không đóng gói kèm DoReMi)
- DoReMi **không** đóng gói nhị phân của `FFmpeg`, `FLAC`, `WavPack`, `LAME`, `Opus`, `Ogg Vorbis`, `refalac`, hay các DLL độc quyền bên ngoài vào bộ cài (`resources/codecs/` chỉ chứa `manifest.json`).
- Lớp Codec Engine tách biệt hoàn toàn (`Isolated`) khỏi luồng phát nhạc mặc định của ứng dụng.
