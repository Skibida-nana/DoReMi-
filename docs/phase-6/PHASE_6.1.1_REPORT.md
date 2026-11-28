# Báo cáo Kỹ thuật Phase 6.1.1 — DoReMi Windows `v1.0.0-rc.3`

**Trạng thái**: `RELEASE CANDIDATE - PENDING UAT`  
**Phiên bản**: `1.0.0-rc.3` (`appId: com.losslessplayer.desktop`, `userData: %APPDATA%\Lossless Player`, SQLite schema `v9`)  
**Cơ sở nguồn**: Xây dựng trực tiếp trên source code **Phase 6.1** (bảo toàn 100% DoReMi Connect; checkpoint lưu tại `backups/phase-6.1-checkpoint/` và `release/phase-6.1-win-unpacked/`).

---

## 1. Tóm tắt hạng mục đã triển khai

| Mã hạng mục | Mô tả | File thay đổi chính | Kết quả kiểm chứng |
|---|---|---|---|
| **BUG-01** | Sửa cắt chữ/dấu thanh tiếng Việt ở tiêu đề dài (`LẦN CUỐI (đi bên em xót xa người ơi)`) | `src/renderer/src/utils/title-typography.ts`, `NowPlayingPage.tsx`, `MiniPlayer.tsx` | Responsive scaling, `lineHeight >= 1.2`, 3 dòng tối đa, buffer padding `pt-[0.06em] pb-[0.14em]`, `ResizeObserver` cập nhật Group B/C |
| **BUG-02** | Sửa sai thứ tự bài hát Album (Local Detail, Play Album, Library cache & Remote Album API) | `src/shared/utils/album-sort.ts`, `folder-tree.ts`, `AlbumDetailPage.tsx`, `ui-store.ts`, `host-service.ts`, `prototype-catalog.ts` | Chuẩn hóa `disc -> track (1, 2, ..., 10) -> filename -> title -> id`; bỏ gán `index + 1` giả |
| **IMP-03** | Album-aware Smart Shuffle chống dồn album về cuối & hạn chế trùng album liên tiếp | `src/shared/utils/smart-shuffle.ts`, `playback-queue.ts`, `ui-store.ts` | 100-run benchmark: `18.6 -> 0.0` cặp trùng album; 50k tracks: `233.71 ms` |
| **IMP-04** | Tự động phát tiếp khi hết danh sách (`autoContinueEnabled`, mặc định Bật) | `stage5.ts`, `profile-service.ts`, `audio-engine.ts`, `player-store.ts`, `SettingsPage.tsx`, `ui-store.ts` | Bảo toàn cài đặt qua SQLite; tôn trọng Repeat, Auto Next OFF, Sleep Timer, Stop & tách biệt Remote |
| **IMP-05** | Sidebar ẩn tức thì `0ms` khi vào Đang phát / Focus Player + chống nháy chuột từ Sidebar | `animation-policy.ts`, `Sidebar.tsx`, `ui-store.ts` | Loại bỏ timer 3s khởi đầu; edge hotspot `10px`; overlay không dịch chuyển bố cục |
| **IMP-06** | Nút `"Phát ngẫu nhiên"` cạnh `+ Tạo playlist` trên Library Toolbar | `LibraryPage.tsx`, `ui-store.ts` | Chọn bài hợp lệ cục bộ, né bài vừa nghe & kích hoạt Smart Shuffle |
| **AUDIT-01** | Kiểm toán `ISS-P61-REMOTE-ALAC` | `alac-decoder.ts` (`openTrack(bytes)`) | Xác nhận WASM yêu cầu full-file RAM buffering; giữ Known Issue trung thực & thiết kế hướng giải quyết Phase 6.2/6.3 |

---

## 2. Kết quả Benchmark & Kiểm thử (Thực tế sau chỉnh sửa cuối)

- **Automated Tests (`npm.cmd run test:electron`, 43 tệp test)**: **`201 / 201 PASS`, `0 FAIL`, `0 SKIP`** (`5,936.6027 ms`).
- **TypeScript (`lint`)**: **`0` lỗi**.
- **Codecs & User Guide Sync (`codecs:verify`, `docs:sync -- --check`)**: **`PASS`** (`15` chương khớp `v1.0.0-rc.3`).
- **Benchmark Smart Shuffle & Sort (`qa/logs/phase611-benchmark-latest.json`)**:
  - **100 lần chạy trên 500 bài / 25 album**:
    - Fisher-Yates cũ: trung bình **`18.6`** cặp bài cùng album đứng cạnh nhau, chuỗi trùng dài nhất **`2.57`**, cặp trùng ở 20% cuối **`3.73`**.
    - Smart Shuffle mới: trung bình **`0.0`** cặp trùng album, chuỗi trùng dài nhất **`1`**, cặp trùng ở 20% cuối **`0.0`**, tỷ lệ đa dạng album cuối danh sách **`1.0`**.
  - **Quy mô lớn (`50,000` bài / `2,500` album)**: Smart Shuffle hoàn tất trong **`233.71 ms`** (`+10.4 MB` heap delta); `5,000` bài trong **`23.3 ms`**; sắp xếp Album `10,000` bài trong **`0.64 ms`**.
- **Đóng gói (`release/v1.0.0-rc.3/`) & Smoke Test**:
  - `DoReMi-1.0.0-rc.3-x64-portable.exe` (`121,915,262 bytes`)
  - `DoReMi-1.0.0-rc.3-x64-portable.zip` (`169,606,770 bytes`)
  - `DoReMi-1.0.0-rc.3-x64-setup.exe` (`134,233,966 bytes`)
  - `win-unpacked/DoReMi.exe` + `SHA256SUMS.txt`
  - Smoke Test: Dev **`PASS`** (`packaged=false`) & Packaged **`PASS`** (`packaged=true`, `rootChildren=2, diagLogs=1`).
  - `npm audit --omit=dev --json`: **`0` lỗ hổng** trên `23` prod dependencies.
- **Chưa chạy (`NOT RUN` — chờ User UAT)**: Kiểm thử LAN vật lý trên 2 máy thật, kiểm thử hiệu năng thực tế trên máy tham chiếu `i5-5200U / 8GB RAM`, và soak test phát nhạc liên tục nhiều giờ.
