# DoReMi Personal Hybrid Server — Kiến trúc Bảo mật, Threat Model & Hợp đồng Tương lai (Phase 6.2)

**Phiên bản áp dụng**: Phase 6.2 (`1.0.0-rc.6`)  
**Trạng thái**: Foundation LAN Direct (Active) · Remote HTTPS via Tailscale Funnel (Phase 6.3 Contract) · Single-APK Android Client (Future Contract)

---

## 1. Threat Model cho Máy chủ Nhạc Cá nhân Self-Hosted (17 Mối đe dọa)

> Lưu ý trung thực: Mạng LAN nội bộ **không** mặc định đáng tin cậy; mọi thiết bị trên cùng Wi-Fi đều phải đi qua xác minh danh tính mật mã Host và cấp phép theo từng thiết bị. DoReMi không tuyên bố miễn nhiễm mọi dạng tấn công (ví dụ mã độc có toàn quyền tài khoản Windows đang đăng nhập).

| ID | Mối đe dọa & Bề mặt tấn công | Bảo vệ hiện có (`6.1–6.1.3`) | Bổ sung Phase `6.2` | Kiểm thử (`tests/`) | Giới hạn còn lại | Pha |
|---|---|---|---|---|---|---|
| **T01** | Thiết bị lạ cùng Wi-Fi truy cập thư viện/âm thanh (`/library/*`, `/stream/*`) | Bearer token per-device salted SHA-256 + `timingSafeEqual`; mặc định Host OFF | Ràng buộc rate limit auth + ghi nhật ký `auth_failed` | `phase61-*`, `phase62-*` | Dựa trên bảo mật khóa Bearer trong phiên TLS | 6.2 |
| **T02** | Thiết bị giả mạo làm máy Host trên LAN (ARP/DNS/IP spoof) | ECDSA P-256 self-signed cert + kiểm tra SPKI SHA-256 trong `secureConnect` | Chặn chuyển hướng HTTP 3xx; đối chiếu chéo `hostId` + full fingerprint khi QR pairing | `phase62-*` (fake TLS host) | Kiểm tra thủ công short fingerprint phụ thuộc độ cẩn thận người dùng nếu không quét QR | 6.2 |
| **T03** | Nghe lén thụ động / chặn bắt chủ động trên Wi-Fi | HTTPS TLS >= 1.2 + SPKI SHA-256 pinning | Chứng minh integration 0 byte HTTP/token gửi đi nếu SPKI sai | `phase62-*` | Không bảo vệ nếu thiết bị bị cài phần mềm gián điệp ở mức OS | 6.2 |
| **T04** | Bắt trộm hoặc dùng lại lời mời ghép nối đã sử dụng (Replay) | `clientNonce` tracking + `inv.used = true` ngay khi nhận | Đánh dấu trạng thái tường minh `ACTIVE/CONSUMED/CANCELED/EXPIRED`, vô hiệu request cũ khi tái tạo/hủy lời mời | `phase62-*` | Nếu kẻ tấn công chặn trước khi nạn nhân dùng (không có HTTPS pin) sẽ fail pin; QR chứa full pin | 6.2 |
| **T05** | Dò vét mã mời ghép nối (Brute-force `inviteCode` hoặc `pollToken`) | Lockout IP 60s sau 5 lần sai mã mời | Thêm rate limit cho `/enrollment/requests/:id` (`pollToken`), bound map `<= 512` buckets chống phình RAM | `phase62-*` | Rate limit theo IP trong LAN NAT dùng chung router có thể khóa tạm chung NAT IP trong 60s | 6.2 |
| **T06** | Đánh cắp token thiết bị từ Client | DPAPI `safeStorage` trong `secrets.json`, tách khỏi SQLite | Thêm cơ chế thu hồi tức thì + xoay/thay thế token (`POST /auth/rotate-token`) vô hiệu token cũ | `phase62-*` | Windows DPAPI không chống được tiến trình độc hại chạy cùng user Windows đang đăng nhập | 6.2 |
| **T07** | Yêu cầu API dị dạng, kích thước quá lớn, path/trackId giả mạo | `readBoundedJsonBody` (32 KB), `isValidTrackUuid`, `405`/`416` | Từ chối header/JSON timeout 10s; lọc strictly unknown routes & control chars | `phase61-*`, `phase62-*` | Phụ thuộc Node HTTPS parser chuẩn cho HTTP/1.1 framing | 6.2 |
| **T08** | Truy cập trái phép thư mục không chia sẻ / ngoài thư viện | `SharedFilesystemGuard` (`fs.realpath`, `normalize`, `fstat` handle) | Mở rộng regression test Windows path traversal, encoded `..%2f`, UNC, junction/symlink & unshared root | `phase62-*`, `phase45c-*` | Hardlink trong cùng NTFS volume trỏ tới file chia sẻ chịu quyền OS | 6.2 |
| **T09** | Ngập lụt request (Request Flooding) | `ResourceBudgetManager` global/per-device | Thêm slot limit + rate limit lên `/capabilities`, `/enrollment/*` và failed auth | `phase62-*` | Không chống được UDP/TCP SYN flood tầng mạng trước khi vào Node | 6.2 / OS Firewall |
| **T10** | Request `/artwork` làm chết đói luồng âm thanh `/stream/*` | Làn `'artwork'` tách biệt + Client semaphore `4` + lazy img (6.1.2) | Bảo toàn nguyên vẹn kiến trúc tách làn và kiểm thử hồi quy trộn tải | `phase612-*`, `phase62-*` | Giữ cân bằng 16/48/3 | 6.2 |
| **T11** | Client chậm / bỏ kết nối chiếm hết slot `maxActiveClients` | `maxActiveClients = 3`, đóng socket khi stop/revoke | TCP keepAlive `15s` phát hiện peer chết + cleanup handle/timer; **bảo toàn Pause >= 30s** | `phase612-*`, `phase62-*` | 3 kết nối thực sự đang mở giữ slot tới khi đóng/thu hồi hoặc mất kết nối OS | 6.2 |
| **T12** | Client thường gọi thao tác quản trị Host (bật/tắt, duyệt máy, thu hồi) | Tách hoàn toàn IPC Main Electron khỏi HTTP API v1 | Audit chứng minh 0 route quản trị trên HTTP; Renderer kiểm tra `assertTrustedSender` | `phase62-*` | Chỉ tiến trình Electron cùng máy Host mới gọi được IPC quản trị | 6.2 |
| **T13** | Rò rỉ token / mã mời / khóa bí mật qua file log / Diagnostic Export | Ring buffer không lưu Authorization/path | Kiểm tra và test tự động chặn `inviteCode`, `pairingPayload`, `token`, `privateKey` khỏi Diagnostics & Console | `phase62-*` | Crash stack ngoài tầm kiểm soát có thể chứa message hệ thống không thuộc secret | 6.2 |
| **T14** | Rò rỉ khóa Host hoặc token qua bản sao lưu `library.db` | `secrets.json` tách khỏi SQLite `library.db` | Xác nhận `db.backup()` chỉ chứa hash muối (`token_hash`), không chứa token dùng được hay private key | `phase62-*` | Restore sang máy khác buộc ghép nối lại vì private key & DPAPI gắn với máy gốc | 6.2 |
| **T15** | Chứng chỉ Host thay đổi bất ngờ (Key/Cert replacement) | `probeHost` báo `HOST_IDENTITY_MISMATCH` | Chặn tuyệt đối gửi credential cũ/tự động ghi đè pin khi mismatch; yêu cầu xác minh lại rõ ràng | `phase62-*` | Người dùng phải đọc cảnh báo và xác nhận lại | 6.2 |
| **T16** | Lộ cổng / API khi mở Remote HTTPS Tunnel công cộng | LAN listener chỉ bind Private IP / `127.0.0.1` | Tài liệu ranh giới Phase 6.3: Tunnel tắt mặc định; mọi request phải qua auth + cấm mở `/enrollment` công khai mặc định | Audit & Config test | Chưa kích hoạt Tunnel thực tế ở Phase 6.2 | **6.3** |
| **T17** | Payload QR độc hại, quá lớn, chứa URL scheme lạ (`javascript:`, `http:`) hoặc JSON biến dị | Chưa có ở 6.1 | `parseAndValidatePairingPayload`: giới hạn `<= 2048 B`, whitelist `'doremi-pair'` v1, LAN endpoint, full SPKI format | `phase62-*` | Phụ thuộc ứng dụng người dùng dùng màn hình ghép nối DoReMi (hệ điều hành/camera ngoài có thể đọc thô URL khác) | 6.2 |

