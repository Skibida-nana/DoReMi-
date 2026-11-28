# Báo Cáo Triển Khai — DoReMi Phase 6.2 (`v1.0.0-rc.6`)
## Secure Device Pairing, Identity Management, Access Control & Remote Security Foundation

**Trạng thái phát hành**: `RELEASE CANDIDATE - PENDING PHASE 6.2 USER UAT`  
**Phiên bản**: `1.0.0-rc.6` (`win32 x64`, Electron `45.4.1`, `Node.js` nhúng `v24.22.3`, Host Build `v22.12.0`)  
**Workspace**: `G:\Source code DoReMi` · **Developed by `kamisamao`**

---

## 1. Xác minh Baseline & Phân hệ cô lập ranh giới Pha
- Đã kiểm tra workspace hiện hữu, xác nhận tích hợp đầy đủ **Phase 6.1, 6.1.1, 6.1.2 (`rc.4`)** và **Phase 6.1.3 (`rc.5`)**.
- Tạo điểm khôi phục cục bộ nguyên bản trước khi chỉnh sửa tại `backups/phase-6.1.3-rc5-checkpoint/`.
- Bảo toàn tuyệt đối các bản đóng gói thử nghiệm trước (`release/v1.0.0-rc.1/`..`v1.0.0-rc.5/` & `phase-6.1-win-unpacked/`), dữ liệu SQLite `v9` (`%APPDATA%\Lossless Player`), và tuân thủ ranh giới: **KHÔNG** triển khai Tailscale Funnel (Phase 6.3), Cloud/Firebase, Single-APK Android, hay gộp `UI-BACKLOG-01`/`UI-BACKLOG-02` vào pha này.

## 2. Giao thức Ghép nối QR Có Phiên bản & Kiến trúc Bảo mật
- **Tài liệu Thiết kế & Threat Model**: [`docs/phase-6/PHASE_6.2_SECURITY_ARCHITECTURE.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.2_SECURITY_ARCHITECTURE.md) hệ thống hóa 17 mối đe dọa (`T01–T17`), mô hình tin cậy chuẩn bị cho Phase 6.3 Remote HTTPS (Tailscale Funnel) và hợp đồng tương thích tương lai cho Single-APK Android Client.
- **Hợp đồng Payload (`src/shared/contracts/connect-pairing.ts`)**:
  - Giao thức `doremi-pair` v1 đóng gói JSON chuẩn (`<= 2048` UTF-8 bytes) gồm: `protocol`, `version`, `hostId`, `hostName` (sanitized NFC), `endpoints` (`lan-https` với IPv4 Private RFC 1918 / `localhost`), `identityAlgorithm: 'spki-sha256'`, `identityFingerprint` (đủ 256-bit SHA-256), `invitation` (`XXXX-XXXX-XXXX`), `expiresAt`.
  - Trình phân tích `parseAndValidatePairingPayload` chặn toàn bộ trên cả Main & Renderer: payload vượt `2048 B`, URI schemes ngoài (`http:`, `https:`, `javascript:`, `data:`, `file:`, `vbscript:`, `cmd:`, `powershell:`), khóa prototype pollution (`__proto__`, `constructor`, `prototype`), IP công cộng (`8.8.8.8`), cổng ngoài dải `1024..65535`, vân tay thiếu độ dài, hoặc mã đã quá hạn `expiresAt`.

## 3. Tạo QR Ngoại tuyến & Giải mã QR Cục bộ
- **Thư viện bổ sung (0 lỗ hổng bảo mật)**: `qrcode@1.5.4` (`MIT`, `@types/qrcode@1.5.6`) và `jsqr@1.4.0` (`Apache-2.0`). Kết quả `npm audit --omit=dev --json`: **`0` critical, `0` high, `0` moderate, `0` low** trên 53 prod packages (`486` total).
- **Host ([`device-auth-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/device-auth-service.ts))**: Sinh ảnh SVG QR đồng bộ (`data:image/svg+xml;base64,...`) hoàn toàn offline không cần Internet; giữ nguyên fallback nhập tay 12 ký tự và mDNS LAN Discovery.
- **Client UI ([`ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx))**: Hỗ trợ nút **"Nhập ảnh QR"** giải mã cục bộ 100% qua `<canvas>` + `jsQR` (hỗ trợ `.png/.jpg/.svg`), khung dán JSON `doremi-pair` v1 kèm Preview kiểm chứng Host Name, Endpoints, Full SPKI Fingerprint trước khi mở socket, và nút **"Tải ảnh QR (.png)"** trên Host.

## 4. Vòng đời Mã mời, Giới hạn Chống Brute-Force & Thu hồi Tức thì
- **Vòng đời Mã mời (`InvitationLifecycleState`)**: Quản lý rõ ràng `ACTIVE | PENDING_APPROVAL | CONSUMED | EXPIRED | CANCELED | REJECTED` với `lastInvitationState`.
- **Chống Race & Invalidation ([`device-auth-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/device-auth-service.ts))**:
  - Đặt cờ `inv.used = true` ngay khi khớp mã mời trước khi cấp token hoặc đẩy vào `pendingRequests` (chặn race condition đa luồng dùng chung 1 mã mời).
  - Bấm **Hủy mã mời** hoặc **Tạo mã mới** lập tức vô hiệu hóa toàn bộ các yêu cầu chờ phê duyệt (`pending`) cũ gắn với lời mời trước đó.
  - Đếm ngược thời gian sống (`mm:ss`) thực tế trên UI kèm lớp phủ khóa mờ khi hết hạn hoặc đã sử dụng.
