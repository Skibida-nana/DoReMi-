# Báo Cáo Triển Khai — DoReMi Phase 6.3 (`v1.0.0-rc.7`)
## Remote HTTPS, Tailscale Funnel Integration, Secure Internet Streaming & Transport Abstraction

**Trạng thái phát hành**: `RELEASE CANDIDATE - AUTOMATED VERIFIED · FUNNEL INTEGRATION NOT RUN · PHYSICAL INTERNET UAT PENDING`  
**Phiên bản**: `1.0.0-rc.7` (`win32 x64`, Electron `45.4.1`, Electron Node `v24.22.3`, Host Node `v22.12.0`)  
**Workspace**: `G:\Source code DoReMi` · **Developed by `kamisamao`**

---

## 1. Executive Summary
- Hoàn tất triển khai **Phase 6.3** trên nền `DoReMi v1.0.0-rc.6`, mở rộng DoReMi Connect hỗ trợ nghe nhạc từ xa qua Internet thông qua **Tailscale Funnel** làm `RemoteTransportProvider` đầu tiên có thể thay thế, **không yêu cầu cài Tailscale hay VPN trên máy Client (Windows / future Android APK)**.
- Toàn bộ bộ kiểm thử tự động đạt **`222 / 222 PASS` (`49` test files, `0 FAIL, 0 SKIP`)**, `tsc --noEmit` đạt `0` lỗi, `npm audit --omit=dev` đạt `0` lỗ hổng, đóng gói thành công `release/v1.0.0-rc.7/` (bảo toàn `rc.1..rc.6`) và `smoke:electron` PASS cả Dev lẫn Packaged.
- **Tuyên bố trung thực về phạm vi ngoài môi trường**: Trên máy build chưa cài `tailscale.exe`, nên kích hoạt **Tailscale Funnel thực tế (`FUNNEL INTEGRATION NOT RUN`)** và **UAT Internet vật lý 2 máy khác mạng (`PHYSICAL INTERNET UAT PENDING`)** chưa chạy trên phần cứng thật và cần nghiệm thu theo [`PHASE_6.3_FUNNEL_SETUP.md`](./PHASE_6.3_FUNNEL_SETUP.md) & [`PHASE_6.3_WINDOWS_UAT.md`](./PHASE_6.3_WINDOWS_UAT.md).

## 2. Verified Phase 6.2 (`rc.6`) Baseline & Preservation Confirmation
- Kiểm tra toàn bộ mã nguồn, `.ai-context/`, `tests/`, `docs/phase-6/`, và tạo điểm khôi phục nguyên bản tại `backups/phase-6.2-rc6-checkpoint/` trước khi chỉnh sửa.
- Toàn bộ chức năng Phase 6.0–6.2 được bảo toàn nguyên vẹn (100% playback offline, QR pairing `doremi-pair` v1, LAN Direct TLS SPKI Pinning, Smart Shuffle, Auto Continue, Auto-Hide Sidebar, Range ALAC WASM, Audio Lab DSP, tìm kiếm Remote Library).

## 3. Research & Official Documentation Findings
- Đối chiếu tài liệu chính thức của Tailscale (`tailscale.com` & `github.com/tailscale/tailscale`):
  - **Tailscale Funnel** khả dụng miễn phí trên **Personal Plan**, yêu cầu Tailscale `>= 1.52.0`, bật **MagicDNS**, bật **HTTPS Certificates**, và có ACL capability `tailscale.com/cap/funnel`.
  - Funnel chỉ hỗ trợ cổng HTTPS công cộng **`443`, `8443`, `10000`**.
  - Lệnh `tailscale funnel --bg --https=<port> --set-path=/doremi-connect http://127.0.0.1:<gwPort>` giữ nguyên tiền tố `--set-path` khi proxy request vào Gateway cục bộ (`RemoteGatewayService` xử lý `/doremi-connect/api/v1/...`).
  - Traffic đi qua Funnel chịu giới hạn băng thông relay phía Tailscale (không tăng được qua cấu hình DoReMi).

