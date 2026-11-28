# BÁO CÁO TRIỂN KHAI TỔNG KẾT — DOREMI PHASE 6.5 (`v1.0.0-rc.9`)
## Quản lý Tài nguyên, Quản lý Nguồn điện Windows, Tối ưu Runtime Thích ứng & Độ ổn định Máy chủ Chạy dài

---

## 1. Tóm tắt điều hành (Executive Summary)
Phase 6.5 biến **DoReMi Personal Hybrid Server** thành một máy chủ nhạc cá nhân gọn nhẹ, nhận thức trạng thái nguồn điện Windows và vận hành bền bỉ dài hạn mà không đánh đổi chất lượng âm thanh gốc hay hàng rào bảo mật Zero-Trust của Phase 6.1–6.4:
- **Tối ưu hóa tài nguyên thực tế (đo đối chứng trên 25 kịch bản tiêu chuẩn)**: Giảm **64,8%** kết nối TCP/TLS LAN mới (`108 -> 38`), giảm **81,5%** bắt tay TLS Remote HTTPS (`108 -> 20`), giảm **93,9%** lượt ghi SQLite lặp lại (`165 -> 10`), loại bỏ ghim bộ nhớ tuyến tính WASM ALAC, giảm RSS sau dọn dẹp (`117,38 MB -> 108,88 MB`, `arrayBuffersMb = 0,00 MB`) và vượt qua bài ngâm liên tục `118,93 giây` (kèm giữ luồng tạm dừng mở suốt `31,5 giây`) với `rssEnd = 94,64 MB`, `errorCount = 0`.
- **Quản lý nguồn điện Windows tường minh (`HostPowerManager`)**: Triển khai 3 chính sách lưu bền vững (`Theo hệ thống` mặc định, `Giữ thức khi đang phát từ xa` kèm `45s` đệm chuyển bài + nhả tức thì khi thu hồi thiết bị, `Giữ thức khi bật Host`) sử dụng `powerSaveBlocker.start('prevent-app-suspension')` (vẫn cho phép màn hình tắt tự nhiên), kết hợp đối soát `suspend`/`resume` theo nguyên tắc **Fail-Closed** và nhận biết nguồn pin.
- **Sẵn sàng cho Đợt Rà soát Hợp nhất Phase 6.3–6.5**: Thiết lập `HostResourceSampler` (`0` timer nền khi không gọi) làm hợp đồng backend cho Phase 7.4, hoàn tất sổ đăng ký ổn định hợp nhất `PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`, bảo toàn 100% dữ liệu người dùng (`SQLite v10`), 5 hạng mục UI Phase 7 (`UI-BACKLOG-01..05`) và đóng gói đầy đủ bộ cài `v1.0.0-rc.9`.

## 2. Phiên bản Baseline Thực tế (Actual Baseline Version)
- Không gian làm việc xác thực: `G:\Source code DoReMi`
- Phiên bản xuất phát thực tế: **`DoReMi v1.0.0-rc.8`** (`SQLite schema v10`, Electron `45.4.1`, Node `v24.22.3`, `53` production dependencies).
- Phiên bản phát hành sau Phase 6.5: **`DoReMi v1.0.0-rc.9`** trên nhánh Git độc lập `feature/phase-6.5-resource-power-management`.

## 3. Trạng thái Tích hợp Phase 6.4 Thực tế (Actual Phase 6.4 Integration Status)
- Đã kiểm tra trực tiếp mã nguồn và xác nhận toàn bộ Phase 6.4 đang hoạt động đầy đủ: `SmartConnectionManager` (19 trạng thái, 3 chế độ `automatic` / `lan-only` / `remote-only`), `NetworkChangeMonitor` (`0` timer khi nghỉ), quét lại IP LAN qua mDNS có xác minh SPKI chống giả mạo, bàn giao hai chiều `Make-Before-Break` (`Remote -> LAN`, thoát êm `600 ms`) và `Break-Before-Make` (`LAN -> Remote`) kèm đối chiếu `X-DoReMi-Source-Revision`.