- **Rate Limiting Có Giới Hạn Bộ Nhớ (`<= 512 buckets/map`)**:
  - Giới hạn tốc độ độc lập theo IP/khóa cho: gửi mã mời (`5` lần sai / `120s` -> khóa `60s`), kiểm tra `pollToken` (`8` lần sai / `120s` -> khóa `60s`), và xác thực Bearer token sai (`10` lần sai / `60s` -> khóa `60s`), trả HTTP `429 RATE_LIMITED`.
  - Bảo vệ `/api/v1/capabilities` và `/api/v1/enrollment/requests/*` bằng `ResourceBudgetManager.tryEnterHttpRequest`.
- **Thu hồi Tức thì**: `revokedDeviceIds` trên RAM + cập nhật bền vững SQLite (`auth_state = 'revoked'`) + `budget.abortStreamsForDevice(deviceId)` ngắt stream đang phát và chặn token cũ `403 ACCESS_REVOKED` ngay lập tức (kể cả sau khi khởi động lại Host).

## 5. Xoay vòng Token Thiết bị, Bảo vệ Secret Storage & TLS Pinning
- **Client Token Rotation ([`connect-repository.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-repository.ts), [`host-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-service.ts), [`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts))**:
  - Thêm `POST /api/v1/auth/rotate-token` (khóa single-flight theo `deviceId`) & nút **"Xoay vòng Token"** trên Client (`CONNECT_CLIENT_ROTATE_TOKEN`), ghi secret mới vào vault DPAPI trước khi đổi token hoạt động, đồng thời vô hiệu hóa tức thì `token_hash` cũ trên Host.
- **Fail-Closed OS Secret Protection ([`secret-storage.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/secret-storage.ts), [`host-identity-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/host-identity-service.ts))**:
  - Trong runtime GUI Electron (`ELECTRON_RUN_AS_NODE !== '1'`), mặc định `allowFileFallback = false`: nếu OS DPAPI `safeStorage` không khả dụng, `ConnectSecretStorage` trả `'unavailable'` và từ chối lưu plaintext/file-fallback thay vì âm thầm hạ cấp. Vault JSON hỏng trả `null` an toàn không crash app.
- **TLS SPKI Pinning & Socket Hygiene ([`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts), [`lan-direct-provider.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/lan-direct-provider.ts))**:
  - So sánh `normalizeFullFingerprint(observed)` trên sự kiện `secureConnect` trước khi ghi bất kỳ HTTP byte nào -> `0 byte` lọt sang server giả mạo.
  - Từ chối mọi phản hồi HTTP `3xx` redirect để ngăn rò rỉ Bearer token.
  - Bật TCP keepalive (`15_000ms`), timeout `15_000ms` cho endpoint thường trên Host và giữ timeout `0` cho đường dẫn `/stream/` để bảo toàn pause > 30 giây.
- **Chẩn đoán Bảo mật Sạch**: Ring buffer `recentSecurityEvents` (`<= 64` mục) trên cả Host & Client ghi nhận sự kiện bảo mật, tuyệt đối không ghi `inviteCode`, `pairingPayload`, `deviceToken`, `pollToken`, `privateKeyPem`, hay đường dẫn đĩa nội bộ; `createDatabaseSnapshotBackup` giữ sạch không chứa token hay Private Key.

## 6. Kiểm thử Tự động, Đóng gói & Benchmark Thực tế (`v1.0.0-rc.6`)
- **`npm.cmd run docs:sync -- --check`**: **`PASSED`** (`docs/USER_GUIDE.md` khớp `v1.0.0-rc.6`).
- **`npm.cmd run codecs:verify`**: **`PASSED`** (`manifest.json` OK).
- **`npm.cmd run lint` (`tsc --noEmit`)**: **`PASSED`** (`0` lỗi).
- **`npm.cmd run build`**: **`PASSED`** (`0` cảnh báo bundler; `out/main/index.js` `566.79 kB` + lazy `codec-manager` `122.05 kB`; `out/preload/index.cjs` `17.00 kB`; main renderer `677.38 kB`; lazy `ServerPage` `372.03 kB`).
- **`npm.cmd run test:electron`** (toàn bộ **46 tệp** test với FFmpeg & Foobar2000 encoders): **`214 / 214 PASS, 0 FAIL, 0 SKIP`** (`19,128.04 ms`), gồm 7 bộ integration test chuyên sâu mới trong [`tests/phase62-security-pairing.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase62-security-pairing.test.ts) + toàn bộ regression Phase 6.1, 6.1.1, 6.1.2 (Chromium E2E), 6.1.3 & Local Playback/ALAC/Codec Engine.
- **Benchmark (`qa/logs/phase62-benchmark-latest.json`)**:
  - 10x QR + SVG Data URL: `31.84 ms` (~3.18 ms/lần, RSS `96.04 MB`, Heap `20.55 MB`).
  - 500x kiểm tra & parse Payload QR: `2.82 ms`.
  - Enroll QR End-to-End + Pinned Connect: `24.90 ms`.
  - 5x Token Rotation qua TLS: `23.89 ms`.
  - 20x Flood Brute-Force + Rate Limit: `27.19 ms`, RSS `98.71 MB`.
- **Đóng gói & Smoke (`release/v1.0.0-rc.6/`)**:
  - `DoReMi-1.0.0-rc.6-x64-portable.exe` (SHA-256: `6f45df0b...256e319`), `DoReMi-1.0.0-rc.6-x64-portable.zip` (`b2ffe4b4...9ec2da`), `DoReMi-1.0.0-rc.6-x64-setup.exe` (`7b99cbb5...afb22a6`), `win-unpacked/DoReMi.exe`, `SHA256SUMS.txt`.
  - `smoke:electron` Dev (`packaged=false`) và Packaged `release/v1.0.0-rc.6/win-unpacked/DoReMi.exe` (`packaged=true`) đều **`OK`** (`rootChildren=2, diagLogs=1`).
- **Nghiệm thu thực địa 2 máy Windows (`53` mục Groups A–E)**: **`NOT RUN / PENDING USER UAT`** theo [`docs/phase-6/PHASE_6.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.2_WINDOWS_UAT.md).