## 4. Network Architecture Diagram
- Chi tiết sơ đồ đa lớp xem tại [`docs/phase-6/PHASE_6.3_REMOTE_HTTPS_ARCHITECTURE.md`](./PHASE_6.3_REMOTE_HTTPS_ARCHITECTURE.md) (Client Zero-VPN -> Public TLS 443/8443/10000 -> Tailscale Funnel `/doremi-connect` -> `RemoteGatewayService` `127.0.0.1` allowlist -> `ConnectHostService` shared read-only content + scoped token `r1.*`).

## 5. Architecture & Transport Provider Abstraction
- Tách hợp đồng `RemoteTransportProvider` trong `src/main/services/connect/tailscale-funnel-provider.ts`, tách biệt logic ứng dụng khỏi cơ chế tunnel (`tailscale-funnel` chỉ là provider khởi tạo).
- Tách hai chế độ tường minh `ConnectTransportMode = 'lan-direct' | 'remote-https'` trên `connect-client.ts`, `connect-store-core.ts` và `ServerPage.tsx`.

## 6. Tailscale Funnel Readiness & Detection Implementation
- Triển khai `SafeTailscaleCliExecutor` và `parseTailscaleStatusJson` trong `src/main/services/connect/tailscale-cli.ts`.
- Kiểm tra tuần tự: đường dẫn binary Windows hợp lệ (`Program Files\Tailscale\tailscale.exe`, `WindowsApps`), version `>= 1.52.0`, daemon `BackendState === 'Running'`, đăng nhập tài khoản, `MagicDNSEnabled`, `CertDomains`, và ACL `funnel` capability. Chống treo bằng timeout (`6s`/`15s`), cắt stdout/stderr `<= 256 KB` và bắt lỗi JSON malformed.

## 7. Non-Destructive Route Ownership, Conflict Protection & Lifecycle Safety
- Dùng `inspectServeConfigPorts` kiểm tra `tailscale funnel status --json` trước khi gắn route: từ chối ghi đè nếu cổng chọn đã có rule Tailscale Serve riêng tư (`AllowFunnel === false`) hoặc mount path khác không do DoReMi sở hữu.
- Chỉ đăng ký `--https=<port> --set-path=/doremi-connect http://127.0.0.1:<gwPort>`.
- Lưu `remote_owned_route_json` vào SQLite; tuyệt đối **không** dùng `tailscale funnel reset`. Khi tắt/thoát Host chỉ gỡ đúng route sở hữu; nếu CLI cleanup lỗi vẫn đóng `RemoteGatewayService` ngay và cảnh báo; tự kiểm tra & thu hồi route mồ côi lúc khởi động (`reconcileStaleRemoteRouteIfNeeded`).

