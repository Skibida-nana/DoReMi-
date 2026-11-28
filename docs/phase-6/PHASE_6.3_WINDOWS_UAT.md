# DoReMi Phase 6.3 — Windows User Acceptance Testing (UAT) Checklist (`v1.0.0-rc.7`)

**Tổng số hạng mục**: **74 mục** (Nhóm A: 12 · Nhóm B: 12 · Nhóm C: 12 · Nhóm D: 16 · Nhóm E: 12 · Nhóm F: 10)  
**Trạng thái mặc định trên bản build**: Các mục tự động có thể đối chiếu qua test nội bộ (`mocked Tailscale CLI + local Public CA proxy`), **Nhóm E (Internet thật 2 máy qua Tailscale Funnel)** đang ở trạng thái **`PENDING PHYSICAL ENVIRONMENT`** do máy build chưa cài `tailscale.exe`.

---

## Nhóm A — Hồi quy Phase 6.0–6.2 & Nâng cấp dữ liệu (`A01–A12`)

| Mã | Kịch bản kiểm thử | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **A01** | Mở ứng dụng trên dữ liệu RC.6 (`SQLite v9`) | Tự động tạo bản backup trước migration `v10`, toàn bộ bài hát, playlist, thống kê và thiết bị giữ nguyên | `[ ]` (Automated `PASS` in `database.test.ts`) |
| **A02** | Khởi động lạnh với Host Server mặc định TẮT | Không mở cổng LAN, không mở Gateway, không gọi `tailscale` gây treo khởi động | `[ ]` |
| **A03** | Phát nhạc Local FLAC 16/24-bit, ALAC, WAV, MP3, AAC, OGG, Opus | Phát mượt, không giật, giữ đúng chất lượng âm thanh gốc | `[ ]` |
| **A04** | Album Detail track order & Smart Shuffle (IMP-03) | Đúng thứ tự `disc -> track_number`; không gom cùng album khi shuffle | `[ ]` |
| **A05** | Auto Continue (IMP-04) & Nút Phát ngẫu nhiên (IMP-06) | Tự động phát tiếp thư viện Local khi hết danh sách (khi bật) | `[ ]` |
| **A06** | Auto-Hide Sidebar (IMP-05) & Long Vietnamese Title (`BUG-01`) | Sidebar ẩn ngay khi vào Now Playing; tiêu đề dài không mất dấu | `[ ]` |
| **A07** | Bật Host LAN Direct bình thường khi chưa bật Remote HTTPS | Hoạt động y hệt RC.6 (`LAN Direct`), hiển thị đúng trạng thái `Remote: DISABLED` | `[ ]` |
| **A08** | Ghép nối thiết bị mới qua QR `doremi-pair` v1 / JSON / Thủ công | Thành công trong mạng LAN; đếm ngược `05:00` chuẩn xác | `[ ]` |
| **A09** | Kết nối Client đã ghép từ RC.6 ở chế độ LAN Direct | Kết nối ngay bằng token LAN cũ mà không phải ghép lại | `[ ]` |
| **A10** | Phát nhạc LAN Direct trên `FLAC`, `ALAC 16/24-bit`, `WAV`, `AAC` | Phát mượt, seek chuẩn, pause > 30s tiếp tục bình thường | `[ ]` |
| **A11** | Xoay vòng token LAN (`Rotate Token`) trong mạng nội bộ | Cập nhật token LAN mới qua kênh Pinned TLS, token cũ bị từ chối | `[ ]` |
| **A12** | Tìm kiếm Remote Library & quay lại từ Now Playing (`BUG-P613-01`) | Giữ nguyên từ khóa tìm kiếm, bấm `X` / xóa trắng trả ngay về toàn bộ danh sách | `[ ]` |

---

## Nhóm B — Phát hiện Tailscale Funnel & Xử lý lỗi hệ thống (`B01–B12`)

