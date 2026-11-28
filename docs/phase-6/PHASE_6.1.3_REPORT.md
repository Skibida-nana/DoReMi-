# DoReMi — Báo cáo Triển khai Phase 6.1.3 (`v1.0.0-rc.5`)
**Remote Library State & Search Stabilization**

- **Phiên bản Test Build**: `1.0.0-rc.5` (`release/v1.0.0-rc.5/`, bảo toàn `v1.0.0-rc.1`..`rc.4`)
- **Checkpoint mã nguồn trước khi sửa (RC4)**: [`backups/phase-6.1.2-rc4-checkpoint/`](file:///G:/Source%20code%20DoReMi/backups/phase-6.1.2-rc4-checkpoint/)
- **Dữ liệu người dùng**: Bảo toàn `%APPDATA%\Lossless Player`, `SQLite schema v9`, và thông tin thiết bị đã ghép nối.

---

## 1. Nguyên nhân gốc được xác nhận (`BUG-P613-01`)

- **Không phải lỗi Server API**: `ConnectHostService` (`/api/v1/library/tracks`) lọc và phân trang bình thường khi nhận hoặc bỏ tham số `q`.
- **Nguyên nhân thực tế nằm ở tầng UI/Store Renderer**:
  1. Trong [`App.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/app/App.tsx), khi mở **Đang phát (`Now Playing`)**, nhánh `switch (ui.route)` **unmount `<ServerPage />` hoàn toàn**; khi quay lại, `<ServerPage />` mount mới lại từ đầu.
  2. Trong [`ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx), trước đây `tab`, `remoteViewTab` và `remoteSearchDraft` nằm trong `useState` cục bộ (`tab='overview'`, `remoteSearchDraft=''`), trong khi `ConnectStore` vẫn giữ nguyên `remoteSearchQuery` cũ và `remoteTracks` đã lọc trước đó.
  3. Khi quay lại từ Now Playing: ô input trông **trống rỗng (`""`)** nhưng danh sách bài hát bên dưới vẫn bị kẹt kết quả tìm kiếm cũ; nút `Xóa bộ lọc` trước đó bỏ sót điều kiện `remoteSearchQuery`; thiếu nút `X` trong ô nhập; và nút `Làm mới` (`loadRemoteLibrary()`) tự tái sử dụng `this.state.remoteSearchQuery` cũ -> người dùng buộc phải gõ một từ khóa mới mới thay đổi được danh sách.
  4. Đồng thời `ConnectStore` trước đây thiếu sequence guard chống phản hồi tìm kiếm cũ đến sau (`out-of-order`), thiếu reset `offset` cưỡng bức khi chuyển filter, thiếu cache danh sách mặc định theo `hostId`, thiếu tách biệt `remoteLibraryError` vs kết quả rỗng, và chưa reset tìm kiếm khi đổi Host / ngắt kết nối.

---

## 2. Các tệp mã nguồn & tài liệu đã thay đổi

- **Core State & UI**:
  - [`src/renderer/src/stores/connect-store-core.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store-core.ts) *(mới — tách thuần khỏi DOM `Audio`)*
  - [`src/renderer/src/stores/connect-store.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store.ts) *(adapter runtime + `useConnectState`)*
  - [`src/renderer/src/pages/ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx)
- **Kiểm thử & Tài liệu**:
  - [`tests/phase613-remote-search-state.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase613-remote-search-state.test.ts)
  - [`AGENTS.md`](file:///G:/Source%20code%20DoReMi/AGENTS.md), `.ai-context/*`, `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`, `docs/USER_GUIDE.md`, `qa/DoReMi-QA-{Launch,SmokeTest}.cmd`, [`docs/phase-6/PHASE_6.1.3_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.1.3_WINDOWS_UAT.md)

---

## 3. So sánh Hành vi Tìm kiếm Trước và Sau Khi Sửa

| Kịch bản | Trước (`1.0.0-rc.4`) | Sau (`1.0.0-rc.5`) |
|---|---|---|
| Mở Now Playing rồi quay lại danh sách Remote | Input reset về `""` dù kết quả vẫn đang lọc; tab reset về `overview` | Tab & `remoteSearchInput` giữ đồng nhất 100% với `remoteSearchQuery` & danh sách đang hiển thị |
| Xóa ô tìm kiếm hoặc bấm `X` / `Xóa bộ lọc` | Bấm `Làm mới` giữ query cũ; xóa input `""` không cập nhật danh sách | Tự động khôi phục ngay lập tức danh sách chưa lọc ban đầu; nút `X`, `Xóa bộ lọc`, `Về thư viện đầy đủ` luôn sẵn sàng |
| Tải lặp lại khi thoát tìm kiếm | Phải gõ từ khóa khác hoặc reload | Khôi phục từ `UnfilteredRemoteLibraryCache` theo `hostId` (`0` network fetch thừa) |
| Tìm kiếm liên tiếp / response về lệch thứ tự | Response chậm trước có thể ghi đè response mới hơn | `libraryRequestSeq` + kiểm tra `activeHost.hostId` hủy bỏ triệt để mọi response lỗi thời |
| Phân trang khi đổi từ khóa | Dễ giữ nhầm trạng thái cũ | Bắt buộc `append = false`, `offset = 0` khi `query`, `albumKey`, `artist` hoặc `hostId` đổi |
| Đổi Host hoặc Ngắt kết nối | Có thể sót `remoteSearchQuery` cũ | Reset toàn bộ state tìm kiếm, cache, sequence token khi đổi `hostId` hoặc disconnect |
| Kết quả rỗng vs Lỗi mạng | Hiển thị chung câu không tìm thấy | Tách rõ banner lỗi kết nối (`Thử lại`) với kết quả tìm kiếm rỗng (`Xóa tìm kiếm & hiển thị tất cả`) |
| Phát nhạc & Hàng đợi khi tìm/xóa | Bình thường | Tuyệt đối không ngắt âm thanh hiện tại hay sửa Hàng đợi đang phát |

---

## 4. Quản lý Cache, Phân trang & Tác động Tài nguyên

- **Cache đơn lớp theo `hostId`**: `UnfilteredRemoteLibraryCache` lưu chính trang chưa lọc đã tải lần đầu (kèm `albums`/`artists`, không tải toàn bộ thư viện hay nhân đôi cache bài hát); khi xóa tìm kiếm khôi phục ở **O(1)** (`0` request mạng). Khi người dùng bấm `Làm mới`, `forceRefresh: true` tải lại mới từ Host.
- **Lọc theo Artist/Album**: Không gọi lại `/library/albums` và `/library/artists` nếu danh sách collection hiện tại đã có và từ khóa không đổi (tiết kiệm 2/3 lượng request).
- **Không polling mới, giữ nguyên giới hạn request Phase 6.1.2**, giữ nguyên hành vi tiết kiệm tài nguyên cho laptop dòng U.

---

## 5. Kết quả Kiểm thử Tự động & Build (`v1.0.0-rc.5`)

- **`npm.cmd run docs:sync -- --check`**: **OK** (`docs/USER_GUIDE.md` khớp `v1.0.0-rc.5`).
- **`npm.cmd run codecs:verify`**: **OK** (`manifest.json`).
- **`npm.cmd run lint` (`tsc --noEmit`)**: **PASS (`0` lỗi)**.
- **`npm.cmd run test:electron`** (**45 tệp**, đầy đủ `FFMPEG_PATH` + `DOREMI_REAL_FFMPEG_DIR` + `DOREMI_REAL_CODECS_DIR`):
  - **`207 tests: 207 PASS, 0 FAIL, 0 SKIP`** (`19,205.30 ms`).
  - Trong đó [`tests/phase613-remote-search-state.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase613-remote-search-state.test.ts) xác minh toàn bộ **16 kịch bản** + kết nối loopback `ConnectHostService -> ConnectClientService -> ConnectStore`.
  - [`tests/phase612-remote-playback-e2e.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase612-remote-playback-e2e.test.ts) xác nhận **9/9 kịch bản Chromium `<audio>` + Web Audio `AudioContext` E2E** và **SHA-256 ALAC PCM bit-exact parity** tiếp tục **PASS**.
- **Production Build & Packaging (`release/v1.0.0-rc.5/`)**:
  - Main: `out/main/index.js` `535.89 kB` (+ lazy `codec-manager` `122.05 kB`) · Preload: `16.65 kB` · Main renderer: `677.38 kB` · Lazy `ServerPage`: `110.76 kB`.
  - Đóng gói thành công `DoReMi-1.0.0-rc.5-x64-setup.exe`, `DoReMi-1.0.0-rc.5-x64-portable.exe`, `DoReMi-1.0.0-rc.5-x64-portable.zip`, `win-unpacked/DoReMi.exe` và [`SHA256SUMS.txt`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.5/SHA256SUMS.txt).
  - **Smoke Test**: `smoke:electron` Dev (`packaged=false`) và Packaged (`release\v1.0.0-rc.5\win-unpacked\DoReMi.exe`, `packaged=true`) đều **`OK (electron=45.4.1, rootChildren=2, diagLogs=1)`**.

---

## 6. Backlog UI Trì hoãn (Chưa triển khai ở Phase 6.1.3)

Đã ghi nhận vào [`AGENTS.md`](file:///G:/Source%20code%20DoReMi/AGENTS.md), [`.ai-context/KNOWN_ISSUES.md`](file:///G:/Source%20code%20DoReMi/.ai-context/KNOWN_ISSUES.md), [`.ai-context/FEATURE_STATUS.md`](file:///G:/Source%20code%20DoReMi/.ai-context/FEATURE_STATUS.md), và [`.ai-context/NEXT_TASK.md`](file:///G:/Source%20code%20DoReMi/.ai-context/NEXT_TASK.md):
- **`UI-BACKLOG-01`**: Chuyển động quay đĩa than trong `NowPlayingPage` / Focus Vinyl khi đang phát nhạc Remote Playback.
- **`UI-BACKLOG-02`**: Tích hợp duyệt Remote Music Library vào giao diện Thư viện chính theo bộ lọc thống nhất (**All Sources / Local Sources / Remote Server Sources**, không sao chép file remote vào SQLite cục bộ).

---

## 7. Hạn chế còn lại & Mức độ Sẵn sàng Phase 6.2

- **Chưa chạy UAT thực tế trên bản `1.0.0-rc.5`**: Kiểm thử tìm kiếm/quay lại thực tế trên cặp Host PC + Windows Laptop Client và kiểm thử thêm 1 bài ALAC M4A khác đang ở trạng thái **PENDING USER UAT** theo [`PHASE_6.1.3_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.1.3_WINDOWS_UAT.md).
- **Sẵn sàng Phase 6.2**: Kiến trúc Host/Client + Search State ổn định, nhưng **không tự động chuyển sang Phase 6.2** — chờ hoàn thành Manual UAT `v1.0.0-rc.5` và pha UI Fix (hoặc lệnh mới của người dùng).