## 8. Dedicated Loopback Remote Gateway Service & Strict Route Surface
- Triển khai `RemoteGatewayService` (`src/main/services/connect/remote-gateway-service.ts`) chỉ lắng nghe **`127.0.0.1`** với cổng ephemeral `0`.
- Bề mặt cho phép tối thiểu (`GET /capabilities`, `POST /remote/verify-host`, các API `/library/*`, `/stream/tracks/:id`, `/artwork/:id`, `/auth/rotate-remote-token` khi đã xác thực `r1.*`).
- Chặn cứng `403`: `/enrollment/*`, `/remote/provision`, `/auth/rotate-token`, `/admin/*`, `/diagnostics/*`. Chặn `400` traversal (`%2e`/`%2f`/`%5c`/`..`), chặn `405` phương thức lạ, loại bỏ header proxy giả mạo (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Tailscale-User-*`).

## 9. Signed Remote Endpoint Descriptor Verification
- Định nghĩa `RemoteEndpointDescriptorV1` (`src/shared/contracts/connect-remote.ts`, `src/main/services/connect/remote-trust.ts`) ký bằng khóa ECDSA P-256 của Host (`SPKI SHA-256`).
- Client xác minh chữ ký và khóa công khai SPKI trước khi gửi bất kỳ request xác thực nào; sửa 1 byte trên `publicOrigin` hoặc `generation` đều bị từ chối (`Security-B`).

## 10. Cryptographic Host Identity Verification Challenge-Response
- Trước khi gửi Remote Bearer token, Client gọi `POST /doremi-connect/api/v1/remote/verify-host` kèm `clientNonce`.
- Host trả về `RemoteHostIdentityProofV1` ký ECDSA P-256 ràng buộc `hostId`, `publicOrigin`, `apiBasePath`, `endpointGeneration`, `clientNonce`, `expiresAt`. Client kiểm chứng đầy đủ trước khi gửi token (`Security-C`).

## 11. Scoped Token Separation (`LAN` vs `Remote`) & Per-Device Access Control
- Mở rộng `DeviceAuthService` (`src/main/services/connect/device-auth-service.ts`):
  - Quyền `remoteAccessEnabled` mặc định `false` (`0` trong SQLite `v10`).
  - Token Remote mang định dạng `r1.<deviceId>.<secret>` với `remote_token_hash` + `remote_token_salt` độc lập.
  - `verifyRemoteBearerToken` từ chối token LAN (`403 REMOTE_ACCESS_NOT_GRANTED`), `verifyBearerToken` (LAN) từ chối token `r1.*` (`401`).
  - Tắt `remoteAccessEnabled` chỉ ngắt các stream gắn transport `remote-https` qua `abortRemoteStreamsForDevice` và bảo toàn 100% kết nối LAN Direct của thiết bị đó.

## 12. Strict Public HTTPS Client & No-Silent-Fallback Mode Selection
- Client (`src/main/services/connect/connect-client.ts`) dùng `rejectUnauthorized: true` với Public CA store hệ thống, chặn HTTP `3xx` redirects, xác thực URL `https://` sạch qua `validateRemoteHttpsOrigin`.
- Chọn `lan-direct` hay `remote-https` là tường minh qua `connectToRememberedHost(..., explicitMode)` và `setPreferredTransport`; không âm thầm fallback chéo giữa hai chế độ (chuyển sang Phase 6.4).

## 13. Remote Library Browsing, Playback, ALAC, FLAC, Lyrics & Artwork over HTTPS
- Giữ nguyên luồng stream byte gốc (`x-doremi-transfer-mode: direct-original`) qua `/doremi-connect/api/v1/stream/tracks/:id`, chuyển tiếp `Range` HTTP 206 (`connect-client.ts`), giải mã ALAC 16/24-bit Range WASM trên Client, `FlacByteSource` tương thích ID3-FLAC, lấy lyrics từ xa ẩn `sidecarPath`, và phân lập lane artwork khỏi luồng audio.

## 14. Audio Quality & Original Integrity Verification
- Kiểm chứng SHA-256 byte-per-byte trên `FLAC 16-bit/44.1kHz`, `FLAC 24-bit/96kHz` và `WAV 16-bit` qua Remote HTTPS Proxy khớp **100%** với file gốc trên đĩa Host.
- Kiểm chứng SHA-256 WAV PCM giải mã qua `RemoteAlacStreamManager` (`ALAC16`, `ALAC24_48`, `ALAC_EOF`) và partial seek slice `206` khớp **100%** bit-exact với `AlacStreamManager` cục bộ.

## 15. Offline & Local Playback Preservation
- Đã chạy đầy đủ **49 tệp test** bao gồm Local Playback, Audio Engine, Audio DSP, Library, Playlist, Artwork, Lyrics, Statistics, Codecs — **0 regression (`222/222 PASS`)**.

## 16. Minimal UI Changes & Phase 7 Backlog Preservation
- `ServerPage.tsx` chỉ thêm điều khiển tối thiểu cần cho Phase 6.3: trạng thái sẵn sàng Tailscale Funnel, cổng công cộng (`443`/`8443`/`10000`), checkbox xác nhận công khai Internet, nút Bật/Tắt Remote HTTPS, công tắc `Remote Access` cho từng thiết bị, nút `Đồng bộ Remote qua LAN`, và chọn chế độ `LAN Direct` vs `Remote HTTPS`.
- Không thực hiện 5 hạng mục Phase 7 UI Backlog (`UI-BACKLOG-01`..`05`).

## 17. IPC, Preload, Persistence & Error Handling Verification
- Cập nhật đồng bộ `src/shared/contracts/channels.ts`, `src/shared/types/{connect,ipc}.ts`, `src/preload/index.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/stores/connect-store-core.ts`.
- Toàn bộ IPC mới kiểm chứng `tsc --noEmit` (`0` lỗi) và khởi chạy thực tế trong Electron `45.4.1`.

## 18. Database Schema & Migration Safety (`v9 -> v10`)
- Migration `010_phase63_remote_https_access` (`src/main/database/migrations.ts`) nâng `SQLite` lên **`v10`**, bổ sung cột cho `connect_host_config`, `connect_authorized_devices` và `connect_remembered_hosts`.
- Kiểm thử mới trong `tests/database.test.ts` xác nhận mở DB `RC.6 v9` thực tế **tự động tạo bản backup trước migration** và bảo toàn 100% Host config, shared sources, authorized devices (`remote_access_enabled = 0`) và remembered hosts (`preferred_transport = 'lan-direct'`).

## 19. Build, Packaging & Resource Efficiency Check
- `npm.cmd run lint` (`tsc --noEmit`): **PASS (`0` errors)**.
- `npm.cmd run build`: **PASS** (`main 669.57 kB` + lazy `codec-manager 122.05 kB`, `preload 18.26 kB`, renderer main `677.38 kB` + lazy `ServerPage 384.73 kB`).
- `npm.cmd run dist` & `dist:portable`: **PASS** — xuất ra `release/v1.0.0-rc.7/` và giữ nguyên `v1.0.0-rc.1`..`v1.0.0-rc.6`.

## 20. Packaging Artifact Inventory (`v1.0.0-rc.7`) & SHA-256 Checksums
- Thư mục phát hành: [`release/v1.0.0-rc.7/`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.7/)
  - `DoReMi-1.0.0-rc.7-x64-portable.exe`: `122,223,187` bytes · SHA-256: `6d09ef1f72803ae26c6973ce8a5ee3185b4d62fd3f0d8d0589b218e5ecdb686f`
  - `DoReMi-1.0.0-rc.7-x64-portable.zip`: `170,058,985` bytes · SHA-256: `9cf9eae5130eb794a0509355b9864104256e4239dce5a6b92ed4001cd6dee77d`
  - `DoReMi-1.0.0-rc.7-x64-setup.exe`: `134,621,773` bytes · SHA-256: `e48c97ac6bd36c14f3587206fa83815e3cbba03fdd27ecd2dda316385e6966fa`
  - `DoReMi-1.0.0-rc.7-x64-setup.exe.blockmap`: `141,264` bytes · SHA-256: `6a012ac8f02d84b71b81752ae775441ed5a27095217273797da962e9fac7d0aa`
  - `SHA256SUMS.txt` (`414` bytes) & `win-unpacked/DoReMi.exe`.

## 21. Dev Startup Smoke & Packaged Functional Verification Results
- `npm.cmd run smoke:electron` (Dev): **`OK`** (`packaged=false, electron=45.4.1, rootChildren=2, diagLogs=1`).
- `npm.cmd run smoke:electron -- --exe release\v1.0.0-rc.7\win-unpacked\DoReMi.exe` (Packaged): **`OK`** (`packaged=true, electron=45.4.1, rootChildren=2, diagLogs=1`).
- **Packaged Functional Verification (`verify-packaged-rc7.mjs` trên `DoReMi.exe` đóng gói)**: **`OK`** — xác nhận `resources/app.asar/package.json` = `1.0.0-rc.7`, `out/main/index.js` (`669,573 B`) chứa đủ `6/6` symbol Phase 6.3 (`RemoteGatewayService`, `TailscaleFunnelProvider`, `/doremi-connect`, `remote/verify-host`, `auth/rotate-remote-token`, `010_phase63_remote_https_access`), bundle `ServerPage-BEGxKLma.js` có đủ UI Remote HTTPS, và unpacked `better-sqlite3` thực thi WAL + FK thành công.

## 22. Complete Automated Test Results (`49 Files / 222 Tests`)
- Chạy đầy đủ `npm.cmd run test:electron` với FFmpeg & Foobar2000 encoders sau lần chỉnh sửa mã nguồn cuối:
  - **Kết quả**: **`222 / 222 PASS · 0 FAIL · 0 SKIP · 0 CANCELLED`** (`19,491.01 ms`, **`49` test files**).
  - Bổ sung Phase 6.3: `phase63-tailscale-provider.test.ts` (4/4), `phase63-remote-security.test.ts` (2/2), `phase63-remote-playback-e2e.test.ts` (Chromium E2E 9 codecs + ALAC SHA-256 parity PASS), `database.test.ts` (`v9 -> v10` upgrade backup PASS).
  - Sửa hồi quy nhỏ phát hiện khi chạy lại `phase62-security-pairing.test.ts`: bỏ `allowInterruptedRecoveryGrace` trên `/auth/rotate-token` và `/auth/rotate-remote-token` để đảm bảo token cũ mất hiệu lực **ngay lập tức (`401`)** sau khi rotate thành công (giữ grace `60s` trên `/remote/provision`).

## 23. Tailscale Provider & Conflict Protection Tests (`Provider-1..4`)
- `Provider-1`: Đường dẫn CLI an toàn Windows, chặn arg injection `\r`/`\n`/`\0`, parse version `>= 1.52.0`.
- `Provider-2`: Ma trận lỗi đầy đủ (missing binary, version `< 1.52`, service stopped, `NeedsLogin`, thiếu MagicDNS, thiếu HTTPS cert, thiếu ACL `funnel`, malformed JSON, CLI timeout).
- `Provider-3`: Phát hiện conflict khi port có rule Tailscale Serve riêng tư (`AllowFunnel === false`) hoặc path ngoài `/doremi-connect`, từ chối ghi đè và chỉ gỡ đúng route sở hữu.
- `Provider-4`: Vòng đời Host Remote Access, pre-exposure security gate, đóng Gateway kể cả khi cleanup CLI lỗi, và startup stale-route reconciliation.

## 24. Remote HTTPS Security Integration Tests (`Security-A..G`)
- `Security-A & B`: Kiểm chứng `validateRemoteHttpsOrigin`, `isValidTailscaleFunnelHostname`, ký & chống sửa đổi `RemoteEndpointDescriptorV1`.
- `Security-C..G`: Chứng thực `RemoteGatewayService` thực tế — từ chối `/enrollment/*`, `/remote/provision`, `/auth/rotate-token`, `/admin/*`, `/diagnostics` (`403`), traversal `%2e%2e` (`400`), method `DELETE` (`405`), spoofed headers, sai CA/hostname (`0` token leaked), từ chối replay nonce, cách ly token `r1.*` vs LAN, thu hồi `remoteAccessEnabled` giữ nguyên LAN, và kích hoạt `429 RATE_LIMITED`.

## 25. Chromium End-to-End Remote Playback Results (Loopback TLS Edge Proxy)
- `phase63-remote-playback-e2e.test.ts`: Spawn Electron Chromium Window kết nối tới simulated TLS proxy (CA cô lập + Host `RemoteGatewayService`), bật `<audio>` + `AudioContext`, phát & seek thực tế thành công **9/9 định dạng**: `WAV16`, `FLAC16`, `FLAC24_96`, `MP3`, `AAC`, `OGG`, `OPUS`, `ALAC16`, `ALAC24_48`.

## 26. Benchmark Results (Measured Localhost Gateway + Simulated TLS Proxy)
- Từ [`qa/logs/phase63-benchmark-latest.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase63-benchmark-latest.json) (Windows x64, Node nhúng `v24.22.3`, `20` logical CPUs, **môi trường mô phỏng Gateway + TLS Proxy cục bộ, KHÔNG phải Internet công cộng**):
  - `1_host_off_baseline`: `3.92 ms` · CPU `0%` · RSS `102.94 MB` · Heap `16.51 MB`
  - `2_host_on_remote_off`: `2.03 ms` · CPU `0%` · RSS `104.48 MB` · Heap `16.94 MB`
  - `3_remote_https_verify_host_and_connect`: `11.74 ms` · CPU `6.39%` · RSS `103.05 MB` · Heap `16.36 MB`
  - `4_remote_https_stream_8mb_flac_x3` (`24 MB`): `146.5 ms` · CPU `6.93%` · RSS `137.39 MB` · Heap `13.89 MB`
  - `5_remote_https_seek_ranges_x20` (`64 KB` x 20): `69.43 ms` · CPU `5.62%` · RSS `147.79 MB` · Heap `17.37 MB`
  - `6_concurrent_3_streams_remote_https`: `113.74 ms` · CPU `4.84%` · RSS `213.1 MB` · Heap `15.19 MB`
  - `7_repeated_remote_enable_disable_x5`: `30.81 ms` · CPU `5.03%` · RSS `213.12 -> 213.59 MB` · Heap `15.92 MB`

## 27. Security Review Summary & Findings Classification
- Chi tiết xem tại [`docs/phase-6/PHASE_6.3_SECURITY_REVIEW.md`](./PHASE_6.3_SECURITY_REVIEW.md).
- Toàn bộ các rủi ro `CRITICAL` (`SEC-P63-01`, `SEC-P63-02`) và `HIGH` (`SEC-P63-03`, `SEC-P63-04`, `SEC-P63-05`) cũng như `MEDIUM`/`LOW` (`SEC-P63-06`, `SEC-P63-07`) đã được xử lý và kiểm chứng tự động; còn lại `SEC-P63-08 (INFORMATIONAL)` ghi nhận trạng thái `NOT RUN` của `tailscale.exe` thật trên máy build.
- Kiểm tra lỗ hổng thư viện runtime (`npm.cmd audit --omit=dev --json`): **`0` vulnerabilities** trên `53` production dependencies.

## 28. Dependency & License Compliance Check
- Phase 6.3 **không thêm bất kỳ npm dependency mới nào** (tận dụng hoàn toàn `node:crypto`, `node:http`, `node:https`, `node:child_process` chuẩn của Node/Electron và UI icons `lucide-react` sẵn có), giữ `0` runtime vulnerability và giữ sạch tuân thủ OSS (`docs:sync` & `codecs:verify` PASS).

## 29. Real Tailscale Funnel Environment Status (`NOT RUN`)
- Xác nhận thực tế trên máy build: `Test-Path "C:\Program Files\Tailscale\tailscale.exe"` trả về `False` và không có `tailscale` trong `PATH`.
- Do đó, mọi kịch bản gọi `tailscale.exe` thực tế (cài đặt, xác thực tailnet thật, cấp Let's Encrypt cert qua MagicDNS, mở đường hầm Funnel công cộng từ mạng gia đình) hiện ở trạng thái **`FUNNEL INTEGRATION NOT RUN`**.

## 30. Physical External-Network Two-PC UAT Status (`PENDING`)
- Kịch bản Nhóm E (`E01–E12` trong `PHASE_6.3_WINDOWS_UAT.md` — 2 máy Windows trên 2 mạng khác nhau, Host dùng Tailscale Funnel, Client dùng Hotspot/mạng ngoài không Tailscale/VPN) ở trạng thái **`PHYSICAL INTERNET UAT PENDING`**.

## 31. Simple User Tailscale Setup & External-Network Test Guide
- Đã biên soạn hướng dẫn từng bước bằng tiếng Việt tại [`docs/phase-6/PHASE_6.3_FUNNEL_SETUP.md`](./PHASE_6.3_FUNNEL_SETUP.md), đồng thời đồng bộ Chương 13 trong User Guide tích hợp và [`docs/USER_GUIDE.md`](../USER_GUIDE.md) (`docs:sync -- --check` PASS).

## 32. Android Single-APK Architecture Readiness Confirmation
- Xác nhận hợp đồng tương thích HTTP + ECDSA + TLS + `r1.*` Bearer Token cho **Android Single-APK Client** đã hoàn thiện trong [`PHASE_6.3_REMOTE_HTTPS_ARCHITECTURE.md`](./PHASE_6.3_REMOTE_HTTPS_ARCHITECTURE.md) Mục 6; ứng dụng Android tương lai chỉ dùng HTTPS chuẩn + Media3/ALAC WASM/native mà **không cần Tailscale hay VPN**.

## 33. Tailscale Bandwidth & Network Reality Notes
- Truyền phát Hi-Res qua Tailscale Funnel có thể chịu giới hạn băng thông relay của gói Tailscale miễn phí (không tăng được từ ứng dụng) và phụ thuộc chất lượng mạng gia đình + mạng di động/công cộng của Client. DoReMi truyền byte gốc trung thực, không tự giảm chất lượng âm thanh ngầm.

## 34. Files Created / Modified Inventory
- **Mới tạo**: `src/shared/contracts/connect-remote.ts`, `src/main/services/connect/{tailscale-cli,tailscale-funnel-provider,remote-gateway-service,remote-trust}.ts`, `tests/helpers/test-ca-https.ts`, `tests/phase63-{tailscale-provider,remote-security,remote-playback-e2e}.test.ts`, `scripts/benchmark-phase63.ts`, `docs/phase-6/PHASE_6.3_{REMOTE_HTTPS_ARCHITECTURE,FUNNEL_SETUP,SECURITY_REVIEW,WINDOWS_UAT,REPORT}.md`, `backups/phase-6.2-rc6-checkpoint/`.
- **Cập nhật**: `src/main/database/migrations.ts` (`v10`), `src/main/services/connect/{connect-repository,device-auth-service,resource-budget,host-service,connect-client}.ts`, `src/shared/types/{connect,ipc}.ts`, `src/shared/contracts/channels.ts`, `src/preload/index.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/stores/connect-store-core.ts`, `src/renderer/src/pages/ServerPage.tsx`, `src/shared/user-guide/guide-content.ts`, `docs/USER_GUIDE.md`, `tests/{database,phase62-security-pairing}.test.ts`, `package.json`, `package-lock.json`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`, `qa/*.cmd`, `.ai-context/*.md`.

## 35. Risks & Limitations Honestly Disclosed
- **R1 (Real Funnel `NOT RUN`)**: Cần thử nghiệm thực tế trên máy Host đã cài Tailscale Windows và Tailnet bật MagicDNS + HTTPS + ACL Funnel.
- **R2 (Relay Bandwidth)**: File bitrate cực cao qua mạng ngoài phụ thuộc trực tiếp giới hạn relay của Tailscale Funnel.
- **R3 (Symmetric NAT / CG-NAT / Firewall)**: Nếu ISP hoặc Firewall chặn kết nối Tailscale daemon trên Host, trạng thái Funnel sẽ báo lỗi cụ thể thay vì âm thầm mở cổng UPnP.
- **R4 (No Auto Handover yet)**: Người dùng phải tự chuyển `LAN Direct` <-> `Remote HTTPS` (tự động chuyển mạng mượt mà thuộc Phase 6.4).

## 36. Phase 6.4 / 6.5 / 6.6 Boundaries Respected
- **KHÔNG** triển khai Auto Handover / Smart Connection Manager (Phase 6.4), **KHÔNG** triển khai Wake-on-LAN / Sleep Prevention (Phase 6.5), **KHÔNG** triển khai Mobile Android code, **KHÔNG** triển khai tính năng vượt ngoài phạm vi Phase 6.3.

## 37. Phase 7 UI Fix Backlog Preserved & Recorded (`UI-BACKLOG-01`..`05`)
Toàn bộ 5 hạng mục backlog UI dưới đây **chưa sửa** trong `v1.0.0-rc.7` và được giữ nguyên trong `AGENTS.md` + `.ai-context/*`:
1. **`UI-BACKLOG-01` *(Target Phase 7.3)* — Now Playing Vinyl Rotation on Remote Playback**: Đĩa than trong `NowPlayingPage` / Focus Vinyl chưa quay đúng trạng thái khi phát Remote Playback (kể cả High Performance Mode).
2. **`UI-BACKLOG-02` *(Target Phase 7.2)* — Source-Aware Main Library Integration**: Hợp nhất duyệt thư viện từ xa vào trang Thư viện chính theo bộ lọc **All Sources / Local Sources / Remote Server Sources**, dùng chung Search/Album/Artist/Playlist/Queue (tuyệt đối không sao chép file remote vào SQLite cục bộ).
3. **`UI-BACKLOG-03` *(Target Phase 7.4)* — Lightweight Real Host Resource Gauges**: Hiển thị chỉ số tài nguyên Host thực tế nhẹ (CPU, RAM, tốc độ upload, số Client kết nối, tách bạch rõ phạm vi local/LAN/Remote).
4. **`UI-BACKLOG-04` *(Target Phase 7.4)* — Minimalist Server UI Redesign**: Tối giản giao diện màn hình Server, gom chi tiết kỹ thuật/bảo mật/mạng chuyên sâu vào mục Nâng cao (Advanced).
5. **`UI-BACKLOG-05` *(Target Phase 7.3)* — Lyrics Compatibility & Synchronization Investigation**: Điều tra lỗi tương thích & đồng bộ lời bài hát thực tế (`Love Option` unsynced trên cả Host & Client so với `DNA` synced và `Love Option Instrumental`), giữ nguyên thứ tự ưu tiên Custom > External LRC > Embedded.

## 38. Windows UAT Checklist Summary (`74 Items`)
- Đã lập đầy đủ **74 mục** trong [`docs/phase-6/PHASE_6.3_WINDOWS_UAT.md`](./PHASE_6.3_WINDOWS_UAT.md) chia 6 nhóm (`A01–A12`, `B01–B12`, `C01–C12`, `D01–D16`, `E01–E12 [PENDING PHYSICAL]`, `F01–F10`).

## 39. Documentation Synchronization Status
- `npm.cmd run docs:sync` & `npm.cmd run docs:sync -- --check`: **`PASSED`** (`v1.0.0-rc.7`).
- Đã cập nhật đồng bộ toàn bộ `.ai-context/{CURRENT_STATE,NEXT_TASK,FILE_INDEX,ARCHITECTURE_MAP,FEATURE_STATUS,KNOWN_ISSUES,DECISIONS,TEST_MATRIX}.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`, `qa/*.cmd`.

## 40. Rollback & Recovery Verification
- Toàn bộ source + docs baseline Phase 6.2 (`v1.0.0-rc.6`) lưu đầy đủ tại `backups/phase-6.2-rc6-checkpoint/`.
- Bản build & đóng gói trước (`rc.1`..`rc.6`) nguyên vẹn trong `release/`.
- SQLite `library.db` của người dùng tự động sao lưu trước nâng cấp `v9 -> v10` theo thiết kế gốc (`connection.ts`).

## 41. Final Honest Conclusion & Next Recommended Action
- **Kết luận**: DoReMi `v1.0.0-rc.7` đã hoàn thành vững chắc phần lõi kỹ thuật, bảo mật, truyền phát byte gốc và bộ kiểm thử tự động (`222/222 PASS`) cho **Phase 6.3 — Remote HTTPS qua Tailscale Funnel**, sẵn sàng đóng gói phát hành thử nghiệm. Tuy nhiên, kích hoạt Tailscale Funnel thực tế và UAT 2 máy ngoài mạng (`Nhóm E`) vẫn đang chờ thực thi trực tiếp trên phần cứng có cài `tailscale.exe`.
- **Hành động đề xuất tiếp theo**: Cài Tailscale Windows theo [`PHASE_6.3_FUNNEL_SETUP.md`](./PHASE_6.3_FUNNEL_SETUP.md), chạy nghiệm thu 12 mục Nhóm E trên mạng ngoài thật, rồi mới chuyển tiếp sang Phase 6.4 (Auto Handover) hoặc cụm pha UI Fix Phase 7 (`UI-BACKLOG-01..05`).