| Mã | Kịch bản kiểm thử | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **B01** | Kiểm tra trạng thái khi máy chưa cài `tailscale.exe` | Báo rõ "Chưa phát hiện Tailscale trên hệ thống", không crash, không treo UI | `[ ]` (Automated `Provider-2`) |
| **B02** | Phiên bản Tailscale CLI `< 1.52.0` | Từ chối bật Funnel với thông báo yêu cầu nâng cấp Tailscale >= 1.52.0 | `[ ]` (Automated `Provider-2`) |
| **B03** | Dịch vụ Tailscale chưa chạy (`BackendState !== Running`) | Hướng dẫn người dùng khởi động Tailscale Daemon trước | `[ ]` (Automated `Provider-2`) |
| **B04** | Tailscale chưa đăng nhập tài khoản (`NeedsLogin`) | Hiển thị rõ cần Sign in vào Tailscale | `[ ]` (Automated `Provider-2`) |
| **B05** | Tailnet chưa bật MagicDNS | Từ chối bật Funnel, hướng dẫn bật MagicDNS trong Admin DNS | `[ ]` (Automated `Provider-2`) |
| **B06** | Tailnet chưa bật HTTPS Certificates | Từ chối bật Funnel, hướng dẫn bật HTTPS Certificates | `[ ]` (Automated `Provider-2`) |
| **B07** | Thiếu ACL capability `tailscale.com/cap/funnel` | Thông báo rõ cần cấp quyền `funnel` trong Tailscale ACL | `[ ]` (Automated `Provider-2`) |
| **B08** | Tailscale trả JSON sai cấu trúc hoặc CLI bị timeout | `tailscale-cli.ts` cắt timeout & bắt lỗi an toàn, trạng thái Host chuyển lỗi sạch | `[ ]` (Automated `Provider-2`) |
| **B09** | Cổng Funnel chọn (`443`) đang có rule Tailscale Serve nội bộ (`AllowFunnel: false`) | Từ chối ghi đè cổng `443` nhằm tránh lộ dịch vụ riêng tư khác ra Internet | `[ ]` (Automated `Provider-3`) |
| **B10** | Bật Remote HTTPS khi chưa tick xác nhận công khai Internet | Bị chặn ở lớp UI và Pre-exposure Security Gate trong `ConnectHostService` | `[ ]` (Automated `Provider-4`) |
| **B11** | Tắt Remote HTTPS khi có lỗi CLI dọn route | `RemoteGatewayService` vẫn đóng cổng loopback ngay lập tức để cắt bề mặt mạng | `[ ]` (Automated `Provider-4`) |
| **B12** | Khởi động lại app Host khi SQLite còn lưu route mồ côi từ crash lần trước | Startup reconciliation tự dọn route `/doremi-connect` mồ côi nếu thuộc DoReMi | `[ ]` (Automated `Provider-4`) |

---

## Nhóm C — Xác thực Endpoint Mật mã & Phân lập Token (`C01–C12`)

| Mã | Kịch bản kiểm thử | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **C01** | Sửa đổi trường `publicOrigin` trong `RemoteEndpointDescriptorV1` | Xác minh chữ ký ECDSA P-256 thất bại ngay tại Client (`Security-B`) | `[ ]` |
| **C02** | Thiết bị mới ghép nối thành công trong LAN | Quyền `remoteAccessEnabled` mặc định `OFF` (`false`) | `[ ]` |
| **C03** | Đồng bộ Remote qua LAN khi thiết bị chưa được bật `remoteAccessEnabled` | Host trả lỗi `REMOTE_ACCESS_NOT_GRANTED`, Client không nhận `r1.*` token | `[ ]` |
| **C04** | Bật `remoteAccessEnabled = true` rồi đồng bộ Remote qua LAN | Client nhận Descriptor đã ký + Remote Token dạng `r1.<deviceId>.<secret>` | `[ ]` |
| **C05** | Thử dùng token LAN gửi lên Remote Gateway | Remote Gateway từ chối (`403`) | `[ ]` |
| **C06** | Thử dùng Remote Token `r1.*` gửi lên cổng LAN Direct | Cổng LAN Direct từ chối (`401`) | `[ ]` |
| **C07** | Client kết nối Remote HTTPS khi Server dùng chứng chỉ CA không tin cậy / sai hostname | Từ chối bắt tay TLS (`rejectUnauthorized: true`), `0 byte` token được gửi | `[ ]` |
| **C08** | Remote Gateway giả mạo chữ ký trong `POST /remote/verify-host` hoặc replay nonce | Client từ chối kết nối ngay sau bước verify-host, không gửi Bearer token | `[ ]` |
| **C09** | Chọn chế độ `LAN Direct` khi Host LAN không liên lạc được (dù đã có Remote config) | Không tự động fallback sang `Remote HTTPS`, báo lỗi LAN rõ ràng | `[ ]` |
| **C10** | Chọn chế độ `Remote HTTPS` khi Internet không khả dụng | Không tự fallback, hiển thị lỗi kết nối Remote HTTPS rõ ràng | `[ ]` |
| **C11** | Gọi `POST /remote/provision` từ địa chỉ Remote Gateway | Bị chặn cứng (`403`), chỉ cho phép qua LAN Direct Pinned TLS | `[ ]` |
| **C12** | Xoay vòng Remote Token (`POST /auth/rotate-remote-token`) qua Remote HTTPS | Cập nhật token `r1.*` mới; token cũ mất hiệu lực, LAN token giữ nguyên | `[ ]` |

