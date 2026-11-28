# DoReMi Phase 6.3 — Security Architecture & Findings Review

**Phạm vi đánh giá**: Tích hợp Tailscale Funnel, `RemoteGatewayService`, xác thực Host qua TLS công cộng, phân tách token `r1.*` vs `lan`, đồng bộ `RemoteEndpointDescriptorV1` và các endpoint HTTP mới trong `DoReMi v1.0.0-rc.7`.

---

## 1. Tóm tắt Kiểm soát Bảo mật (Implemented Controls)

| Lớp bảo vệ | Cơ chế triển khai | Trạng thái |
|---|---|---|
| CLI Execution Boundary | `SafeTailscaleCliExecutor`: `shell: false`, chỉ đọc `Program Files` / `WindowsApps`, chặn `\r`/`\n`/`\0` trong tham số, timeout (`6s`/`15s`), cắt giới hạn stdout/stderr (`256 KB`), redaction log | Đã triển khai & test `Provider-1` |
| Tailscale Readiness Gate | Bắt buộc phiên bản `>= 1.52.0`, `BackendState === 'Running'`, `MagicDNSEnabled === true`, có `CertDomains`, và ACL có `tailscale.com/cap/funnel` | Đã triển khai & test `Provider-2` |
| Non-Destructive Routing | Kiểm tra `Web[host:port]` & `AllowFunnel`: từ chối ghi đè dịch vụ Serve nội bộ (`AllowFunnel === false`) hoặc mount path khác; chỉ mở/gỡ đúng route DoReMi `/doremi-connect` qua `remote_owned_route_json`, **cấm tuyệt đối `tailscale funnel reset`**; tự kiểm tra & thu hồi route mồ côi khi khởi động | Đã triển khai & test `Provider-3`, `Provider-4` |
| Loopback Gateway Isolation | `RemoteGatewayService` chỉ bind `127.0.0.1` (cổng ngẫu nhiên `0`), tách biệt cổng vật lý với `ConnectHostService` LAN TLS | Đã triển khai & test `Security-C` |
| Public Route Allowlist | Chặn cứng (`403`) `/enrollment/*`, `/remote/provision`, `/auth/rotate-token`, `/admin/*`, `/diagnostics/*`; chặn phương thức không nằm trong `GET`/`HEAD`/`POST` (`405`); chặn `%2e`, `%2f`, `%5c`, `..` (`400`) | Đã triển khai & test `Security-F` |
| Spoofed Proxy Header Stripping | Xóa `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Tailscale-User-*` tại cổng vào Gateway; không tin tưởng identity dựa trên header proxy | Đã triển khai & test `Security-F` |
| Host Identity & Endpoint Verification | `RemoteEndpointDescriptorV1` + `RemoteHostIdentityProofV1` ký bằng ECDSA P-256 của khóa TLS pinned Host (`SPKI SHA-256`); kiểm tra khớp `publicOrigin`, `apiBasePath`, `generation`, `clientNonce`, `expiresAt` **trước** khi gửi token | Đã triển khai & test `Security-A/B/C/D` |
| Public TLS Strict Verification | Client Remote HTTPS dùng `rejectUnauthorized: true` theo Public Trust Store (không dùng `rejectUnauthorized: false` trừ test CA cô lập), chặn HTTP `3xx` redirects và validate `https://` origin không chứa userinfo/private IP | Đã triển khai & test `Security-D` |
| Scoped Token Isolation | LAN token (`verifyBearerToken`) từ chối `r1.*`; Remote token (`verifyRemoteBearerToken`) yêu cầu prefix `r1.<deviceId>.<secret>` + thiết bị `remoteAccessEnabled = 1`; thu hồi `remoteAccessEnabled` ngắt tức thì stream Remote nhưng **giữ nguyên LAN** | Đã triển khai & test `Security-E`, `Security-G` |
| Brute-Force & Stream Budgets | Bounded rate limit (`<= 512` IP buckets) tách riêng cho `/capabilities`, `/remote/verify-host`, và failed Bearer attempts (`429`); giới hạn `<= 4` stream/thiết bị tự loại bỏ socket mồ côi cũ | Đã triển khai & test `Security-G` |

---

## 2. Phân loại Phát hiện Kiểm tra (Findings Classification)

> Không còn tồn tại bất kỳ lỗ hổng `CRITICAL` hoặc `HIGH` chưa xử lý trong mã nguồn `rc.7`. Các rủi ro thiết kế đã được xử lý triệt để ngay trong giai đoạn cài đặt và khóa lại bằng test tự động.

