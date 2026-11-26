# DOREMI — PHASE 5.2G: WINDOWS BUILD & PACKAGING REPORT

**Trạng thái bản dựng**: `PASS` (`electron-builder` exit code `0`, `packaged=true` smoke test PASS)  
**Thư mục đầu ra tách biệt**: `G:\Source code DoReMi\release\v1.0.0-rc.1\`  
**Bảo toàn Phase 5.1**: Bản `G:\Source code DoReMi\release\DoReMi-0.1.0-x64-portable.exe` (`121,831,133` bytes) được giữ nguyên 100%, không bị ghi đè.

---

## 1. Sản phẩm đóng gói (`release/v1.0.0-rc.1/`)

| Artifact | Kích thước (bytes) | SHA-256 (`SHA256SUMS.txt`) | Mục đích |
|---|---:|---|---|
| `DoReMi-1.0.0-rc.1-x64-portable.exe` | `121,860,682` | `f5ca01f4ef4e955ac2d6fe74db1d81238ac3d07528abfb68a8dc0566710402da` | File Portable độc lập 1-click |
| `DoReMi-1.0.0-rc.1-x64-portable.zip` | `169,496,910` | `cf5e5630645682d65e4a02de19c4bea9976503a964c637e6d5e66c26b2785ce9` | Bản giải nén trực tiếp |
| `DoReMi-1.0.0-rc.1-x64-setup.exe` | `134,149,549` | `9b7eacce20e1aec91d77925ed5a481767034738b69dd446cd542f5c750142e46` | Bộ cài Windows NSIS (`deleteAppDataOnUninstall: false`) |
| `DoReMi-1.0.0-rc.1-x64-setup.exe.blockmap` | `141,002` | `8eabf87d6402e9d5e3fc8a2f9faf079eb5af9e356833e95e94bd2c4b94ec04fb` | Blockmap NSIS |
| `win-unpacked/DoReMi.exe` | — | — | Thư mục unpacked chạy trực tiếp / QA Smoke |
| `SHA256SUMS.txt` | `994` | — | Bảng kiểm băm SHA-256 toàn bộ artifacts |

## 2. Xác minh đóng gói (Quality Gate D)

- `asar: true` + `asarUnpack: ["node_modules/better-sqlite3/**"]`, `extraResources: resources/codecs -> codecs` (chỉ có `manifest.json`, `0` binary bị cấm phân phối lại).
- `npm run smoke:electron`: **`[smoke-electron] OK (packaged=false, electron=45.4.1, rootChildren=2, diagLogs=1)`**
- `npm run smoke:electron -- --exe release\v1.0.0-rc.1\win-unpacked\DoReMi.exe`: **`[smoke-electron] OK (packaged=true, electron=45.4.1, rootChildren=2, diagLogs=1)`**
- Xác nhận native dependency `better-sqlite3@13.2.0` khớp ABI Electron `45.4.1` (`win32 x64`) và khởi động đọc ghi SQLite trong môi trường `packaged=true` thành công.
