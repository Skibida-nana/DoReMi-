# DoReMi Phase 6.3 — Remote HTTPS, Tailscale Funnel & Transport Abstraction Architecture

**Phiên bản áp dụng**: `DoReMi v1.0.0-rc.7` · **SQLite Schema**: `v10` · **API Prefix**: `/doremi-connect/api/v1`

---

## 1. Mục tiêu kiến trúc & Nguyên tắc bất biến

Phase 6.3 mở rộng **DoReMi Connect** từ phạm vi mạng nội bộ (**LAN Direct**) sang truy cập từ xa an toàn qua Internet (**Remote HTTPS**), phục vụ hai ràng buộc dài hạn:

1. **Zero-VPN Client Requirement**: Thiết bị **Client** (máy Windows khác mạng hoặc ứng dụng Android single-APK trong tương lai) kết nối trực tiếp tới đường truyền HTTPS chuẩn công cộng, **không cần cài đặt Tailscale hay bất kỳ ứng dụng VPN nào**.
2. **Replaceable Transport Layer (`RemoteTransportProvider`)**: Máy **Host Windows** đóng gói toàn bộ cơ chế mở đường hầm ra Internet sau giao diện trừu tượng `RemoteTransportProvider` (`tailscale-funnel` là provider đầu tiên), cho phép thay thế/mở rộng provider mà không đụng tới Logic chia sẻ thư viện, xác thực thiết bị hay bộ giải mã/stream âm thanh.
3. **Bảo toàn 100% LAN Direct, Offline First & Original Audio Integrity**: Không chuyển mã ép buộc, không tải file nhạc lên Cloud, không tự động fallback âm thầm giữa LAN và Remote.

---

## 2. Sơ đồ kiến trúc tổng thể

```text
+----------------------- REMOTE CLIENT (Outside Home Network) -----------------------+
|  DoReMi Windows / Future Android APK (NO Tailscale / NO VPN installed)              |
|  1. Explicit transport selector: 'lan-direct' | 'remote-https'                      |
|  2. Verifies ECDSA P-256 signed RemoteEndpointDescriptorV1 locally                  |
|  3. Connects HTTPS (rejectUnauthorized: true, public CA, 3xx redirects blocked)     |
|  4. Runs POST /remote/verify-host (nonce) & checks RemoteHostIdentityProofV1        |
|  5. Sends scoped Remote Bearer Token (r1.<deviceId>.<secret>) ONLY after step 4    |
+-----------------------------------------+-------------------------------------------+
                                          | Public TLS 443 / 8443 / 10000
                                          v
+---------------------- TAILSCALE EDGE & HOST NODE (Windows Home PC) -----------------+
|  Tailscale Funnel (Public HTTPS cert by Let's Encrypt, AllowFunnel: true)           |
|  Mounts strictly `--set-path=/doremi-connect` -> preserves prefix on proxy requests |
|  -> proxies ONLY to http://127.0.0.1:<ephemeralGatewayPort>                         |
+-----------------------------------------+-------------------------------------------+
                                          | 127.0.0.1 HTTP Loopback (Private to PC)
                                          v
+------------------------- DOREMI MAIN PROCESS (Electron) ----------------------------+
|  RemoteGatewayService (127.0.0.1 loopback only)                                     |
|   - Strips X-Forwarded-* / Tailscale-User-* headers                                 |
|   - Rejects %2e / %2f / .. path traversal (400) & non-GET/HEAD/POST methods (405)   |
|   - Blocks /enrollment, /remote/provision, /auth/rotate-token, /admin, /diagnostics |
|   - Rate-limits unauthenticated probes & /remote/verify-host challenges             |
|   -> delegates allowed playback/library routes to shared ConnectHostService         |
|                                                                                     |
|  ConnectHostService (LAN Port + Auth + ResourceBudget + AudioStreamingService)      |
|   - LAN TLS (self-signed SPKI pinned): Pairing, /remote/provision, LAN auth/streams |
|   - Auth Service: isolates LAN tokens (lan.*) vs Remote tokens (r1.<devId>.*)       |
|   - Direct Streaming + HTTP 206 Byte-Range (x-doremi-transfer-mode: direct-original)|
+-------------------------------------------------------------------------------------+
```

