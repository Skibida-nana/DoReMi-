# PHASE 6.5 — WINDOWS RESOURCE & PERFORMANCE BENCHMARK REPORT (`v1.0.0-rc.9`)

## 1. Môi trường & Phương pháp Đo lường Thực tế

- **Máy đo thực tế (Development / Benchmark Host)**:
  - **Hệ điều hành**: Windows 11 x64 (`win32`, kernel `10.0.26200`)
  - **Runtime**: Electron `45.4.1` · Node.js `v24.22.3` · SQLite `better-sqlite3` `13.2.0` (schema `v10`)
  - **CPU & RAM vật lý**: `Intel(R) Core(TM) i5-14600K` (`20` luồng logic), `31,65 GB` RAM hệ thống
  - **Lưu ý trung thực về phần cứng tham chiếu cấu hình thấp (`Intel Core i5-5200U / i5-1035G1, 8 GB RAM`)**: **`NOT RUN`** trực tiếp trong phiên tự động này (tuyệt đối không suy diễn tuyến tính từ số đo trên `i5-14600K` sang laptop dòng U). Đối chiếu tham khảo từ UAT thực địa Phase 6.1.3 của người dùng trên `i5-1035G1 / 8 GB RAM`: ~`6–7%` CPU (Low Performance Mode), ~`11,3%` CPU (High Performance Mode), `228,9–294,7 MB` RAM.