---

## Nhóm D — Bảo mật Gateway & Chất lượng Phát nhạc Remote (`D01–D16`)

| Mã | Kịch bản kiểm thử | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **D01** | Kiểm tra địa chỉ lắng nghe của `RemoteGatewayService` | Chỉ lắng nghe `127.0.0.1`, không mở `0.0.0.0` ra mạng LAN/WAN | `[ ]` |
| **D02** | Gọi `/enrollment/*`, `/admin/*`, `/diagnostics`, `/auth/rotate-token` qua Remote Gateway | Trả về `403 Forbidden` trên mọi phương thức | `[ ]` |
| **D03** | Gửi traversal URL (`/%2e%2e/`, `/../`, `%5c`) qua Remote Gateway | Từ chối `400 Bad Request` | `[ ]` |
| **D04** | Gửi phương thức HTTP `DELETE`, `PUT`, `PATCH` tới Remote Gateway | Từ chối `405 Method Not Allowed` | `[ ]` |
| **D05** | Gửi header giả mạo `X-Forwarded-For`, `Tailscale-User-Login` vào Gateway | Bị loại bỏ ngay trước khi vào handler | `[ ]` |
| **D06** | Spam request không xác thực liên tiếp vào `/capabilities` hoặc `/remote/verify-host` | Kích hoạt giới hạn tốc độ (`429 RATE_LIMITED`) | `[ ]` |
| **D07** | Nghe từ xa `FLAC 16-bit / 44.1 kHz` & `24-bit / 96 kHz` | Nhận nguyên byte (`direct-original`), khớp SHA-256 file gốc trên Host | `[ ]` |
| **D08** | Nghe từ xa `WAV 16/24-bit` | Nhận nguyên byte (`direct-original`), phát mượt trong Chromium `<audio>` | `[ ]` |
| **D09** | Nghe từ xa `ALAC 16-bit & 24-bit (.m4a)` (cả `+faststart` và `moov` ở cuối file) | Range WASM giải mã PCM WAV chính xác từng bit (`SHA-256` bằng local ALAC), seek `206` chuẩn | `[ ]` |
| **D10** | Nghe từ xa `MP3`, `AAC (.m4a)`, `OGG Vorbis`, `Opus` | Phát mượt, tua vị trí chuẩn trên toàn bộ định dạng | `[ ]` |
| **D11** | Tải lời bài hát (Lyrics) qua Remote HTTPS | Trả về đúng nội dung lời, trường `sidecarPath` được ẩn (`null`) | `[ ]` |
| **D12** | Tải ảnh bìa (Artwork) song song với phát nhạc qua Remote HTTPS | Ảnh tải đúng qua hàng đợi giới hạn, không gây lỗi `429` cho luồng phát nhạc | `[ ]` |
| **D13** | Tạm dừng phát nhạc Remote > 30s rồi phát tiếp | Tiếp tục phát bình thường không bị rớt kết nối giữa chừng | `[ ]` |
| **D14** | Thu hồi quyền Remote Access của riêng 1 thiết bị khi đang nghe nhạc | Stream Remote dừng ngay lập tức; kết nối LAN của thiết bị đó vẫn hoạt động | `[ ]` |
| **D15** | Tắt `Disable Remote Access` trên Host khi đang phát | Gateway đóng tức thì, mọi stream Remote dừng ngay; Server LAN vẫn giữ nguyên | `[ ]` |
| **D16** | Kiểm tra `Diagnostics` / `recentSecurityEvents` trên Host & Client | Hiển thị đầy đủ dấu vết `remote-https` nhưng tuyệt đối không lộ raw secret/token | `[ ]` |

---

## Nhóm E — UAT Internet Thực Tế 2 Máy Khác Mạng (`E01–E12`) · `[PENDING PHYSICAL ENVIRONMENT]`

> Thực hiện theo hướng dẫn [`PHASE_6.3_FUNNEL_SETUP.md`](./PHASE_6.3_FUNNEL_SETUP.md) với Host gắn mạng nhà cài Tailscale thật và Client dùng mạng ngoài hoàn toàn (4G Hotspot / Wi-Fi khác).