---

## 3. Phân lớp & Thành phần mới trong Phase 6.3

| Thành phần | Tệp nguồn | Vai trò chính |
|---|---|---|
| Remote Contracts | `src/shared/contracts/connect-remote.ts` | Hằng số mount `/doremi-connect`, cổng `443/8443/10000`, prefix `r1.`, chuẩn hóa `validateRemoteHttpsOrigin`, `isValidTailscaleFunnelHostname`, canonical signing input |
| Remote Trust Crypto | `src/main/services/connect/remote-trust.ts` | Ký & xác minh `RemoteEndpointDescriptorV1` và `RemoteHostIdentityProofV1` bằng khóa ECDSA P-256 (DER SPKI SHA-256 pinned identity) |
| Safe Tailscale CLI | `src/main/services/connect/tailscale-cli.ts` | `SafeTailscaleCliExecutor`: `shell: false`, chỉ đọc binary chính thức trên Windows, kiểm soát timeout/size/redaction, parser JSON status & conflict ports |
| Funnel Provider | `src/main/services/connect/tailscale-funnel-provider.ts` | Triển khai `RemoteTransportProvider`: kiểm tra sẵn sàng (`>= 1.52.0`, MagicDNS, HTTPS Certs, ACL `funnel`), chống xung đột Serve riêng tư, sở hữu & dọn đúng route DoReMi |
| Remote Gateway | `src/main/services/connect/remote-gateway-service.ts` | HTTP server loopback `127.0.0.1` chuyên biệt cho lưu lượng công cộng từ Funnel; allowlist chặt chẽ & tách biệt hoàn toàn khỏi bề mặt LAN Admin/Pairing |
| Auth & Budget | `device-auth-service.ts`, `resource-budget.ts` | Phân lập token `r1.*` theo từng thiết bị (`remoteAccessEnabled` mặc định OFF), grace period 60s khi gián đoạn xoay vòng token, `MAX_CONCURRENT_STREAMS_PER_DEVICE = 4` + abort theo transport `remote-https` |
| SQLite Schema v10 | `src/main/database/migrations.ts`, `connect-repository.ts` | Lưu remote config, route ownership (`remote_owned_route_json`), endpoint generation, quyền `remote_access_enabled`, salted hash/salt remote token, và association trên `connect_remembered_hosts` |

---

## 4. Cô lập Bề mặt Tấn công & Tách bạch Token

### 4.1 Route Allowlist trên Remote Gateway
Các endpoint nhạy cảm **bị từ chối cứng (`403 Forbidden`)** trên `RemoteGatewayService` (chỉ được phép gọi qua LAN TLS đã pin chứng chỉ):
- `POST /api/v1/enrollment/*` và mọi thao tác ghép nối mới
- `POST /api/v1/remote/provision` (cấp Descriptor + Remote Token đầu tiên)
- `POST /api/v1/auth/rotate-token` (xoay vòng token LAN)
- `/api/v1/admin/*`, `/api/v1/diagnostics/*`

Các endpoint được phép trên Remote Gateway:
- Unauthenticated (bị rate-limit theo IP): `GET /capabilities`, `POST /remote/verify-host`
- Yêu cầu scoped Remote Bearer Token (`r1.<deviceId>.<secret>`) & thiết bị có `remoteAccessEnabled === true`:
  - `GET /library/summary`, `GET /library/tracks`, `GET /library/tracks/:id`, `GET /library/tracks/:id/lyrics`, `GET /library/albums`, `GET /library/artists`
  - `GET`/`HEAD` `/stream/tracks/:id` (Direct Byte-Range, giữ nguyên header `x-doremi-transfer-mode: direct-original`)
  - `GET` `/artwork/:id`
  - `POST` `/auth/rotate-remote-token`