## 4. Vị trí & Xác minh Điểm Khôi phục (Checkpoint Location and Verification)
- Đã tạo bản sao lưu mã nguồn đầy đủ **trước khi sửa bất kỳ tệp nào** tại [`backups/phase-6.4-pre-phase65-checkpoint/`](file:///G:/Source%20code%20DoReMi/backups/phase-6.4-pre-phase65-checkpoint/) gồm **`352` tệp** (`src/`, `scripts/`, `tests/`, `docs/`, `.ai-context/`, `package.json`, `package-lock.json`, cấu hình build), đã đối chiếu khớp 100% mã băm SHA-256 trên các tệp cốt lõi (`package.json`, `host-service.ts`, `connect-client.ts`, `smart-connection-manager.ts`).

## 5. Kiểm toán Tài nguyên Baseline Trước Tối ưu (Baseline Resource Audit)
- Thực hiện đo thực tế trên mã gốc `v1.0.0-rc.8` qua công cụ [`scripts/benchmark-phase65.ts`](file:///G:/Source%20code%20DoReMi/scripts/benchmark-phase65.ts) (`--phase before`), lưu kết quả gốc tại [`qa/logs/phase65-benchmark-before.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-benchmark-before.json):
  - Local Player nghỉ (`#01`): `0,00%` CPU, `93,23 MB` RSS.
  - Tổng tích lũy qua 25 kịch bản trước tối ưu: `lanTcpConnections = 108`, `remoteTlsHandshakes = 108`, `sqliteDeviceTouches = 165`, `tailscaleCliSpawns = 62`, `finalPostShutdownRssMb = 117,38 MB`.

## 6. Các Điểm Nghẽn Tài nguyên Đã Xác định (Identified Resource Bottlenecks)
1. **Không tái sử dụng kết nối TLS trên luồng dữ liệu xác thực**: `connect-client.ts` đặt `agent: false` trên mọi yêu cầu API và `HTTP 206 Range`, gây bắt tay TCP + TLS lặp lại trên từng mảnh âm thanh/ảnh bìa và phân mảnh bộ nhớ OpenSSL native.
2. **Ghi SQLite đồng bộ trên từng yêu cầu HTTP**: `authenticateBearerToken` gọi `touchDeviceActivity()` trực tiếp vào `library.db` mỗi lần Client đọc một mảnh `HTTP 206` (`165` lượt ghi trong 25 kịch bản ngắn).
3. **View `Buffer` chia sẻ giữ bộ nhớ tuyến tính WASM ALAC**: `Buffer.from(decodedChunks[0].buffer, byteOffset, byteLength)` trong `remote-alac-decoder.ts` giữ tham chiếu tới `ArrayBuffer` lớn của WebAssembly và chưa có bộ quét thu hồi khi dừng nghe mà không mở bài mới.
4. **Truy vấn lặp trạng thái Tailscale CLI & cấu hình Host**: Bốn lần kiểm tra trạng thái liên tiếp gọi `12` tiến trình con `tailscale.exe`; `Host OFF` vẫn đọc lại SQLite khi UI hỏi trạng thái; ảnh bìa/lời bài hát trùng lặp chưa gộp yêu cầu đang bay (`inflight deduplication`).

## 7. Các Tối ưu hóa Tài nguyên Đã Triển khai (Implemented Resource Optimizations)
- Bổ sung pool kết nối Keep-Alive cách ly chặt (`getOrCreateScopedHttpsAgent` / `destroyScopedAgents`) trong [`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts).
- Bổ sung `touchDeviceActivityThrottled` (`30s`) + `flushPendingDeviceActivity` + `deviceAuthCache` (`10s`) trong [`device-auth-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/device-auth-service.ts) và bỏ qua ghi cấu hình không đổi trong [`connect-repository.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-repository.ts).
- Sao chép độc lập cửa sổ PCM ALAC (`Buffer.from(decodedChunks[0])`) + trần `6 MB` + tự dọn `20s`/`60s` trong [`remote-alac-decoder.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/remote-alac-decoder.ts).
- Bổ sung `libraryViewCache` lười theo `getLibraryStateToken()`, `inflightArtwork`, `lyricsCache` kèm `mtimeMs` sidecar, và giải phóng khóa riêng khi `STOPPED` trong [`host-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-service.ts) & [`host-identity-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-identity-service.ts).
- Gộp yêu cầu đang bay + cache `5s` cho trạng thái `ready` trong [`tailscale-funnel-provider.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/tailscale-funnel-provider.ts).
- Khóa `sourceRevision` + trần `8 MB` trong [`flac-stream-sanitizer.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/flac-stream-sanitizer.ts), tái sử dụng bằng chứng mạng tươi `< 2s` trong [`smart-connection-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/smart-connection-manager.ts), và tạm dừng bộ đếm giao diện khi cửa sổ ẩn trong [`ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx).

## 8. Hành vi Khi Tắt Máy chủ (`Host OFF` Behavior)
- Ở trạng thái `STOPPED`: `0` cổng LAN HTTPS, `0` cổng loopback `RemoteGatewayService`, `0` mDNS socket, `0` phiên stream, `0` mục trong `libraryViewCache`/`artworkCache`/`lyricsCache`/`deviceAuthCache`, `0` khóa chống ngủ (`blockerActive = false`), khóa riêng ECDSA được xóa khỏi RAM (`releasePrivateKeyFromMemory()`), và kiểm tra trạng thái lặp lại tiêu tốn **`0,00%` CPU** (giảm từ `5,51%` 1-core trước tối ưu).

## 9. Hành vi Khi Máy chủ Chờ (`Host STANDBY` Behavior)
- Khi bật Host nhưng chưa có Client phát nhạc (`STANDBY`): không dựng sẵn `libraryViewCache` cho tới khi có yêu cầu duyệt thư viện đầu tiên; bộ hẹn giờ quét luồng treo tự tắt hoàn toàn khi `activeStreams === 0`; mức chiếm dụng CPU trung bình ở trạng thái chờ đạt `0,00%–0,13%` chuẩn hóa (`0,01%–0,03%` trong bài chạy ngâm).

## 10. Quản lý Tài nguyên Thiết bị Đang Hoạt động (Active Client Resource Management)
- Giữ vững giới hạn tối đa `maxActiveClients = 3` thiết bị phát đồng thời trên toàn Host; tách làn `'artwork'` khỏi làn `'default'` để tải ảnh bìa không bao giờ làm nghẽn luồng âm thanh; mỗi thiết bị giới hạn tối đa `4` luồng đồng thời (tự hủy luồng cũ nhất khi tua nhanh liên tiếp) và tách riêng bộ đếm băng thông LAN vs Remote HTTPS.

## 11. Dọn dẹp Vòng đời Luồng Truyền phát (Stream Lifecycle Cleanup)
- Mọi luồng trong [`audio-streaming-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/audio-streaming-service.ts) chạy qua `pipeline(readStream, meter, res)` với khối `64 KB` tôn trọng TCP backpressure và gắn hàm `cleanup()` hủy đồng thời `readStream`, `meter`, `FileHandle` và slot `ResourceBudgetManager` trên mọi sự kiện kết thúc bình thường, Client hủy giữa chừng, thu hồi quyền hoặc dừng Host.

## 12. Dọn dẹp Socket HTTP/HTTPS (HTTP Socket Cleanup)
- `ScopedHttpsAgentPool` giới hạn `maxSockets = 6`, `maxFreeSockets = 2`, `keepAliveMsecs = 15_000` cho mỗi khóa `(hostId, transport, SPKI/origin, generation)`, kiểm tra lại SPKI SHA-256 trên cả socket mới và socket tái sử dụng, giữ `agent: false` cho `probeHost`/`enrollWithHost`, và gọi `destroyScopedAgents()` đóng sạch `100%` socket khi ngắt kết nối, đổi Host, thu hồi quyền hoặc `suspend`.

## 13. Dọn dẹp File Handle Hệ điều hành (File Handle Cleanup)
- Đã kiểm chứng bằng `GuardedFsOps` gắn bộ đếm thực trong `tests/phase65-resource-lifecycle.test.ts` và toàn bộ 25 kịch bản benchmark: `openFileHandlesDelta === 0` sau khi đọc hết bài, trả `HEAD`, trả `416 Range Not Satisfiable`, Client hủy `AbortController` giữa luồng `2,5 MB` và khi quét thu hồi luồng bị bỏ rơi.

## 14. Quản lý Bộ nhớ Giải mã ALAC WASM (ALAC WASM Memory Management)
- Trong [`remote-alac-decoder.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/remote-alac-decoder.ts), cửa sổ PCM giải mã được sao chép sang `Buffer` độc lập trước khi `closeTrack(track)` giải phóng bộ nhớ tuyến tính `@mgz-dev/alac`, áp trần cứng `<= 3` chỉ mục `moov` và `<= 6 MB` tổng cửa sổ PCM, tự dọn cửa sổ sau `20s` nghỉ / chỉ mục sau `60s` nghỉ bằng timer `unref()` tự hủy khi rỗng, đồng thời khớp 100% SHA-256 PCM trên cả `16-bit/44.1kHz`, `24-bit/96kHz` và tệp `moov` nằm cuối file (`EOF moov`).

## 15. Xử lý Tài nguyên FLAC (FLAC Resource Handling)
- Luồng FLAC sạch truyền trực tiếp từng khối `64 KB` nguyên bản; các tệp FLAC có prepended `ID3v2` hoặc khối `PICTURE` lỗi được ánh xạ header ảo qua `FlacByteSource` mà không sửa tệp gốc, giới hạn bộ đệm kế hoạch `<= 64` mục / `<= 8 MB`, gắn khóa `X-DoReMi-Source-Revision` để tự động xóa kế hoạch cũ ngay khi tệp nguồn trên Host thay đổi.

## 16. Chính sách Bộ đệm Toàn Hệ thống (Cache Policies)
- Toàn bộ 10 bộ đệm trong hệ thống đều có trần mục/dung lượng và điều kiện xóa tường minh (chi tiết tại bảng kiểm kê trong [`PHASE_6.5_RESOURCE_ARCHITECTURE.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_RESOURCE_ARCHITECTURE.md)), tuyệt đối không có `Map`/mảng phình vô hạn theo thời gian chạy.

## 17. Chi phí Hoạt động `SmartConnectionManager` (Smart Connection Manager Overhead)
- `NetworkChangeMonitor` giữ nguyên `0` timer khi nghe nhạc cục bộ offline; khi đang kết nối chỉ kiểm tra giao diện mạng cục bộ nhẹ mỗi `4s` (`0` ping Internet, `0` DNS bên thứ ba, `0` quét Wi-Fi SSID/GPS), tái sử dụng bằng chứng đường truyền vừa xác minh `< 2s` để tránh probe trùng lặp, và tạm dừng sạch toàn bộ timer khi Windows `suspend`.

## 18. Phạm vi Tài nguyên Tailscale (Tailscale Resource Usage)
- DoReMi chỉ gọi `tailscale.exe` qua `SafeTailscaleCliExecutor` (`shell: false`) khi người dùng kiểm tra hoặc bật/tắt Remote Access, gộp các lần kiểm tra đồng thời (`12 -> 3` lệnh con) và chỉ cache trạng thái `ready` trong `5s` (không cache trạng thái lỗi để người dùng vừa bật Tailscale được nhận diện ngay). Trên máy đo, 3 tiến trình hệ điều hành của riêng Tailscale (`tailscaled` x2 + `tailscale-ipn`) chiếm `148,18–219,73 MB` Working Set và được báo cáo **tách biệt hoàn toàn** khỏi bộ nhớ của DoReMi.

## 19. Tối ưu Cơ sở Dữ liệu SQLite (Database Optimization)
- Giữ nguyên **SQLite WAL + `foreign_keys = ON` ở schema `v10`**; gom nhịp ghi `touchDeviceActivity` tối đa `1 lần / 30 giây / thiết bị` (ghi ngay nếu đổi IP và tự `flush` khi dừng/ngắt/suspend), bỏ qua `UPDATE` cấu hình không đổi, và đối soát `libraryViewCache` bằng truy vấn nhẹ `getLibraryStateToken()` thay vì quét dựng lại toàn bộ bảng `tracks` trên mỗi yêu cầu.

## 20. Kiến trúc Quản lý Nguồn điện (Power Management Architecture)
- Đóng gói độc lập trong [`src/main/services/connect/host-power-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-power-manager.ts) thông qua giao diện `PowerPlatformAdapter` (kết nối `powerSaveBlocker` và `powerMonitor` của Electron trong tiến trình Main), không chạm Registry hay Windows Power Plan hệ thống.

## 21. Ba Chính sách Nguồn điện Tường minh (Three Power Policies)
1. **`follow-system` (`Theo hệ thống` — Mặc định)**: Không bao giờ chặn Windows Sleep.
2. **`keep-awake-streaming` (`Giữ thức khi đang phát từ xa`)**: Chỉ giữ thức khi Host đang bật **và** có thiết bị được cấp quyền đang truyền âm thanh thực tế, cộng `45 giây` đệm chuyển bài; tự nhả ngay tức thì (bỏ qua `45s`) nếu thiết bị bị thu hồi quyền hoặc tắt Host.
3. **`keep-awake-host-on` (`Giữ thức khi bật Host`)**: Giữ thức suốt thời gian bật Host để sẵn sàng truy cập từ xa; tự nhả ngay khi tắt Host hoặc thoát ứng dụng.

## 22. Hành vi Chống ngủ & Độc lập Màn hình (Sleep Prevention Behavior)
- Chỉ sử dụng chế độ `powerSaveBlocker.start('prevent-app-suspension')` (tuyệt đối không dùng `prevent-display-sleep`), cho phép màn hình máy tính tắt bình thường theo cài đặt Windows để tiết kiệm điện và bảo vệ tấm nền. Đã kiểm chứng trên tiến trình Electron `45.4.1` thực tế (`qa/logs/phase65-windows-power-verification.json`: `isStartedWhileActive = true`, `isStoppedAfterRelease = true`, `displaySleepAllowedNormally = true`).

## 23. Hành vi Hệ thống Ngủ & Thức dậy (Suspend and Resume Behavior)
- Khi `suspend`: Host đẩy dữ liệu hoạt động chờ ghi xuống SQLite và dừng timer quét; Client tạm dừng `SmartConnectionManager` và hủy toàn bộ socket Keep-Alive cũ.
- Khi `resume`: Host kiểm tra lại cổng LAN, làm mới quảng bá mDNS và xác minh lại tuyến Remote HTTPS theo nguyên tắc **Fail-Closed** (nếu cổng Gateway hoặc tuyến Funnel không còn hợp lệ sẽ đóng kết nối từ xa và báo trạng thái rõ ràng, **không bao giờ tự ý mở lại tuyến công cộng ngầm**); Client tự kiểm tra nối lại mà không tự phát nhạc nếu đang ở trạng thái **Pause**.

## 24. Đánh giá Khả thi Wake-on-LAN (Wake-on-LAN Feasibility Assessment)
- **Trong cùng mạng nội bộ (LAN Ethernet)**: Khả thi có điều kiện (cần cấu hình BIOS/NIC Ethernet; Wi-Fi laptop không tin cậy) -> có thể cân nhắc làm tiện ích tùy chọn chỉ-trong-LAN ở giai đoạn sau.
- **Qua Internet công cộng / Tailscale Funnel**: **Không khả thi về kỹ thuật và bị từ chối kiến trúc** (khi máy ngủ/tắt, `tailscaled` và DoReMi đã dừng, Funnel chỉ chuyển tiếp HTTPS lớp 7 và không thể gửi UDP Magic Packet lớp 2 an toàn từ Internet). Giải pháp chuẩn cho người dùng cá nhân là chọn `Giữ thức khi bật Host` hoặc `Giữ thức khi đang phát từ xa` khi để máy ở nhà.

## 25. Hạ tầng Đo lường Tài nguyên cho Phase 7.4 (Resource Measurement Infrastructure)
- Đã triển khai [`src/main/services/connect/resource-sampler.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/resource-sampler.ts) và kênh IPC `connect:host-get-resource-breakdown` trả về `ScopedHostResourceBreakdown` với **`0` bộ đếm thời gian nền** khi không được gọi, sẵn sàng để Phase 7.4 (`UI-BACKLOG-03`) gắn giao diện đồng hồ đo mà không phải sửa lại tầng Server.

## 26. Số đo CPU Trước và Sau Tối ưu (Before and After CPU Measurements)
- `Host OFF` (`#04`): `0,28%` chuẩn hóa (`5,51%` 1-core) -> **`0,00%`** (`0,00%` 1-core).
- `Host ON + kiểm tra Tailscale x4` (`#07`): `0,09%` (`1,86%` 1-core) -> **`0,00%`**.
- `1 Client LAN FLAC` (`#10`): `0,18%` (`3,63%` 1-core) -> **`0,06%`** (`1,28%` 1-core, **giảm 64,7%**).
- `1 Client Hi-Res 24/96` (`#13`): `0,37%` (`7,39%` 1-core) -> **`0,06%`** (`1,28%` 1-core, **giảm 82,7%**).
- `3 Client hỗn hợp LAN + Remote` (`#15`): `0,66%` (`13,10%` 1-core) -> **`0,19%`** (`3,70%` 1-core, **giảm 71,8%**).
- `Host phát cục bộ + phục vụ Client Remote` (`#16`): `0,50%` (`9,99%` 1-core) -> **`0,17%`** (`3,39%` 1-core, **giảm 66,1%**).
- `Thu nhỏ cửa sổ khi phục vụ LAN` (`#22`): `0,49%` (`9,88%` 1-core) -> **`0,25%`** (`4,92%` 1-core, **giảm 50,2%**).

## 27. Số đo RAM Trước và Sau Tối ưu & Giải trình ~213 MB RC.7 (Before and After RAM Measurements)
- `Local Player nghỉ` (`#01`): `93,23 MB` -> **`83,87 MB`**.
- `1 Client LAN FLAC` (`#10`): `111,99 MB` -> **`99,88 MB`**.
- `1 Client Remote FLAC` (`#11`): `115,68 MB` -> **`102,70 MB`**.
- `1 Client Remote ALAC WASM` (`#12`): `125,06 MB` -> **`113,43 MB`**.
- `Bàn giao mạng tự động x4` (`#20`): `124,23 MB` -> **`104,98 MB`**.
- `RSS sau khi đóng cuối 25 kịch bản`: `117,38 MB` -> **`108,88 MB`** (`arrayBuffersMb = 0,00 MB`).
- Hiện tượng ~`213 MB` trong bài đo cũ RC.7 được chứng minh do bài đo cũ đọc nguyên 3 tệp `8 MB` bằng `resp.arrayBuffer()` đồng thời trong cùng 1 tiến trình cộng bắt tay TLS không pool (`agent: false`) và view WASM ALAC chia sẻ — không phải rò rỉ vô hạn, và đã được xử lý triệt để.

## 28. Số đo Yêu cầu Mạng & Bắt tay Giao thức (Network Request Measurements)
- Tích lũy 25 kịch bản (`120` yêu cầu HTTP phục vụ):
  - Kết nối TCP/TLS LAN mới: `108` -> **`38`** (**giảm 64,8%**; riêng trong lúc phát bài `#10`, `#14`, `#15`, `#22` giảm xuống **`0`** kết nối mới nhờ tái sử dụng Keep-Alive).
  - Bắt tay TLS Remote HTTPS mới: `108` -> **`20`** (**giảm 81,5%**; riêng kịch bản tua liên tiếp 24 lần `#17` giảm từ `17` xuống **`0`**, tăng tốc hoàn thành từ `70,37 ms` xuống **`37,12 ms`**).

## 29. Bằng chứng Dọn dẹp Tài nguyên (Resource Cleanup Evidence)
- Kiểm chứng tự động xác nhận sau `disconnect()` và `host.stop()`: `agentCount = 0`, `activeSockets = 0`, `freeSockets = 0`, `activeSessions = 0`, `openFileHandlesDelta = 0`, `metadataCacheEntries = 0`, `artworkCacheEntries = 0`, `lyricsCacheEntries = 0`, `flacSanitizerCache.entries = 0`, `blockerActive = false`, `routeTarget = ""`, `finalPostShutdownArrayBuffersMb = 0`.

## 30. Kết quả Kiểm thử Ổn định Chạy dài Nhịp độ Thực (Sustained Stability / 30-Minute Test Status)
- Đã chạy kiểm thử ổn định nhịp độ thực đa giai đoạn [`scripts/soak-phase65.ts`](file:///G:/Source%20code%20DoReMi/scripts/soak-phase65.ts) (`118,93 giây`, lưu tại [`qa/logs/phase65-sustained-stability.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-sustained-stability.json)) đi qua đủ 5 tải `A..E` kèm giữ luồng **tạm dừng mở suốt `31,5 giây`** rồi phát tiếp: truyền `16.711.816 bytes`, `errorCount = 0`, RSS phẳng từ đầu đến cuối (`93,22 MB -> 94,64 MB`, `heapUsed = 18,54 MB`, `arrayBuffersMb = 0 MB`). Bản chạy đủ 30 phút đồng hồ thực ghi nhận trạng thái **`PARTIAL`** (hỗ trợ chạy lại một lệnh `--minutes 30`).

## 31. Kết quả Kiểm thử Ngâm 2 Giờ (Two-Hour Soak Test Status)
- **`NOT RUN`** (`EXTENDED SOAK TEST NOT RUN` trong phiên hoàn tất nhanh). Đã cung cấp sẵn kịch bản tái lập chính xác: `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 120`.

## 32. Kết quả Kiểm thử Ngâm 8 Giờ (Eight-Hour Soak Test Status)
- **`NOT RUN`** (`EXTENDED SOAK TEST NOT RUN`). Đã cung cấp sẵn kịch bản tái lập qua đêm: `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 480`.

## 33. Trạng thái Kiểm chứng Phần cứng Cấu hình Thấp (Low-End Hardware Verification Status)
- **`NOT RUN`** trực tiếp trên máy vật lý `Intel Core i5-5200U / i5-1035G1 (8 GB RAM)` trong môi trường phát triển hiện tại (máy đo là `i5-14600K`; không ngoại suy giả tạo). Đã đưa vào hạng mục `STAB-P65-02` cho đợt UAT thực tế trên laptop `i5-1035G1` của người dùng.

## 34. Kết quả Hồi quy Chất lượng Âm thanh (Audio Quality Regression Results)
- **`PASSED 100%`**: Không chuyển mã, không đổi tần số lấy mẫu hay độ sâu bit. Đối chiếu SHA-256 khớp tuyệt đối từng byte trên tệp FLAC gốc qua LAN/Remote HTTPS và khớp tuyệt đối từng sample PCM giải mã từ `@mgz-dev/alac` WASM trên `16-bit/44.1kHz`, `24-bit/48kHz`, `24-bit/96kHz` và `EOF moov`; bảo toàn hoàn toàn `AudioDspGraph` (EQ 10-band, PEQ 8-band, ReplayGain, Fade), Smart Shuffle và Auto Continue.

## 35. Kết quả Hồi quy Bảo mật (Security Regression Results)
- **`PASSED 100%`**: Bảo toàn `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP khóa mạng renderer (`connect-src 'self'`), `shell: false`, `SharedFilesystemGuard` (`fs.realpath`), ghim chứng chỉ SPKI SHA-256 trên cả socket mới lẫn socket Keep-Alive tái sử dụng, kiểm chứng CA công cộng + `RemoteEndpointDescriptorV1` + `POST /remote/verify-host`, tách biệt token `r1.*` vs LAN, chặn `403` các đường dẫn quản trị/ghép nối trên Gateway công cộng, chặn kích hoạt chống ngủ từ yêu cầu `401` không xác thực, và thu hồi quyền thiết bị có hiệu lực tức thì (`deviceAuthCache` xóa ngay + nhả khóa chống ngủ ngay lập tức).

## 36. Kết quả Toàn bộ Bộ Kiểm thử Tự động (Complete Automated Test Results)
- Chạy đầy đủ **55 tệp kiểm thử** trên runtime Electron `45.4.1` (kèm FFmpeg thực và bộ mã hóa Foobar2000): **`232 / 232 PASS, 0 FAIL, 0 SKIP`** trong `19.997,86 ms` (gồm `tests/phase65-power-management.test.ts` với đủ 22 kịch bản nguồn điện và `tests/phase65-resource-lifecycle.test.ts` cho vòng đời tài nguyên & ALAC WASM).

## 37. Danh sách Tệp Mã nguồn Đã Tạo & Sửa đổi (Modified Source Files)
- **Tạo mới**:
  - [`src/main/services/connect/host-power-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-power-manager.ts)
  - [`src/main/services/connect/resource-sampler.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/resource-sampler.ts)
  - [`tests/phase65-power-management.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase65-power-management.test.ts)
  - [`tests/phase65-resource-lifecycle.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase65-resource-lifecycle.test.ts)
  - [`scripts/run-electron-ts.mjs`](file:///G:/Source%20code%20DoReMi/scripts/run-electron-ts.mjs), [`scripts/benchmark-phase65.ts`](file:///G:/Source%20code%20DoReMi/scripts/benchmark-phase65.ts), [`scripts/soak-phase65.ts`](file:///G:/Source%20code%20DoReMi/scripts/soak-phase65.ts), [`scripts/verify-windows-power-phase65.mjs`](file:///G:/Source%20code%20DoReMi/scripts/verify-windows-power-phase65.mjs), [`scripts/verify-packaged-rc9.mjs`](file:///G:/Source%20code%20DoReMi/scripts/verify-packaged-rc9.mjs)
- **Cập nhật có kiểm soát**:
  - [`src/shared/types/connect.ts`](file:///G:/Source%20code%20DoReMi/src/shared/types/connect.ts), [`src/shared/types/ipc.ts`](file:///G:/Source%20code%20DoReMi/src/shared/types/ipc.ts), [`src/shared/contracts/channels.ts`](file:///G:/Source%20code%20DoReMi/src/shared/contracts/channels.ts), [`src/preload/index.ts`](file:///G:/Source%20code%20DoReMi/src/preload/index.ts)
  - [`src/main/services/flac-stream-sanitizer.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/flac-stream-sanitizer.ts)
  - [`src/main/services/connect/connect-repository.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-repository.ts), [`device-auth-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/device-auth-service.ts), [`remote-alac-decoder.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/remote-alac-decoder.ts), [`host-identity-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-identity-service.ts), [`tailscale-funnel-provider.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/tailscale-funnel-provider.ts), [`resource-budget.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/resource-budget.ts), [`filesystem-guard.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/filesystem-guard.ts), [`host-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-service.ts), [`smart-connection-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/smart-connection-manager.ts), [`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts)
  - [`src/main/ipc/register-ipc.ts`](file:///G:/Source%20code%20DoReMi/src/main/ipc/register-ipc.ts), [`src/main/index.ts`](file:///G:/Source%20code%20DoReMi/src/main/index.ts)
  - [`src/renderer/src/stores/connect-store-core.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store-core.ts), [`src/renderer/src/pages/ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx)
  - [`src/shared/user-guide/guide-content.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-content.ts), [`docs/USER_GUIDE.md`](file:///G:/Source%20code%20DoReMi/docs/USER_GUIDE.md), [`package.json`](file:///G:/Source%20code%20DoReMi/package.json), [`package-lock.json`](file:///G:/Source%20code%20DoReMi/package-lock.json), [`README.md`](file:///G:/Source%20code%20DoReMi/README.md), [`CHANGELOG.md`](file:///G:/Source%20code%20DoReMi/CHANGELOG.md), [`RELEASE_NOTES.md`](file:///G:/Source%20code%20DoReMi/RELEASE_NOTES.md), `qa/DoReMi-QA-*.cmd`.

## 38. Thay đổi Phụ thuộc (Dependency Changes)
- **`0` dependency mới** được thêm vào `package.json`. Kiểm tra `npm.cmd audit --omit=dev --json`: **`0` lỗ hổng bảo mật** trên toàn bộ `53` gói production.

## 39. Thay đổi Cơ sở Dữ liệu (Database Changes)
- **Không nâng phiên bản schema (`migrations.ts` giữ nguyên `SQLite schema v10`)**, không đụng chạm hay tái cấu trúc bảng người dùng. Chính sách nguồn điện `connect.host.power_policy` được lưu an toàn dưới dạng khóa cấu hình trong bảng `app_preferences` sẵn có (mặc định `'follow-system'` cho mọi cơ sở dữ liệu nâng cấp từ `rc.1`..`rc.8`).

## 40. Kết quả Build Production (Production Build Results)
- `npm.cmd run lint` (`tsc --noEmit`): **`0` lỗi**.
- `npm.cmd run docs:sync -- --check` & `npm.cmd run codecs:verify`: **`PASSED`**.
- `npm.cmd run build` (`electron-vite build && verify-build.mjs`): **`PASSED`** (`out/main/index.js 795.99 kB` + lazy `codec-manager 122.05 kB`, `out/preload/index.cjs 19.66 kB`, gói giao diện chính `out/renderer/assets/index-CByrnQGl.js 677.38 kB` tăng **`+0,00 kB`** so với `rc.8`, chunk tải lười `ServerPage 400.69 kB`).

## 41. Xác minh Chức năng Bản Đóng gói Thực tế (Packaged Functional Verification)
- Đã thực thi trực tiếp trên tệp thực thi đóng gói [`release/v1.0.0-rc.9/win-unpacked/DoReMi.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/win-unpacked/DoReMi.exe) với hồ sơ `userData` cô lập hoàn toàn (lưu bằng chứng tại [`qa/logs/phase65-packaged-rc9-verification.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-packaged-rc9-verification.json)):
  1. **Kiểm tra gói ASAR & Native Addon**: Xác minh `app.asar` phiên bản `1.0.0-rc.9`, đầy đủ các mô-đun Phase 6.5 và `app.asar.unpacked/.../better-sqlite3/prebuilds/win32-x64.node`.
  2. **GUI Smoke Test**: `[smoke-electron] OK (packaged=true, electron=45.4.1, rootChildren=2, diagLogs=1)`.
  3. **Boot 1 — Chức năng Thực tế Toàn diện**: Quét nhập FLAC cục bộ -> phát thực tế trên `<audio>` Chromium (`localCanPlay = true`) -> bật Host -> kiểm chứng 3 chế độ nguồn điện cùng `powerSaveBlocker` thực tế (`blockerDuringHostOnPolicy = true`, `blockerDuringFollowPolicy = false`, `blockerDuringStreamGrace = true`) -> ghép nối LAN TLS SPKI -> phát nhạc từ xa trên `<audio>` Chromium (`remoteCanPlay = true`, `durationsMatch = true`) -> lấy mẫu `ScopedHostResourceBreakdown` -> nối lại kết nối (`CONNECTED_LAN`) -> ngắt kết nối & dừng Host (`stoppedBlockerActive = false`, `stoppedActiveStreams = 0`).
  4. **Boot 2 — Lưu bền vững qua Khởi động lại**: Mở lại `DoReMi.exe` trên cùng hồ sơ cô lập xác nhận giữ nguyên bài hát SQLite (`1`), chính sách nguồn điện đã chọn (`keep-awake-streaming`), thiết bị được cấp quyền (`1`) và khóa xác thực DPAPI của Host đã lưu (`1`).

## 42. Đường dẫn Bộ cài & Mã băm SHA-256 (`release/v1.0.0-rc.9/`)
Bảo toàn nguyên vẹn các bản `release/v1.0.0-rc.1`..`rc.8` và xuất đầy đủ bộ cài mới tại [`release/v1.0.0-rc.9/`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/) kèm [`SHA256SUMS.txt`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/SHA256SUMS.txt):
- [`DoReMi-1.0.0-rc.9-x64-setup.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/DoReMi-1.0.0-rc.9-x64-setup.exe): `b10302e63656d76e45cbe5789c83eb586ce36777fda8fd34550e7b2933811215`
- [`DoReMi-1.0.0-rc.9-x64-portable.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/DoReMi-1.0.0-rc.9-x64-portable.exe): `c24925c3b293bb382ffb046bc82ec76cc059e2e289511fe3d7fd3cbe425a4cbf`
- [`DoReMi-1.0.0-rc.9-x64-portable.zip`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/DoReMi-1.0.0-rc.9-x64-portable.zip): `3d05cd35a6a6b9cde89341e3f6e2e5eecc20ed7ffe5eef4c295bc8bfc49b5f00`
- [`win-unpacked/DoReMi.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.9/win-unpacked/DoReMi.exe)

## 43. Hướng dẫn Nghiệm thu UAT Thủ công bằng Tiếng Việt (Manual Vietnamese UAT Instructions)
- Tài liệu hướng dẫn chi tiết gồm **12 mục kiểm tra nhanh ưu tiên (`Q-01`..`Q-12`)** và **72 mục nghiệm thu đầy đủ (Nhóm A–G)** bằng tiếng Việt dễ hiểu được đặt tại [`docs/phase-6/PHASE_6.5_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.5_WINDOWS_UAT.md). Bạn cũng có thể chạy nhanh qua [`qa/DoReMi-QA-Launch.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-Launch.cmd).

## 44. Trạng thái Xác minh Internet Thực tế của Phase 6.3 (Phase 6.3 Internet Verification Status)
- **`FUNNEL INTEGRATION NOT RUN` · `PHYSICAL INTERNET UAT PENDING`**: Toàn bộ luồng TLS công cộng, cổng loopback `127.0.0.1`, xác minh danh tính `verify-host` và tách token `r1.*` đã vượt qua kiểm thử tự động cục bộ, đang chờ nghiệm thu thực địa qua mạng Internet bên ngoài trên tài khoản Tailscale Funnel thật của bạn (`STAB-P63-01`).

## 45. Trạng thái Xác minh Bàn giao Mạng Vật lý của Phase 6.4 (Phase 6.4 Physical Handover Verification Status)
- **`PHYSICAL HANDOVER UAT PENDING`**: Đã kiểm chứng tự động đầy đủ trên trình phát Chromium thực tế (`Make-Before-Break` & `Break-Before-Make`), đang chờ thử nghiệm chuyển đổi vật lý 2 máy tính giữa Wi-Fi gia đình và Hotspot 4G/5G điện thoại (`STAB-P64-01`).

## 46. Các Giới hạn Còn lại Đã Ghi nhận Trung thực (Remaining Limitations)
1. Lệnh `powercfg /requests` của Windows yêu cầu chạy trong cửa sổ Command Prompt quyền Administrator (`powerCfgElevated = false` trong phiên user thường), nên cần người dùng kiểm tra trực quan ở bước `Q-04..Q-06` kèm thử Sleep/Resume vật lý (`PHYSICAL POWER UAT PENDING`).
2. Không hỗ trợ đánh thức máy tính đã tắt hoặc đã đi vào Sleep qua Internet công cộng / Tailscale Funnel nếu không có phần cứng phụ luôn bật trong mạng nhà (`BY DESIGN`).
3. Băng thông truyền nhạc Hi-Res từ xa phụ thuộc vào giới hạn relay miễn phí của Tailscale Funnel và sóng 4G/5G thực tế (bộ đệm đọc trước nâng cao thuộc phạm vi Phase 6.6).
4. Các bài chạy ngâm 2 giờ / 8 giờ theo đồng hồ thực và đo trực tiếp trên laptop dòng U (`i5-1035G1`) đang ở trạng thái `EXTENDED SOAK TEST NOT RUN` / chờ đợt UAT hợp nhất.

## 47. Sổ Đăng ký Vấn đề Hợp nhất Phase 6.3–6.5 (Consolidated Phase 6.3–6.5 Issue Register)
- Đã lập đầy đủ với mọi trường thông tin chuẩn hóa tại [`docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.3_TO_6.5_STABILIZATION_BACKLOG.md), phân tách rõ `STAB-P63-01..02`, `STAB-P64-01`, `STAB-P65-01..03` và `UI-BACKLOG-01..05`.

## 48. Nhắc lại Đầy đủ 5 Hạng mục Giao diện Hoãn sang Phase 7 (Complete Five-Item Phase 7 UI Backlog Reminder)
Giữ nguyên 100% không tự ý sửa sớm trong Phase 6.5 đúng theo hiến pháp `AGENTS.md`:
1. **`UI-BACKLOG-01` (Target Phase 7.3 — Now Playing Vinyl Rotation on Remote Playback)**: Sửa chuyển động quay đĩa than trong `NowPlayingPage` / Focus Vinyl khi đang phát nhạc từ xa (kể cả High Performance Mode).
2. **`UI-BACKLOG-02` (Target Phase 7.2 — Source-Aware Main Library Integration)**: Tích hợp duyệt Remote Music Library vào giao diện **Thư viện (Library)** chính theo bộ lọc nguồn thống nhất (`All Sources / Local Sources / Remote Server Sources`), chia sẻ tìm kiếm/Album/Nghệ sĩ/Playlist/Queue mà không sao chép file remote vào SQLite cục bộ.
3. **`UI-BACKLOG-03` (Target Phase 7.4 — Lightweight Real Host Resource Gauges)**: Hiển thị cụm đồng hồ chỉ số tài nguyên Host thực tế nhẹ trên giao diện (hạ tầng backend `HostResourceSampler` / `ScopedHostResourceBreakdown` đã hoàn tất ở Phase 6.5).
4. **`UI-BACKLOG-04` (Target Phase 7.4 — Minimalist Server UI Redesign)**: Thiết kế lại giao diện trang `Server` tối giản hơn, đưa các chi tiết kỹ thuật/bảo mật/mạng chuyên sâu vào mục **Nâng cao (Advanced)**.
5. **`UI-BACKLOG-05` (Target Phase 7.3 — Lyrics Compatibility & Synchronization Investigation)**: Điều tra tương thích & đồng bộ lời bài hát thực tế (*Love Option* unsynced trên cả Host & Client so với *DNA* synced và *Love Option Instrumental*), giữ nguyên thứ tự ưu tiên `Custom > External LRC > Embedded`.

## 49. Mức độ Sẵn sàng cho Đợt Rà soát Ổn định Hợp nhất Phase 6.3–6.5 (Combined Stabilization Readiness)
- Toàn bộ cổng kiểm định kỹ thuật **Gate A -> Gate F** của Phase 6.5 đã đạt: mã nguồn ổn định, bộ cài `v1.0.0-rc.9` đã xác minh chức năng thực tế 2 lượt khởi động, công cụ đo benchmark & soak một lệnh đã sẵn sàng, và danh sách kiểm tra gộp 12 bước nhanh (`Q-01`..`Q-12`) cho phép bạn kiểm chứng đồng thời cả Remote Funnel (6.3), Tự động chuyển mạng (6.4) và Chống ngủ/Tài nguyên (6.5) trong một lần thử nghiệm duy nhất. Không tự động chuyển sang Phase 6.6.

## 50. Trạng thái Triển khai Cuối cùng (Final Implementation Status)
- `IMPLEMENTATION COMPLETE`
- `AUTOMATED VERIFICATION COMPLETE` (`232/232 PASS`, `0 FAIL`, `0 SKIP`)
- `RESOURCE BENCHMARK COMPLETE` (`25/25` kịch bản Before vs After + `118,93s` Soak)
- `PHYSICAL POWER UAT PENDING`
- `FUNNEL INTEGRATION NOT RUN`
- `PHYSICAL INTERNET UAT PENDING`
- `PHYSICAL HANDOVER UAT PENDING`
- `EXTENDED SOAK TEST NOT RUN`
- `COMBINED STABILIZATION PENDING`