| ID | Mức độ | Mô tả mối nguy & Đường tấn công | Biện pháp xử lý trong `rc.7` | Trạng thái |
|---|---|---|---|---|
| **SEC-P63-01** | `CRITICAL` *(Đã xử lý)* | **Lộ bề mặt Pairing/Admin ra Internet công cộng**: Nếu Funnel trỏ thẳng vào cổng `ConnectHostService` chính, kẻ tấn công Internet có thể thử dò mã mời (`/enrollment`), xoay token LAN hoặc gọi API nội bộ. | Tách `RemoteGatewayService` loopback riêng biệt chỉ phục vụ danh sách allowlist an toàn; chặn tường lửa logic (`403`) toàn bộ `/enrollment`, `/remote/provision`, `/admin`, `/diagnostics`, `/auth/rotate-token`. | **MITIGATED** |
| **SEC-P63-02** | `CRITICAL` *(Đã xử lý)* | **Phá hủy cấu hình Tailscale Serve nội bộ của người dùng**: Nếu gọi `tailscale funnel reset` hoặc `--https=443` đè lên port đang phục vụ ứng dụng riêng tư, có thể vô tình công khai dịch vụ riêng ra Internet hoặc xóa cấu hình người dùng. | Kiểm tra `funnel status --json` trước khi kích hoạt, từ chối đụng cổng đang chạy `AllowFunnel === false` hoặc route không thuộc DoReMi; lưu `remote_owned_route_json` để chỉ gỡ đúng `/doremi-connect`; đối soát route mồ côi lúc khởi động. | **MITIGATED** |
| **SEC-P63-03** | `HIGH` *(Đã xử lý)* | **Lộ Bearer Token nếu MITM/CDN/Redirect trỏ sai máy chủ**: Client tin tưởng mù quáng vào DNS hoặc gửi `Authorization` trước khi xác minh Host thực sự sở hữu khóa bí mật đã ghép nối. | Client chỉ gửi `Bearer r1.*` **sau khi** TLS CA công cộng hợp lệ (`rejectUnauthorized: true`, chặn `3xx`), AND `POST /remote/verify-host` trả về chữ ký ECDSA P-256 hợp lệ khớp SPKI đã ghim và `clientNonce`. | **MITIGATED** |
| **SEC-P63-04** | `HIGH` *(Đã xử lý)* | **Rò rỉ LAN Token qua Internet hoặc ngược lại**: Dùng chung một token cho cả LAN và Remote dẫn tới nếu token Remote bị lộ hay bị tắt Remote, kết nối LAN bị ảnh hưởng (hoặc kẻ giữ token LAN truy cập qua Internet). | Tách hoàn toàn hàm băm/salt `token_hash` (LAN) và `remote_token_hash` (`r1.<deviceId>.<secret>`); từ chối chéo giữa hai cổng; bật Remote Token chỉ khi `remoteAccessEnabled = 1`. | **MITIGATED** |
| **SEC-P63-05** | `HIGH` *(Đã xử lý)* | **Command Injection qua đường dẫn hoặc tham số Tailscale CLI**: Gọi CLI qua shell hoặc ghép chuỗi tham số không lọc. | Dùng `execFile(..., { shell: false })`, chỉ chấp nhận binary tại đường dẫn chính thức trên Windows, kiểm tra tham số không chứa ký tự xuống dòng/`\0`, chỉ cho phép public port thuộc `[443, 8443, 10000]` và mount path `/doremi-connect`. | **MITIGATED** |
| **SEC-P63-06** | `MEDIUM` *(Đã xử lý)* | **Treo cổng Gateway khi `disableRemoteAccess` hoặc dọn route thất bại / mất token khi rớt mạng lúc rotate**: Nếu lỗi dọn CLI để lại Gateway mở hoặc mất token mới khi rotation rớt mạng giữa chừng. | Nếu cleanup provider báo lỗi khi tắt, `RemoteGatewayService` vẫn đóng socket trước (`gatewayPort -> null`, giữ log lỗi để cảnh báo); thêm grace window `60s` trên token trước khi xoay vòng để client thử lại an toàn. | **MITIGATED** |
| **SEC-P63-07** | `LOW` | **Chiếm slot stream khi Client Internet rớt mạng đột ngột (Half-open TCP)**: Socket cũ chưa kịp `close` khiến request kế tiếp dính `429 CONCURRENCY_LIMIT`. | Khi đạt ngưỡng `MAX_CONCURRENT_STREAMS_PER_DEVICE = 4` cho thiết bị Remote, ưu tiên thu hồi socket mồ côi cũ nhất quá 8s trước khi trả 429; dọn socket không hoạt động định kỳ. | **MITIGATED** |
| **SEC-P63-08** | `INFORMATIONAL` | **Chứng thực phụ thuộc kết quả thực tế với `tailscale.exe` thật**: Máy build thiếu binary Tailscale nên mọi test tự động dùng Mock CLI + CA TLS proxy nội bộ. | Đã ghi rõ phạm vi trong Security Review, Setup Guide (`PHASE_6.3_FUNNEL_SETUP.md`), UAT Group E, và Báo cáo cuối Phase 6.3 (`NOT RUN` với Funnel thật). | **TRACKED** |