---

## 2. Hợp đồng Ranh giới Bảo mật Remote HTTPS cho Phase 6.3 (Tailscale Funnel Candidate)

> **Cảnh báo kiến trúc**: Ở Phase 6.2, **Tailscale Funnel KHÔNG được cài đặt hay kích hoạt**. Máy chủ LAN giữ nguyên phạm vi Private LAN. Tài liệu này là hợp đồng bắt buộc cho Phase 6.3:

1. **Khác biệt giữa TLS Pinning (LAN Direct) và Edge-Terminated HTTPS (Tunnel)**:
   - Trong LAN Direct, kết nối TLS đi trực tiếp tới chứng chỉ ECDSA P-256 của Host -> kiểm tra `SPKI SHA-256` trên leaf cert là chính xác tuyệt đối.
   - Khi đi qua Remote HTTPS Provider (như Tailscale Funnel), kết nối TLS công cộng thường kết thúc (terminate) tại hạ tầng biên của provider bằng chứng chỉ công cộng (Let's Encrypt / ACME) chứ **không** trình chứng chỉ tự ký của Host.
   - **Cấm tuyệt đối**: Không chấp nhận bất kỳ chứng chỉ công cộng hợp lệ nào làm bằng chứng thay thế danh tính Host; cũng không tự động hạ cấp về HTTP/TLS không kiểm chứng khi mất LAN pin.
2. **Xác minh 2 lớp cho Remote HTTPS (Host Binding)**:
   - Remote Client phải xác minh **cả hai**: (a) HTTPS TLS hợp lệ tới đúng hostname đích đã gắn cho Host, **VÀ** (b) thách thức/xác nhận danh tính mật mã ứng dụng gắn với `hostId` & `hostIdentityPublicFingerprint` (ví dụ chữ ký challenge bằng Host private key hoặc signed identity statement qua kênh nội bộ) trước khi gửi Bearer token thiết bị.
3. **Bảo vệ Endpoint & Header nội bộ**:
   - Listener nhận từ Tunnel chỉ bind `127.0.0.1` với shared loopback header/socket check chống giả mạo `X-Forwarded-For` / `Host` header.
   - Endpoint ghép nối công khai (`/enrollment/requests`) mặc định **TẮT** trên Remote Tunnel; mọi truy cập thư viện/âm thanh bắt buộc có Bearer token hợp lệ, tuân thủ cùng `DeviceAuthorizationService` (thu hồi tức thì), `SharedFilesystemGuard`, và rate limit như LAN Direct.

---

## 3. Hợp đồng Single-APK Android Client (Chuẩn bị cho Pha Android)

- **Nguyên tắc không phụ thuộc phần mềm ngoài**: APK Android duy nhất của DoReMi tự xử lý:
  - Giải mã payload QR `doremi-pair` v1 bằng camera tích hợp trong app (không cài app QR thứ ba, không VPN Tailscale Android, không Firebase/Google Login).
  - Giao tiếp HTTPS `/api/v1/*` chuẩn JSON + HTTP `Range: bytes=start-end` (không phụ thuộc IPC Electron hay đường dẫn Windows `C:\...`).
  - Lưu device Bearer token & pinned Host fingerprint trong **Android Keystore / EncryptedSharedPreferences**.
  - Tuân thủ thỏa thuận phiên bản API (`apiVersion: "1"`, `minSupportedApiVersion: "1"`), xử lý chuẩn `401 AUTH_FAILED`, `403 ACCESS_REVOKED`, `409 REPLAY_DETECTED`, `429 RATE_LIMITED`.

---

## 4. Chính sách Lưu trữ Bí mật & Backup/Restore

- Khóa riêng TLS Host (`host.tls.privateKeyPem`) và Bearer tokens Client (`client.host.<hostId>.token`) lưu tách biệt trong `%APPDATA%\Lossless Player\connect\secrets.json` được mã hóa bởi Windows DPAPI (`electron.safeStorage`).
- Trong tiến trình GUI Electron thực tế, nếu `safeStorage` gặp sự cố không khả dụng, DoReMi **tuyệt đối không hạ cấp về plaintext**.
- Sao lưu SQLite (`createDatabaseSnapshotBackup` -> `library.db`) chỉ lưu metadata nhạc, playlist, cấu hình và bảng `connect_authorized_devices` chỉ chứa `token_hash` + `token_salt` (không bao giờ xuất token thật hay khóa riêng). Khi khôi phục sang máy Windows khác, thư viện & lịch sử phát nhạc vẫn nguyên vẹn, còn định danh mật mã Host/thiết bị được tách riêng nên thiết bị cần xác nhận/ghép nối lại an toàn.