| Mã | Kịch bản kiểm thử thực tế | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **E01** | Cài đặt Tailscale Windows, bật MagicDNS + HTTPS Cert + ACL `funnel` trên Host thật | Màn hình Host Remote hiển thị tất cả trạng thái sẵn sàng màu xanh | `[ ] PENDING PHYSICAL` |
| **E02** | Bật Remote HTTPS trên Host thật với cổng `443` | `tailscale funnel status --json` chỉ có `/doremi-connect -> http://127.0.0.1:<port>` | `[ ] PENDING PHYSICAL` |
| **E03** | Kiểm tra máy Client ở mạng ngoài xác nhận KHÔNG cài Tailscale/VPN | Kết nối thành công vào `https://<host>.ts.net` chỉ bằng DoReMi | `[ ] PENDING PHYSICAL` |
| **E04** | Duyệt thư viện chia sẻ & tìm kiếm bài hát qua Internet thật | Tải danh sách mượt, hiển thị ảnh bìa không vỡ | `[ ] PENDING PHYSICAL` |
| **E05** | Phát trực tiếp `FLAC`, `WAV`, `ALAC`, `AAC`, `MP3` qua Internet thật | Nghe rõ, ổn định, không sai tốc độ hay biến dạng tiếng | `[ ] PENDING PHYSICAL` |
| **E06** | Tua nhanh (Seek) nhiều lần liên tiếp trong bài `ALAC` và `FLAC` qua Internet thật | Đáp ứng nhanh, không bị kẹt HTTP 416 hay lỗi `Format error` | `[ ] PENDING PHYSICAL` |
| **E07** | Tạm dừng 45 giây qua Internet thật rồi bấm phát tiếp | Phát tiếp trơn tru tại đúng vị trí đang dừng | `[ ] PENDING PHYSICAL` |
| **E08** | Xoay vòng Remote Token trực tiếp khi Client đang dùng mạng ngoài | Token mới hoạt động ngay, tắt app mở lại vẫn kết nối Remote thành công | `[ ] PENDING PHYSICAL` |
| **E09** | Thu hồi quyền Remote Access trên Host khi Client đang nghe qua Internet | Client ngắt nhạc tức thì và báo lỗi thu hồi quyền | `[ ] PENDING PHYSICAL` |
| **E10** | Đem Client về lại mạng nhà, chuyển lại `LAN Direct` | Phát nhạc lại bằng mạng nội bộ mà không cần ghép nối lại | `[ ] PENDING PHYSICAL` |
| **E11** | Tắt DoReMi Host bình thường -> kiểm tra `tailscale funnel status` trên Windows | Route `/doremi-connect` đã được dọn sạch, không đụng cấu hình khác | `[ ] PENDING PHYSICAL` |
| **E12** | Ghi nhận trải nghiệm băng thông Hi-Res với Tailscale Personal relay | Ghi chú trung thực độ mượt / thời gian đệm thực tế | `[ ] PENDING PHYSICAL` |

---

## Nhóm F — Bảo toàn Ranh giới Pha & Phase 7 UI Backlog (`F01–F10`)

| Mã | Hạng mục xác minh | Kết quả kỳ vọng | Trạng thái |
|---|---|---|---|
| **F01** | Kiểm tra tự động fallback LAN ↔ Remote | Không triển khai trong `rc.7` (để dành Phase 6.4) | `[ ]` |
| **F02** | Kiểm tra Wake-on-LAN / Sleep prevention | Không triển khai trong `rc.7` (để dành Phase 6.5) | `[ ]` |
| **F03** | Kiểm tra hỗ trợ Android APK | Có tài liệu hợp đồng API rõ ràng; chưa build code Android trong repo | `[ ]` |
| **F04** | `UI-BACKLOG-01` (Vinyl rotation during Remote Playback) | Còn nguyên trong backlog `AGENTS.md` / `.ai-context/`, chưa sửa giao diện Now Playing ở Phase 6.3 | `[ ]` |
| **F05** | `UI-BACKLOG-02` (Source-Aware Main Library) | Còn nguyên trong backlog, trang Thư viện chính không bị xáo trộn ngoài phạm vi | `[ ]` |
| **F06** | `UI-BACKLOG-03` (Lightweight Host Resource Gauges) | Còn nguyên trong backlog cho Phase 7.4 | `[ ]` |
| **F07** | `UI-BACKLOG-04` (Minimalist Server UI Redesign) | Còn nguyên trong backlog cho Phase 7.4 (chỉ thêm điều khiển tối thiểu ở `ServerPage.tsx`) | `[ ]` |
| **F08** | `UI-BACKLOG-05` (Lyrics compatibility & synchronization investigation) | Còn nguyên trong backlog cho Phase 7.3 | `[ ]` |
| **F09** | Kiểm tra `User Guide` tích hợp & `docs/USER_GUIDE.md` | Chương 13 cập nhật đồng bộ (`docs:sync -- --check` PASS) | `[ ]` |
| **F10** | Kiểm tra bản đóng gói `release/v1.0.0-rc.7/` & giữ nguyên `rc.1..rc.6` | Toàn bộ installer, portable EXE, ZIP, SHA256SUMS đầy đủ, `rc.1..rc.6` nguyên vẹn | `[ ]` |