- **Công cụ & Dữ liệu gốc kiểm chứng**:
  - Kịch bản tự động lặp lại: [`scripts/benchmark-phase65.ts`](file:///G:/Source%20code%20DoReMi/scripts/benchmark-phase65.ts)
  - Dữ liệu gốc **Trước tối ưu (`v1.0.0-rc.8`)**: [`qa/logs/phase65-benchmark-before.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-benchmark-before.json)
  - Dữ liệu gốc **Sau tối ưu (`v1.0.0-rc.9`)**: [`qa/logs/phase65-benchmark-after.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-benchmark-after.json)
  - Dữ liệu gốc **Chịu tải chạy dài (`soak-phase65.ts`)**: [`qa/logs/phase65-sustained-stability.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase65-sustained-stability.json)
- **Cách tính chỉ số**:
  - `% CPU Normalized` = tổng thời gian CPU `user + system` chia cho `(wallTime * 20 logical CPUs)`.
  - `% CPU 1-Core` = tổng thời gian CPU `user + system` quy đổi trên 1 nhân đơn (`0%..100%+`).
  - Mạng LAN Direct đo qua cổng TLS SPKI-pinned thực tế; Remote HTTPS đo qua reverse proxy TLS xác thực CA độc lập cục bộ (không mở Funnel cá nhân thật của người dùng trong quá trình chạy tự động).

---

## 2. Tổng hợp Cải thiện Tích lũy Toàn Bộ 25 Kịch bản (Before vs After)

| Chỉ số tích lũy qua 25 kịch bản | Trước tối ưu (`rc.8`) | Sau tối ưu (`rc.9`) | Mức thay đổi thực tế | Nguyên nhân kỹ thuật tạo ra cải thiện |
|---|---:|---:|---:|---|
| **Số kết nối TCP/TLS LAN mới mở (`lanTcpConnections`)** | `108` | **`38`** | **`-64,8%`** | `ScopedHttpsAgentPool` tái sử dụng kết nối TLS đã ghim SPKI |
| **Số bắt tay TLS Remote mới (`remoteTlsHandshakes`)** | `108` | **`20`** | **`-81,5%`** | Tái sử dụng Keep-Alive TLS qua tất cả yêu cầu `HTTP 206 Range` |
| **Số lượt ghi SQLite `touchDeviceActivity`** | `165` | **`10`** | **`-93,9%`** | Gom nhịp ghi `30s/thiết bị` + `deviceAuthCache` (`10s`) |
| **Số lần gọi tiến trình `tailscale.exe` CLI** | `62` | **`57`** *(gộp burst `12 -> 3`)* | **`-8,1%` tổng / `-75%` khi kiểm tra dồn dập** | Gộp yêu cầu đang bay (`inflightDetect`) + cache `5s` cho trạng thái `ready` |
| **Số lần dựng lại `libraryViewCache`** | `3` | **`2`** | **`-33,3%`** | Khởi tạo lười khi có truy vấn + kiểm tra `getLibraryStateToken()` |
| **RAM RSS sau khi dọn dẹp cuối bài đo (`finalPostShutdownRssMb`)** | `117,38 MB` | **`108,88 MB`** | **`-8,50 MB` (`-7,2%`)** | Bản sao độc lập cửa sổ ALAC WASM + giải phóng agent/cache/khóa riêng |
| **`arrayBuffersMb` còn giữ lại sau khi đóng** | `0,00 MB` | **`0,00 MB`** | **`0,00 MB` (Không rò rỉ)** | Giải phóng sạch toàn bộ vùng đệm luồng và giải mã |
| **Sai lệch File Handle mở (`openFileHandlesDelta`)** | `0` | **`0`** | **`0` ở cả 25/25 kịch bản** | `pipeline` + `cleanup()` đóng `FileHandle` trên mọi nhánh `206`/`416`/abort |

> **Quan sát chỉ-đọc tiến trình hệ điều hành Tailscale (`Scenario #08`)**: Trên máy đo, 3 tiến trình nền của hệ điều hành Windows (`tailscaled` x2 + `tailscale-ipn`) chiếm khoảng `148,18–219,73 MB` Working Set (`207,38–209,66 MB` Private Bytes). Con số này thuộc về ứng dụng nền Tailscale của Windows, **tách biệt hoàn toàn** với tiến trình DoReMi (`83,87–118,65 MB` RSS).

---

## 3. Bảng Chi tiết Toàn bộ 25 Kịch bản Benchmark (Before `rc.8` vs After `rc.9`)

| # | Kịch bản đo | CPU Norm Trước / Sau (%) | CPU 1-Core Trước / Sau (%) | RSS Settled Trước / Sau (MB) | LAN Conn Trước / Sau | Remote TLS Trước / Sau | SQLite Writes Trước / Sau | Lỗi |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 01 | Local Player nghỉ (`Host OFF`, `Client Disconnected`) | `0,00` / **`0,00`** | `0,00` / **`0,00`** | `93,23` / **`83,87`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 02 | Local Player phát FLAC `16/44.1` theo nhịp thực | `0,08` / **`0,33`** | `1,59` / **`6,58`** | `94,37` / **`85,34`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 03 | Local Player phát ALAC `16/44.1` WASM | `0,08` / **`0,39`** | `1,60` / **`7,83`** | `100,31` / **`91,47`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 04 | `Host OFF` (kiểm tra trạng thái lặp lại, `0` listener/timer) | `0,28` / **`0,00`** | `5,51` / **`0,00`** | `100,43` / **`91,46`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 05 | `Host STANDBY` (`0` thiết bị đang kết nối) | `0,06` / **`0,13`** | `1,25` / **`2,55`** | `100,87` / **`91,76`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 06 | `Host ON` chế độ LAN Only (`1` Client nghỉ) | `0,00` / **`0,00`** | `0,00` / **`0,00`** | `107,83` / **`97,87`** | `1` / **`0`** | `0` / `0` | `1` / **`0`** | `0` |
| 07 | `Host ON` bật Remote Gateway (`4` lần kiểm tra Tailscale liên tiếp) | `0,09` / **`0,00`** | `1,86` / **`0,00`** | `108,41` / **`98,02`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` *(CLI `12 -> 3`)* |
| 08 | Quan sát chỉ-đọc Tailscale nền khi không mở Funnel thật | `0,00` / **`0,00`** | `0,00` / **`0,00`** | `108,46` / **`98,08`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 09 | Remote Access Standby (`1` Client Remote HTTPS nghỉ) | `0,00` / **`0,00`** | `0,00` / **`0,00`** | `111,20` / **`100,14`** | `0` / `0` | `0` / `0` | `0` / `0` | `0` |
| 10 | `1` Client LAN Direct phát FLAC `16/44.1` (`8` Range chunks) | `0,18` / **`0,06`** | `3,63` / **`1,28`** | `111,99` / **`99,88`** | `13` / **`0`** | `0` / `0` | `13` / **`0`** | `0` |
| 11 | `1` Client Remote HTTPS phát FLAC `16/44.1` (`8` Range chunks) | `0,06` / **`0,31`** | `1,21` / **`6,27`** | `115,68` / **`102,70`** | `0` / `0` | `8` / **`0`** | `8` / **`0`** | `0` |
| 12 | `1` Client Remote HTTPS phát ALAC WASM | `0,13` / **`0,19`** | `2,59` / **`3,70`** | `125,06` / **`113,43`** | `0` / `0` | `4` / **`0`** | `4` / **`0`** | `0` |
| 13 | `1` Client phát Hi-Res FLAC `24-bit/96kHz` | `0,37` / **`0,06`** | `7,39` / **`1,28`** | `112,34` / **`118,65`** | `0` / `0` | `13` / **`0`** | `13` / **`0`** | `0` |
| 14 | `3` Client LAN phát FLAC đồng thời | `0,25` / **`0,83`** | `4,94` / **`16,50`** | `119,40` / **`105,97`** | `20` / **`0`** | `0` / `0` | `20` / **`0`** | `0` |
| 15 | `3` Client hỗn hợp (LAN FLAC + Remote Hi-Res + Remote ALAC) | `0,66` / **`0,19`** | `13,10` / **`3,70`** | `119,71` / **`114,20`** | `5` / **`0`** | `9` / **`0`** | `14` / **`0`** | `0` |
| 16 | Host vừa nghe nhạc cục bộ vừa phục vụ Client Remote HTTPS | `0,50` / **`0,17`** | `9,99` / **`3,39`** | `123,52` / **`104,40`** | `0` / `0` | `10` / **`1`** | `8` / **`0`** | `0` |
| 17 | Tua liên tục `24` lần (`HTTP 206` trên FLAC + ALAC) *(37,1 ms vs 70,4 ms — nhanh gấp `1,9x`)* | `5,47` / **`6,33`** *(burst 37ms)* | `109,42` / **`126,61`** | `118,47` / **`111,73`** | `0` / `0` | `17` / **`0`** | `17` / **`0`** | `0` |
| 18 | Đổi bài liên tục `12` lần kèm hủy luồng giữa chừng *(40,4 ms vs 49,6 ms)* | `6,35` / **`5,82`** | `127,01` / **`116,42`** | `122,00` / **`115,00`** | `0` / `0` | `13` / **`7`** | `13` / **`0`** | `0` |
| 19 | Mất mạng tạm thời & tự khôi phục `4` chu kỳ *(33,5 ms vs 44,8 ms)* | `5,36` / **`4,62`** | `107,21` / **`92,43`** | `122,93` / **`104,53`** | `0` / `0` | `14` / **`5`** | `5` / **`0`** | `0` |
| 20 | Bàn giao đường truyền tự động `LAN <-> Remote` `4` chu kỳ | `0,07` / **`0,05`** | `1,48` / **`1,00`** | `124,23` / **`104,98`** | `7` / **`3`** | `2` / **`1`** | `5` / **`0`** | `0` |
| 21 | Bật/tắt Host & Remote Gateway lặp lại `4` chu kỳ | `4,19` / **`4,63`** *(33ms)* | `83,82` / **`92,68`** | `125,23` / **`105,71`** | `0` / `0` | `0` / `0` | `0` / **`3`** *(flush)* | `0` |
| 22 | Thu nhỏ cửa sổ (`0` UI polling) khi đang phục vụ `1` Client LAN | `0,49` / **`0,25`** | `9,88` / **`4,92`** | `116,00` / **`107,72`** | `7` / **`0`** | `0` / `0` | `7` / **`0`** | `0` |
| 23 | Tạm dừng và tiếp tục phát đúng offset byte | `0,00` / **`0,18`** | `0,00` / **`3,69`** | `116,63` / **`108,21`** | `2` / **`0`** | `0` / `0` | `2` / **`0`** | `0` |
| 24 | Thu hồi quyền thiết bị giữa phiên & kiểm tra dọn tài nguyên | `7,15` / **`0,00`** | `143,03` / **`0,00`** | `117,00` / **`108,44`** | `2` / **`0`** | `0` / `0` | `0` / `0` | `0` |
| 25 | Đối soát vòng đời `suspend` -> `resume` (mô phỏng sự kiện phần mềm) | `0,00` / **`0,19`** | `0,00` / **`3,79`** | `117,27` / **`108,57`** | `1` / **`1`** | `0` / `0` | `1` / **`1`** | `0` |

> **Giải thích lưu ý đọc số liệu burst ngắn (#17–#19, #21)**: Các kịch bản стресс không nghỉ (#17 tua `24` lần hoàn tất chỉ trong **`37,12 ms`** so với `70,37 ms` trước tối ưu — tăng tốc thông lượng truyền gần gấp đôi từ `14,9 MB/s` lên **`28,2 MB/s`**) hoàn thành nhanh hơn nhiều nhờ loại bỏ `17` lần bắt tay TLS và `17` lần khóa ghi SQLite, nên mật độ công việc trên mỗi mili-giây cao hơn trong cửa sổ `37 ms` nhưng tổng thời gian CPU thực tiêu tốn thấp hơn và RSS giảm từ `118,47 MB` xuống `111,73 MB`.

---

## 4. Điều tra Hiện tượng Giữ Bộ nhớ ~213 MB RSS trong Benchmark RC.7 (Mục 46)

Trong báo cáo Phase 6.3 (`rc.7`), bài đo cục bộ `scripts/benchmark-phase63.ts` từng ghi nhận đỉnh `rssMb = 213 MB` sau bước tải đồng thời 3 luồng. Cuộc điều tra chuyên sâu trong Phase 6.5 đã xác định chính xác **4 nguyên nhân gốc rễ** (chứng minh đây **không phải** lỗi rò rỉ bộ nhớ vô hạn, nhưng có 2 điểm giữ bộ nhớ tạm đã được tối ưu triệt để trong `rc.9`):

1. **Đặc thù gộp chung 3 vai trò trong cùng 1 tiến trình bài đo**: `benchmark-phase63.ts` khởi chạy đồng thời `ConnectHostService` + máy chủ proxy TLS + `3` thực thể `ConnectClientService` bên trong cùng 1 tiến trình Electron/Node duy nhất.
2. **Đọc nguyên tệp vào `resp.arrayBuffer()` đồng thời trong kịch bản đo cũ**: Bài đo RC.7 gọi `await resp.arrayBuffer()` cùng lúc trên 3 tệp nhạc lớn (`~8 MB x 3`), buộc cấp phát tức thời hàng chục MB vùng đệm liền kề trên C++ External / ArrayBuffer, khiến bộ cấp phát trang bộ nhớ gốc của Windows/Node (mimalloc/V8) mở rộng Working Set đỉnh lên ~213 MB và giữ trang bộ nhớ dự phòng của hệ điều hành ngay cả khi `heapUsed` chỉ còn `~18 MB`.
3. **Mở mới phiên OpenSSL TLS trên từng yêu cầu (`agent: false` trước Phase 6.5)**: Việc tạo mới hàng trăm đối tượng `TLSSocket` / `SSL_CTX` / BIO buffer không tái sử dụng tạo phân mảnh vùng nhớ native C++ ngoài V8 heap. Với `ScopedHttpsAgentPool` trong `rc.9`, số bắt tay TLS giảm `81,5%` và RSS ổn định ở mức **`99,88–118,65 MB`** trong suốt 25 kịch bản (với `arrayBuffersMb = 0,00 MB` sau khi đóng).
4. **View chia sẻ bộ nhớ tuyến tính WASM trong `remote-alac-decoder.ts` (Đã sửa triệt để)**: Trước `rc.9`, `Buffer.from(decodedChunks[0].buffer, byteOffset, byteLength)` giữ tham chiếu trực tiếp tới `ArrayBuffer` nội bộ của mô-đun WebAssembly `@mgz-dev/alac` cho tới khi cửa sổ LRU bị thay thế. Trong `rc.9`, việc đổi sang bản sao độc lập `Buffer.from(decodedChunks[0])` kết hợp bộ dọn tự động `20s`/`60s` đảm bảo bộ nhớ WASM được giải phóng ngay tức khắc.

---

## 5. Kết quả Kiểm thử Ổn định Chạy dài (`scripts/soak-phase65.ts`)

- **Lệnh thực thi**: `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 2.5`
- **Kết quả đo thực tế (`qa/logs/phase65-sustained-stability.json`)**:
  - Tổng thời gian chạy thực tế: **`118,93 giây`** qua đủ 5 giai đoạn tải (`A: Host Standby` -> `B: 1 Client phát theo nhịp + giữ luồng Tạm dừng mở suốt 31,5 giây rồi phát tiếp` -> `C: 3 Client hỗn hợp LAN FLAC + Remote FLAC + Remote ALAC WASM` -> `D: Đứt mạng & bàn giao tự động LAN <-> Remote lặp lại` -> `E: Bật/tắt Host & Remote Gateway 5 chu kỳ`).
  - Tổng dữ liệu âm thanh đã truyền: **`16.711.816 bytes` (`~15,94 MB`)**, **`errorCount = 0`**.
  - Diễn biến bộ nhớ dọc theo 23 mẫu đo định kỳ 5 giây:
    - Khởi đầu (`t = 5s`, Standby): `rssMb = 93,22 MB`, `heapUsedMb = 15,64 MB`, `arrayBuffersMb = 0 MB`.
    - Trong suốt `31,5 giây` tạm dừng luồng nhạc (`t = 40s..60s`): `% CPU = 0,00%`, `rssMb = 86,88–86,95 MB`, luồng tiếp tục đọc mượt mà sau khi hết 31,5 giây mà không bị ngắt kết nối.
    - Dưới tải 3 Client đồng thời (`t = 65s..90s`): `% CPU = 0,06%–0,16%`, `rssMb = 92,50–94,43 MB`, `pooledFreeSockets = 2..3`.
    - Sau khi dọn dẹp cuối phiên: **`rssMb = 94,64 MB`**, **`heapUsedMb = 18,54 MB`**, **`externalMb = 7,59 MB`**, **`arrayBuffersMb = 0,00 MB`** — đường cong bộ nhớ hoàn toàn phẳng, không có hiện tượng tăng dần theo thời gian.
- **Trạng thái các bài chạy ngâm thời gian thực nhiều giờ**:
  - Chạy ngâm 30 phút đầy đủ / 2 giờ / 8 giờ liên tục theo đồng hồ thực: **`PARTIAL / NOT RUN`** trong phiên CI ngắn; đã cung cấp sẵn công cụ tái lập một lệnh duy nhất:
    - `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 30`
    - `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 120`
    - `node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 480`