### 4.2 Tách token LAN vs Remote
- **LAN token** không có tiền tố `r1.` -> `verifyRemoteBearerToken()` từ chối trên Remote Gateway.
- **Remote token** mang cấu trúc `r1.<deviceId>.<secret>` -> `verifyBearerToken()` từ chối trên cổng LAN Direct.
- Khi Host thu hồi quyền `Remote Access` (`setDeviceRemoteAccess(deviceId, false)`) hoặc tắt `disableRemoteAccess()`, mọi stream gắn nhãn `remote-https` của thiết bị/toàn bộ thiết bị bị đóng tức thì qua `abortRemoteStreamsForDevice` / `abortAllRemoteStreams`, còn kết nối **LAN Direct vẫn hoạt động bình thường**.

---

## 5. Khẩu phần dữ liệu SQLite `v10` & Khả năng nâng cấp an toàn

Migration `010_phase63_remote_https_access`:
- Tự động tạo bản backup `library.db.backup-...` trước khi chạy `ALTER TABLE` trên DB cũ (`rc.6 v9`).
- Mở rộng `connect_host_config`: `remote_provider`, `remote_public_port` (`443`), `remote_mount_path` (`'/doremi-connect'`), `remote_endpoint_generation` (`1`), `remote_owned_route_json`, `remote_user_acknowledged`.
- Mở rộng `connect_authorized_devices`: `remote_access_enabled` (default `0`), `remote_token_hash`, `remote_token_salt`, `remote_granted_at`.
- Mở rộng `connect_remembered_hosts`: `preferred_transport` (default `'lan-direct'`), `remote_descriptor_json`, `remote_credential_ref`, `last_remote_connected_at`.

---

## 6. Hợp đồng tương thích Android Single-APK (Future Mobile Client Contract)

Thiết kế Phase 6.3 đảm bảo ứng dụng Android trong tương lai chỉ cần triển khai đúng hợp đồng sau bằng Kotlin/Android HTTP stack chuẩn, **không cần Tailscale APK hoặc VPN service**:

1. **Discovery & Pairing (trong mạng LAN)**: Nhận cấu hình ghép nối LAN `doremi-pair` v1 + gọi `POST /api/v1/remote/provision` qua LAN Pinned TLS để lấy `RemoteProvisioningBundleDto` (`descriptor` JSON + `remoteToken` dạng `r1.*` lưu trong Android Keystore).
2. **Xác minh offline Descriptor**: Kiểm tra chữ ký ECDSA P-256 trên `buildRemoteEndpointDescriptorSigningInput(descriptor)` khớp với `pinnedFingerprintSha256` đã pin của Host và `publicOrigin` dùng `https://` hợp lệ (không IP private/credentials/redirect).
3. **Handshake trước khi gửi Token**:
   - Dùng `HttpsURLConnection` / `OkHttp` mặc định hệ thống Android **bật kiểm chứng CA công cộng** và **tắt tự động follow redirect (3xx)**.
   - Gửi `POST <publicOrigin>/doremi-connect/api/v1/remote/verify-host` kèm `clientNonce` (>= 16 ký tự).
   - Xác minh chữ ký `RemoteHostIdentityProofV1` khớp `hostId`, `publicOrigin`, `apiBasePath`, `generation >= minGeneration`, `clientNonce`, chưa quá hạn (`expiresAt`) và khóa công khai SPKI trùng `pinnedFingerprintSha256`.
4. **Streaming & Artwork**:
   - Mọi request thư viện/artwork/stream gửi `Authorization: Bearer r1.<deviceId>.<secret>`.
   - Dùng trực tiếp `GET/HEAD /doremi-connect/api/v1/stream/tracks/:id` với header `Range: bytes=...` chuẩn HTTP 206 cho Media3 / ExoPlayer / bộ giải mã ALAC cục bộ trên Android.
5. **Xoay vòng Token định kỳ**: Gọi `POST /doremi-connect/api/v1/auth/rotate-remote-token` để nhận `remoteToken` mới mà không mất kết nối lâu dài.
