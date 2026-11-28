# BÁO CÁO TRIỂN KHAI & NGHIỆM THU KỸ THUẬT — DOREMI PHASE 6.4 (`v1.0.0-rc.8`)

**Chủ đề**: Smart Connection Manager, Automatic Transport Selection, Network Recovery & Playback Handover  
**Phiên bản phát hành thử nghiệm**: `DoReMi v1.0.0-rc.8` (nâng cấp từ `v1.0.0-rc.7`)  
**Trạng thái xác minh**: `IMPLEMENTATION COMPLETE` · `AUTOMATED VERIFICATION COMPLETE (228/228 PASS)` · `LOCAL HANDOVER VERIFIED` · `SIMULATED REMOTE HANDOVER VERIFIED` · `PACKAGED RC.8 FUNCTIONAL VERIFIED` · **`PHYSICAL NETWORK UAT PENDING`** *(Chưa tuyên bố `FULL PHASE ACCEPTANCE` cho tới khi người dùng hoàn tất UAT chuyển mạng vật lý 2 thiết bị)*

---

## 1. Tóm tắt tổng quan Phase 6.4
Phase 6.4 bổ sung tầng điều phối kết nối thông minh **`SmartConnectionManager`** và bộ giám sát thay đổi mạng nhẹ **`NetworkChangeMonitor`** cho DoReMi Windows, cho phép ứng dụng tự động chọn đường truyền tối ưu đã được cấp phép giữa **LAN Direct** (ưu tiên số 1) và **Remote HTTPS** (dự phòng qua Tailscale Funnel), đồng thời tự động khôi phục kết nối và bàn giao luồng phát nhạc (**Playback Handover**) khi người dùng di chuyển giữa Wi-Fi nhà, Wi-Fi bên ngoài và điểm phát sóng di động (Mobile Hotspot) mà không làm giảm chất lượng âm thanh gốc, không lộ thông tin xác thực và không ảnh hưởng trình phát nhạc offline cục bộ.

## 2. Kết quả kiểm tra trạng thái thực tế của `v1.0.0-rc.7`
- Đã xác minh trực tiếp workspace `G:\Source code DoReMi` ở nhánh `main`, `package.json` phiên bản `1.0.0-rc.7`, SQLite schema `v10`, toàn bộ `49` tệp test trước đó đạt `222 / 222 PASS`, và đầy đủ các thư mục đóng gói `release/v1.0.0-rc.1`..`v1.0.0-rc.7` cùng `phase-6.1-win-unpacked`.
- Kiểm tra chỉ đọc (read-only) môi trường máy hiện tại ghi nhận Tailscale Windows CLI (`v1.104.7`, trạng thái `Running`) đã được cài đặt trên máy; quá trình phát triển và chạy kiểm thử của Phase 6.4 **tuyệt đối không can thiệp hay ghi đè** cấu hình Tailscale Funnel đang chạy của người dùng (mọi bài kiểm thử tự động đều dùng mock CLI và thư mục tạm cô lập).

## 3. Điểm khôi phục đã tạo trước khi sửa code
- Đã sao lưu nguyên vẹn toàn bộ mã nguồn, cấu hình, scripts, tests và tài liệu của `v1.0.0-rc.7` (`324` tệp) vào [`backups/phase-6.3-rc7-checkpoint/`](file:///G:/Source%20code%20DoReMi/backups/phase-6.3-rc7-checkpoint/) trước khi thực hiện bất kỳ chỉnh sửa nào của Phase 6.4, đồng thời giữ nguyên `backups/phase-6.2-rc6-checkpoint/` và toàn bộ `release/v1.0.0-rc.1`..`rc.7`.

## 4. Kiến trúc `SmartConnectionManager` đã triển khai
- Module [`src/main/services/connect/smart-connection-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/smart-connection-manager.ts) đóng vai trò tầng điều phối độc lập nền tảng thông qua giao diện `SmartConnectionDriver`, nằm trên `LanDirectProvider` / `RemoteGatewayService` và dưới `ConnectClientService` -> `ConnectStore` -> `AudioEngine`.
- Không sao chép logic kiểm tra chứng chỉ TLS, không gọi trực tiếp Tailscale CLI và không can thiệp bộ giải mã WASM ALAC. Chi tiết kiến trúc xem tại [`docs/phase-6/PHASE_6.4_SMART_CONNECTION_ARCHITECTURE.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.4_SMART_CONNECTION_ARCHITECTURE.md).

## 5. Các chế độ kết nối (`Automatic`, `LAN Only`, `Remote Only`)
- **`Automatic` (`Tự động`)**: Mặc định cho mọi Host ghép nối mới; luôn ưu tiên `LAN Direct`, tự chuyển sang `Remote HTTPS` khi LAN gặp lỗi mạng khả phục hồi và tự nâng cấp ngược về `LAN Direct` khi về lại mạng nhà.
- **`LAN Only` (`Chỉ LAN`)**: Chỉ đánh giá và kết nối qua `LAN Direct` (bao gồm quét lại mDNS an toàn); **không bao giờ** mở kết nối tới `Remote HTTPS`.
- **`Remote Only` (`Chỉ Remote`)**: Chỉ đánh giá và kết nối qua `Remote HTTPS`; **không bao giờ** mở socket LAN hay tự rơi về LAN.
- **Tương thích nâng cấp từ `rc.7`**: Lưu bền vững trên cột `connect_remembered_hosts.preferred_transport` (giữ nguyên SQLite schema `v10`, không ép migration giả); ánh xạ tự động giá trị cũ `'lan-direct' -> 'lan-only'` và `'remote-https' -> 'remote-only'` để không tự ý thay đổi lựa chọn bảo mật sẵn có của người dùng `rc.7`.

## 6. Quy tắc ưu tiên lựa chọn đường truyền
1. Kiểm tra chế độ kết nối đã chọn của `hostId` (`Automatic`, `LAN Only`, `Remote Only`).
2. Nếu chế độ cho phép LAN (`Automatic` hoặc `LAN Only`) và thiết bị có LAN credential hợp lệ: thử xác minh `LAN Direct` trước; nếu địa chỉ IP cũ không phản hồi, chạy quét mDNS có giới hạn trước khi kết luận LAN không khả dụng.
3. Chỉ khi ở chế độ `Remote Only`, hoặc ở chế độ `Automatic` mà LAN thất bại do lỗi mạng khả phục hồi (`recoverable_network`), hệ thống mới đánh giá `Remote HTTPS` (đòi hỏi đủ `RemoteEndpointDescriptorV1` còn hạn + chữ ký ECDSA hợp lệ + `RemoteHostIdentityProofV1` + `r1.*` token).

## 7. State machine và chống race condition
- Triển khai đầy đủ **19 trạng thái tường minh** (`DISCONNECTED`, `CHECKING_NETWORK`, `DISCOVERING_LAN`, `VERIFYING_LAN`, `CONNECTING_LAN`, `CONNECTED_LAN`, `VERIFYING_REMOTE`, `CONNECTING_REMOTE`, `CONNECTED_REMOTE`, `HANDOVER_PENDING`, `HANDOVER_IN_PROGRESS`, `RECONNECTING`, `DEGRADED`, `HOST_UNAVAILABLE`, `NETWORK_UNAVAILABLE`, `AUTHORIZATION_REQUIRED`, `ACCESS_REVOKED`, `SECURITY_BLOCKED`, `ERROR`).
- Mỗi thao tác kết nối / đổi chế độ / ngắt kết nối / phục hồi đều tăng bộ đếm đơn điệu `connectionGeneration` kèm `AbortController`; mọi phản hồi trễ từ thế hệ cũ (`!isCurrentGen`) bị loại bỏ ngay lập tức.

## 8. Phát hiện thay đổi mạng nhẹ, không ngốn tài nguyên
- [`src/main/services/connect/network-monitor.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/network-monitor.ts) hoàn toàn **tắt (`isRunning() === false`, `0` timer)** khi người dùng nghe nhạc offline cục bộ hoặc đã ngắt kết nối Server.
- Khi đang kết nối Host, chỉ kết hợp sự kiện `online`/`offline` của hệ thống với đối chiếu chữ ký giao diện IPv4 cục bộ trong bộ nhớ (`os.networkInterfaces()`, chu kỳ `4,000 ms` `unref`) và bằng chứng sức khỏe từ chính các request/stream thực tế. **Không ping Internet ngoài, không truy vấn DNS bên thứ ba, không gọi Tailscale CLI trên Client, không thu thập SSID Wi-Fi, MAC hay vị trí địa lý.**

## 9. Xử lý khi Host đổi IP LAN
- Khi `lastAddress:port` đã lưu không phản hồi ở mức mạng, `SmartConnectionManager` quét mDNS `_doremi._tcp.local` trong cửa sổ ngắn (`1,200 ms`), lọc đúng `hostId`, kiểm chứng đầy đủ chứng chỉ TLS SPKI SHA-256 + `/api/v1/capabilities` + `/api/v1/library/summary` rồi mới cập nhật `lastAddress:port` vào SQLite.
- **Chống tấn công giả mạo mDNS (Anti-DoS)**: Vì mDNS là UDP multicast không xác thực, nếu kẻ tấn công trong mạng Wi-Fi công cộng phát gói mDNS giả trùng `hostId` nhưng sai khóa TLS SPKI, ứng dụng từ chối ngay (`0` byte token gửi đi), ghi nhận sự kiện bảo mật và **bỏ qua ứng viên giả mạo đó** để tiếp tục thử ứng viên thật hoặc chuyển sang `Remote HTTPS` thay vì tự khóa chết phiên nghe nhạc.

## 10. Xác minh khả dụng và bảo mật của LAN Direct
- Bắt buộc TLS `>= 1.2`, khớp tuyệt đối vân tay khóa công khai SPKI SHA-256 đã ghim theo `hostId`, chặn HTTP `3xx` redirect, chỉ cho phép địa chỉ IPv4 LAN hợp lệ / loopback và xác thực bằng LAN Bearer Token riêng.

## 11. Xác minh khả dụng và bảo mật của Remote HTTPS
- Bắt buộc xác thực chứng chỉ TLS CA công cộng (`rejectUnauthorized: true` + `checkServerIdentity`), chặn tuyệt đối mọi mã chuyển hướng HTTP `3xx`, kiểm tra hạn dùng & chữ ký ECDSA P-256 của `RemoteEndpointDescriptorV1` (chống hạ cấp `endpointGeneration`), và hoàn tất thử thách `POST /api/v1/remote/verify-host` (`RemoteHostIdentityProofV1`) với nonce ngẫu nhiên **trước khi** gửi `r1.<deviceId>.<secret>` token.

## 12. Xử lý Remote Endpoint Descriptor hết hạn hoặc thay đổi
- Bổ sung mã lỗi tường minh `REMOTE_ENDPOINT_EXPIRED` và trạng thái ứng viên `descriptor_expired`: tuyệt đối không kết nối tới descriptor đã quá `expiresAt`.
- Ở chế độ `Automatic`, nếu descriptor hết hạn nhưng mạng LAN tại nhà khả dụng, ứng dụng vẫn kết nối `LAN Direct` bình thường; đồng thời khi kết nối LAN thành công mà descriptor còn dưới `7 ngày` hiệu lực (hoặc đã hết hạn), Client tự động làm mới descriptor ngầm qua kênh LAN tin cậy.

## 13. Quy tắc Hysteresis, Debounce, Cooldown và Exponential Backoff
- Chi tiết tại [`docs/phase-6/PHASE_6.4_HANDOVER_POLICY.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.4_HANDOVER_POLICY.md): Debounce sự kiện mạng `800 ms`, xác nhận ổn định LAN `2,500 ms`, Cooldown chuyển đổi không khẩn cấp `15,000 ms` (**bỏ qua ngay lập tức khi đường truyền đang phát thực sự bị đứt**), ngưỡng lỗi `failureThreshold = 2` (lỗi đơn lẻ chỉ vào `DEGRADED` rồi tự hồi phục, không ngắt stream), và Exponential Backoff `[500, 1000, 2000, 4000, 8000] ms` (`±12%` jitter) tối đa `6` lần trước khi dừng nghỉ ở `HOST_UNAVAILABLE` (`0` timer hoạt động).

## 14. Phân loại lỗi kết nối, quyền truy cập, bảo mật và nội dung
- Hàm `classifyConnectFailure` phân tách 4 nhóm:
  1. `security` (`HOST_IDENTITY_MISMATCH`, lỗi CA/SAN/redirect/descriptor giả): dừng tức thì ở `SECURITY_BLOCKED`, `0` retry, không fallback.
  2. `authorization` (`ACCESS_REVOKED` chặn cả 2 đường truyền; `REMOTE_ACCESS_NOT_GRANTED` / `REMOTE_ENDPOINT_EXPIRED` chỉ chặn Remote và vẫn giữ LAN ở chế độ `Automatic`).
  3. `content` (`404` bài hát bị xóa/bỏ chia sẻ, `UNSUPPORTED_FORMAT`, `CONTENT_CHANGED`): chỉ xử lý trên bài hát hiện tại, **không bao giờ** gây nhảy đường truyền hay lặp kết nối lại.
  4. `recoverable_network` (`ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `502/503`): cho phép quét mDNS, chuyển sang đường truyền dự phòng hợp lệ và chạy backoff hữu hạn.

## 15. Cơ chế Playback Handover `LAN -> Remote` (`Break-Before-Make`)
- Khi đường truyền `LAN Direct` bị đứt giữa lúc đang phát nhạc ở chế độ `Automatic`:
  - `AudioEngine` nhận diện cờ `isRemoteHandoverPending` từ `ConnectStore`, giữ nguyên bài hát và mốc `currentTimeSeconds` ở trạng thái `'loading'` mà không đánh dấu lỗi Queue hay tự nhảy sang bài kế tiếp.
  - Ngay khi `SmartConnectionManager` xác minh xong `Remote HTTPS`, `ConnectStore` kiểm tra tính nhất quán tệp nguồn và gọi `recoverCurrentTrackTransport` mở lại `lossless-media://remote-track/<hostId>/<trackId>?ho=<seq>`, tua đúng về vị trí cũ và tiếp tục phát.

## 16. Cơ chế Playback Handover `Remote -> LAN` (`Make-Before-Break`)
- Khi đang phát ổn định qua `Remote HTTPS` và người dùng về lại mạng Wi-Fi:
  - Luồng `Remote HTTPS` tiếp tục phát bình thường trong suốt thời gian chờ xác nhận ổn định (`2,500 ms`) và xác minh ngầm `LAN Direct`.
  - **Bảo vệ khi vào Wi-Fi lạ trùng dải `192.168.1.x`**: Nếu mạng Wi-Fi hiện tại không có Host hoặc có thiết bị khác dùng chứng chỉ TLS lạ ở cùng IP cũ, hệ thống không gửi bất kỳ credential nào và giữ nguyên phiên `Remote HTTPS` đang phát không gián đoạn.
  - Khi xác minh đúng Host LAN tại nhà, `ConnectClientService` giữ cửa sổ thoát êm `600 ms` cho luồng cũ trong lúc `AudioEngine` nạp `?ho=<seq>` trên LAN, loại bỏ hoàn toàn xung đột đóng socket sớm.

## 17. Bảo toàn vị trí phát, Queue, Shuffle, Repeat, Volume, EQ và ReplayGain
- Danh tính bài hát logic `remote::<hostId>::<trackId>` và `queueEntryId` giữ nguyên 100% trước, trong và sau khi bàn giao đường truyền; không thay đổi danh sách `upcoming`/`history`, `shuffleEnabled`, `repeatMode`, `volume`, `muted`, cấu hình `AudioLabSettings` (Graphic/Parametric EQ) hay `ReplayGain`.

## 18. Bảo toàn trạng thái Paused / Playing / Seek / Next / Previous
- Nếu người dùng đã bấm **Tạm dừng (Pause)** trước hoặc trong lúc chuyển mạng, `recoverCurrentTrackTransport` nạp lại nguồn ở đúng mốc giây đang dừng nhưng **giữ nguyên trạng thái `paused`** (tuyệt đối không tự phát lại trái ý người dùng). Khi người dùng bấm `Resume`, `Seek`, `Next`, `Previous` hoặc chọn bài khác/nhạc cục bộ, thao tác người dùng luôn có quyền ưu tiên cao nhất.

## 19. Xử lý `ALAC`, `FLAC`, `WAV`, `AAC`, `Hi-Res FLAC` trong quá trình Handover
- Đã xác minh thực tế trên Chromium `<audio>` + `AudioContext` cho cả 6 nhóm mẫu: `FLAC 16/44.1`, `ALAC 16/44.1` (*Có Thể (102112 Version)*), `ALAC 24/48` (`moov` cuối file), `WAV 16/44.1`, `AAC (.m4a)` và `Hi-Res FLAC 24/96`.
- Với `ALAC`, `RemoteAlacStreamManager` gắn kèm `sourceRevision` vào khóa phiên giải mã Range WASM, chỉ đọc cửa sổ `< 512 KB` theo yêu cầu tua mà không tải toàn bộ file về RAM và giữ nguyên độ chính xác PCM 16/24-bit.
- Cập nhật `parseRemoteTrackMediaUrl` ([`media-protocol.ts`](file:///G:/Source%20code%20DoReMi/src/shared/contracts/media-protocol.ts)) chỉ cho phép duy nhất tham số số nguyên dương `?ho=<1..9 chữ số>` để nạp mới luồng handover an toàn, vẫn chặn mọi query/traversal lạ khác.

## 20. Xử lý thay đổi nội dung hoặc mất bài hát trên Host
- [`audio-streaming-service.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/audio-streaming-service.ts) trả thêm header `ETag` và `X-DoReMi-Source-Revision: <fileSize>:<roundedMtimeMs>` từ `fstat` thực tế trên cả `GET` và `HEAD`.
- Trước khi nối lại vị trí phát sau handover, `verifyTrackSourceConsistency` đối chiếu kích thước byte và `sourceRevision` (có dung sai `<= 2 ms` cho sai số làm tròn phân số mili-giây của NTFS): nếu file trên Host đã bị ghi đè/sửa đổi, bộ nhớ đệm ALAC/metadata của bài đó bị hủy ngay và nạp lại an toàn từ `0:00`; nếu bài hát đã bị xóa/ngừng chia sẻ (`404`), trình phát dừng êm bài đó kèm thông báo rõ ràng mà không đổi mạng sai.

## 21. Bảo toàn tìm kiếm và lọc Remote Library (`Phase 6.1.3`)
- Trong [`connect-store-core.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store-core.ts), `applyClientSnapshot` phân biệt chặt giữa định danh Host mục tiêu (`activeHost?.hostId ?? intendedHostId`) và trạng thái tạm thời (`RECONNECTING`, `HANDOVER_*`, `HOST_UNAVAILABLE`, `NETWORK_UNAVAILABLE`), nhờ đó danh sách bài hát/album/nghệ sĩ, từ khóa tìm kiếm `remoteSearchInput`/`remoteSearchQuery` và bộ lọc đang mở trên `ServerPage` không bao giờ bị xóa trắng khi chuyển mạng.

## 22. Bảo toàn thống kê nghe nhạc và lịch sử phát
- Trong suốt thời gian chờ mạng khôi phục hoặc nạp lại luồng `?ho=<seq>`, `AudioEngine` gọi `pauseSessionSegment(false)` để **không cộng thời gian đứt mạng/buffering** vào tổng thời gian nghe thực tế, đồng thời giữ nguyên `sessionId` hiện hành nên không tạo bản ghi phiên nghe trùng lặp.

## 23. Bảo toàn tuyệt đối Local Playback và dữ liệu người dùng
- Giữ nguyên `appId: com.losslessplayer.desktop`, thư mục `%APPDATA%\Lossless Player`, SQLite schema `v10` (WAL + `foreign_keys = ON` + `integrity_check`), không thêm tiến trình nền hệ thống và không tăng thêm `0.00 kB` nào vào bundle khởi động chính của trình phát cục bộ (`index-*.js` giữ nguyên `677.38 kB`).

## 24. Bảo toàn bảo mật Phase 6.2 và Phase 6.3
- Toàn bộ hàng rào bảo mật từ Phase 6.2 & 6.3 được giữ nguyên và kiểm thử hồi quy: ghép nối QR ngoại tuyến `doremi-pair` v1 chỉ qua LAN, tách biệt hoàn toàn token LAN và `r1.*` Remote token, `RemoteGatewayService` chỉ bind `127.0.0.1` và chặn `/enrollment`, `/remote/provision`, `/auth/rotate-token`, `/admin`, `/diagnostics` (`403`), DPAPI `safeStorage` fail-closed trên GUI, và quy tắc chỉ gỡ đúng route `/doremi-connect` do DoReMi sở hữu.

## 25. Giao diện điều khiển tối thiểu đã bổ sung
- Trên [`ServerPage.tsx`](file:///G:/Source%20code%20DoReMi/src/renderer/src/pages/ServerPage.tsx) (tab **Kết nối**): bổ sung hộp chọn chế độ kết nối gọn nhẹ (`Tự động`, `Chỉ LAN`, `Chỉ Remote`) cho từng Host đã lưu và trên thanh trạng thái đang kết nối, hiển thị tách bạch **Chế độ đã chọn** và **Đường truyền thực tế đang hoạt động** bằng tiếng Việt rõ ràng (`Đang kết nối qua LAN`, `Đang kết nối qua Remote HTTPS`, `Đang kết nối lại...`, `Đang chuyển kết nối...`, `Không tìm thấy Host`, `Mất kết nối mạng`, `Đã thu hồi quyền`, `Xác minh bảo mật thất bại`), kèm nút `Thử kết nối lại`. Không làm lại toàn bộ giao diện Server (tuân thủ ranh giới Phase 7.4).

## 26. Hệ thống chẩn đoán đã khử thông tin nhạy cảm
- Mở rộng `ClientDiagnosticsSnapshot.smartConnection` (`SmartConnectionDiagnostics`) ghi nhận `selectedMode`, `smartState`, `activeTransport`, `alternativeTransportAvailable`, `connectionGeneration`, `selectionReason`, `failureCategory`, `retryCount`, `healthCheckCount`, `streamsCancelledCount`, trạng thái từng ứng viên và tối đa `24` sự kiện bàn giao gần nhất (`recentHandovers` gồm chiến lược, `durationMs`, `positionErrorSec`, `outcome`). Đã kiểm thử tự động xác nhận chuỗi JSON chẩn đoán **không chứa bất kỳ raw token hay khóa bí mật nào**.

## 27. Hợp đồng kiến trúc chuẩn bị cho Android Single-APK
- Đã tài liệu hóa đầy đủ trong mục 5 của [`PHASE_6.4_SMART_CONNECTION_ARCHITECTURE.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.4_SMART_CONNECTION_ARCHITECTURE.md): ánh xạ 1:1 `SmartConnectionManager` sang Kotlin Coroutines + `ConnectivityManager.NetworkCallback` (`WIFI` <-> `CELLULAR`) + `Media3/ExoPlayer DataSource`, dùng chung `RemoteEndpointDescriptorV1`, `verify-host`, `r1.*` token và header `X-DoReMi-Source-Revision` mà không cần cài Tailscale/VPN trên điện thoại Android.

## 28. Danh sách file tạo mới và chỉnh sửa
- **Tạo mới (10 tệp)**:
  - `src/main/services/connect/smart-connection-manager.ts`
  - `src/main/services/connect/network-monitor.ts`
  - `tests/phase64-smart-connection-selection.test.ts`
  - `tests/phase64-network-transitions-hysteresis.test.ts`
  - `tests/phase64-security-concurrency.test.ts`
  - `tests/phase64-playback-handover-e2e.test.ts`
  - `scripts/benchmark-phase64.ts`
  - `docs/phase-6/PHASE_6.4_SMART_CONNECTION_ARCHITECTURE.md`
  - `docs/phase-6/PHASE_6.4_HANDOVER_POLICY.md`
  - `docs/phase-6/PHASE_6.4_PERFORMANCE_REPORT.md`
  - `docs/phase-6/PHASE_6.4_WINDOWS_UAT.md`
  - `docs/phase-6/PHASE_6.4_REPORT.md`
- **Chỉnh sửa chính**:
  - `src/shared/types/{connect,ipc}.ts`, `src/shared/contracts/{channels,media-protocol}.ts`
  - `src/main/services/connect/{connect-client,connect-repository,audio-streaming-service,remote-alac-decoder}.ts`
  - `src/main/{index,ipc/register-ipc}.ts`, `src/preload/index.ts`
  - `src/renderer/src/player/audio-engine.ts`, `src/renderer/src/stores/{player-store,connect-store-core}.ts`, `src/renderer/src/pages/ServerPage.tsx`
  - `src/shared/user-guide/guide-content.ts`, `docs/USER_GUIDE.md`, `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`, `qa/DoReMi-QA-{Launch,SmokeTest}.cmd`, `.ai-context/*`

## 29. Kết quả kiểm thử tự động lựa chọn kết nối
- [`tests/phase64-smart-connection-selection.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase64-smart-connection-selection.test.ts): **`PASS` (`5,605 ms`)** — bao phủ trọn vẹn **20 kịch bản** (`Automatic` ưu tiên LAN có kiểm chứng lưu lượng proxy = `0`, fallback Remote khi LAN tắt, `LAN Only`, `Remote Only`, thiết bị chỉ có quyền LAN, thu hồi quyền Remote riêng lẻ vs thu hồi toàn bộ thiết bị, sai SPKI LAN, sai Host Proof Remote, hết hạn Descriptor `REMOTE_ENDPOINT_EXPIRED`, giả mạo Origin, lưu bền vững qua khởi động lại DB & tương thích dữ liệu `rc.7`, đổi chế độ khi đang kết nối, và cô lập 2 Host trùng tên hiển thị).

## 30. Kết quả kiểm thử chuyển mạng và phục hồi
- [`tests/phase64-network-transitions-hysteresis.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase64-network-transitions-hysteresis.test.ts): **`PASS` (`2/2` subtests — `1,055 ms` & `298 ms`)** — kiểm chứng `LAN -> Remote`, `Remote -> LAN` (`Make-Before-Break`), `LAN/Remote -> Offline -> Online`, hấp thụ lỗi ngắn `DEGRADED`, chống bão gói tin khi mạng nhấp nháy liên tục (`5` sự kiện gom còn `1`), tôn trọng Cooldown `5s` cho chuyển đổi thường nhưng bỏ qua tức thì khi đứt đường truyền thật, giới hạn Backoff dừng nghỉ với `0` timer, hủy thế hệ cũ khi `disconnect()`, và quét mDNS đổi cổng LAN thực tế (từ chối mDNS giả mạo, cập nhật đúng Host thật).

## 31. Kết quả kiểm thử Playback Handover
- [`tests/phase64-playback-handover-e2e.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase64-playback-handover-e2e.test.ts): **`PASS` (`18,486 ms`)** trên cửa sổ Electron Chromium thực tế (`<audio>` + `AudioContext` + `AudioEngine` + `ConnectStore` + `lossless-media://`):
  - Hoàn tất `12/12` lượt bàn giao hai chiều (`LAN -> Remote` & `Remote -> LAN`) trên cả **6 định dạng thực**: `FLAC 16/44.1`, `ALAC "Có Thể (102112 Version)"`, `ALAC 24/48` (`moov`-at-EOF), `WAV 16/44.1`, `AAC (.m4a)`, `Hi-Res FLAC 24/96`.
  - Xác nhận giữ nguyên trạng thái `Paused` qua handover, `Resume` phát tiếp mượt, bảo toàn `Volume (0.72)`, `Shuffle`, `Repeat All`, `EQ`, bộ lọc tìm kiếm `"Có Thể"` (`1` kết quả), tải `Remote Lyrics`, chuyển về nhạc cục bộ tức thì, không nhân đôi phiên thống kê nghe nhạc, và phát hiện chính xác tệp nguồn bị sửa đổi (`sourceConsistent: false`) hoặc bị xóa (`missingOrUnshared: true`).

## 32. Kết quả kiểm thử bảo mật và concurrency
- [`tests/phase64-security-concurrency.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase64-security-concurrency.test.ts): **`PASS` (`2/2` subtests — `471 ms` & `611 ms`)** — chứng minh `0` header `Authorization` rò rỉ khi gặp CA không tin cậy, sai SAN hostname, chuyển hướng `302`, hoặc xoay vòng khóa định danh Host; chặn chéo token `lan` trên Remote Gateway (`403`) và `r1.*` trên LAN (`401`); xác nhận `3` Client đồng thời (trộn LAN + Remote) cùng `6` vòng handover liên tiếp không làm phình `connectedDeviceCount` vượt `3` và giải phóng sạch `0` session / `0` timer khi đóng.

## 33. Kết quả toàn bộ regression suite
- Lệnh `npm.cmd run test:electron` trên toàn bộ **53 tệp kiểm thử** (với FFmpeg & Foobar2000 encoders thật): **`228 / 228 PASS, 0 FAIL, 0 SKIP`** (thời gian `20,244.32 ms`).

## 34. Kết quả đo hiệu năng có kiểm soát
- Chi tiết toàn bộ 17 kịch bản trong [`docs/phase-6/PHASE_6.4_PERFORMANCE_REPORT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.4_PERFORMANCE_REPORT.md) & [`qa/logs/phase64-benchmark-latest.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase64-benchmark-latest.json):
  - Nghe nhạc cục bộ không bật Server: `0.00%` CPU, `monitorArmed: false`, `activeTimers: 0`.
  - Kết nối `Automatic` ở trạng thái nghỉ (`500 ms`): `0` health-check thừa, `0.00%` CPU.
  - Kết nối lạnh `LAN Direct`: **`6.62 ms`**.
  - Handover `Remote -> LAN` (`Make-Before-Break` x5): trung vị **`95.43 ms`** (xấu nhất `113.50 ms`), CPU `0.15%`.
  - Handover `LAN -> Remote` (`Break-Before-Make` x5): trung vị **`1,231.88 ms`** (đã bao gồm trọn `1,200 ms` quét mDNS kiểm tra IP LAN mới + xác minh chữ ký `verify-host` + mở lại luồng `206` chỉ mất `~32 ms`).
  - Khôi phục tự động từ mất mạng hoàn toàn (`Offline -> LAN`): **`48.25 ms`**.
  - 3 Client stream song song: `61.81 ms`, RSS `137.56 MB` (`Heap 24.38 MB`), thoát sạch `0` timer / `0` session.

## 35. Kết quả kiểm tra dependencies và lỗ hổng bảo mật
- **Không cài thêm bất kỳ package runtime hay devDependency mới nào** trong Phase 6.4 (`53` production dependencies giữ nguyên như `rc.7`).
- `npm.cmd audit --omit=dev --json`: **`0` lỗ hổng bảo mật** (`info=0, low=0, moderate=0, high=0, critical=0`).

## 36. Kết quả build và đóng gói `DoReMi v1.0.0-rc.8`
- `docs:sync -- --check`, `codecs:verify`, `lint` (`tsc --noEmit`), `build` (`electron-vite build && verify-build.mjs`): **PASSED** (`out/main/index.js 731.81 kB`, `codec-manager 122.05 kB`, `preload 19.26 kB`, `index-qwfnEpX2.js 677.38 kB`, `ServerPage-BWBra5PU.js 396.47 kB`).
- Bộ cài Windows tạo tại [`release/v1.0.0-rc.8/`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.8/) kèm [`SHA256SUMS.txt`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.8/SHA256SUMS.txt):
  - `DoReMi-1.0.0-rc.8-x64-setup.exe` (`134,636,367 B` · SHA-256: `8326a166210faba4463876a2b4c6688ff3c961095a68382119ccf33f463e562b`)
  - `DoReMi-1.0.0-rc.8-x64-portable.exe` (`122,236,396 B` · SHA-256: `950536467c4e132932fb8f3277b2c15436e46b68d8332f7d01edc26013f3cb78`)
  - `DoReMi-1.0.0-rc.8-x64-portable.zip` (`170,077,101 B` · SHA-256: `e6f88e6fe74ed4003f7cb31dfbe1bff11f991cd7da99bfb9ff361f209ff6e185`)
  - `DoReMi-1.0.0-rc.8-x64-setup.exe.blockmap` (`141,190 B` · SHA-256: `b0452db11d199471d4c2f0342c9656f6c931451029239c34cdac1af58a678014`)
  - `win-unpacked/DoReMi.exe`
- **Kiểm chứng thực thi bản đóng gói (`Packaged Verification`)**:
  - GUI Smoke (`smoke:electron` Dev & `--exe release\v1.0.0-rc.8\win-unpacked\DoReMi.exe`): **`PASSED`** (`packaged=true, electron=45.4.1, rootChildren=2, diagLogs=1`).
  - Packaged Functional Integration trên chính `release\v1.0.0-rc.8\win-unpacked\DoReMi.exe`: **`PASSED`** (`asarVersion: "1.0.0-rc.8"`, `7/7` runtime tokens, native unpacked SQLite `v10` lưu bền vững `connectionMode`, hoàn tất `2` lượt handover `Automatic` + đọc stream `206` kèm `X-DoReMi-Source-Revision` và thoát sạch `0` timer).

## 37. Phân biệt rõ phần đã kiểm chứng tự động, phần mô phỏng và phần chưa test mạng vật lý
- **Đã kiểm chứng tự động thực tế**: Toàn bộ logic `SmartConnectionManager`, lưu trữ SQLite `v10`, bảo mật TLS SPKI / ECDSA Proof / Revocation, quét mDNS chống giả mạo, giải mã WASM ALAC & phát nhạc Chromium `<audio>` qua bàn giao hai chiều, và chạy thực tế tệp đóng gói `DoReMi.exe`.
- **Phần dùng môi trường mô phỏng cục bộ**: Đường truyền `Remote HTTPS` trong bộ test và benchmark chạy qua `RemoteGatewayService` (`127.0.0.1`) nối với proxy TLS cục bộ ký bởi Test Root CA cô lập và mock Tailscale CLI (để không sửa đổi cấu hình Tailscale Funnel đang hoạt động trên máy của bạn).
- **Chưa kiểm chứng vật lý (`PHYSICAL NETWORK UAT PENDING`)**: Chưa chạy thử nghiệm thực địa trên 2 máy tính vật lý chuyển đổi giữa Wi-Fi nhà thật và mạng 4G/5G Hotspot điện thoại đi qua relay Internet công cộng của Tailscale Funnel.

## 38. Hạn chế còn lại và rủi ro kỹ thuật
1. **Độ trễ & băng thông Tailscale Funnel miễn phí**: Khi chuyển sang 4G/5G ngoài thực tế, tốc độ tải phụ thuộc sóng di động và băng thông relay miễn phí của Tailscale; các file Hi-Res lớn (`24-bit/96kHz+`) có thể cần thêm vài trăm mili-giây đệm đầu luồng so với môi trường loopback.
2. ** Trạng thái nguồn của máy Host (Phạm vi Phase 6.5)**: Nếu máy PC Host ở nhà tự rơi vào chế độ Sleep/Hibernate của Windows, cả LAN lẫn Remote HTTPS sẽ không thể kết nối cho tới khi có cơ chế chống ngủ có kiểm soát / Wake-on-LAN ở Phase 6.5.
3. **Chưa ký số chứng chỉ EV/OV Code Signing**: Giống các bản RC trước, bộ cài Windows chưa gắn chứng chỉ ký số thương mại nên Windows SmartScreen có thể hiển thị cảnh báo lần đầu mở.

## 39. Danh sách đầy đủ các hạng mục UI / UX hoãn sang Phase 7 *(Giữ nguyên chưa triển khai trong Phase 6.4)*
1. **`UI-BACKLOG-01` (Target Phase 7.3 — Now Playing Vinyl Rotation on Remote Playback)**: Sửa chuyển động quay đĩa than trong `NowPlayingPage` / Focus Vinyl khi đang phát nhạc từ xa (kể cả ở chế độ High Performance Mode).
2. **`UI-BACKLOG-02` (Target Phase 7.2 — Source-Aware Main Library Integration)**: Tích hợp duyệt nhạc từ xa vào giao diện **Thư viện (Library)** chính với bộ lọc nguồn thống nhất (**All Sources / Local Sources / Remote Server Sources**), dùng chung tìm kiếm, Album, Nghệ sĩ, Playlist và Hàng đợi mà không sao chép file nhạc từ xa vào SQLite cục bộ.
3. **`UI-BACKLOG-03` (Target Phase 7.4 — Lightweight Real Host Resource Gauges)**: Hiển thị chỉ số tài nguyên Host thực tế nhẹ (CPU, RAM, tốc độ upload thực tế, số Client đang kết nối, tách bạch rõ phạm vi local/LAN/Remote).
4. **`UI-BACKLOG-04` (Target Phase 7.4 — Minimalist Server UI Redesign)**: Thiết kế lại giao diện Server theo hướng tối giản hơn, đưa các thông tin kỹ thuật/chẩn đoán/bảo mật chuyên sâu vào mục Nâng cao (Advanced).
5. **`UI-BACKLOG-05` (Target Phase 7.3 — Lyrics Compatibility & Synchronization Investigation)**: Điều tra lỗi tương thích và đồng bộ lời bài hát thực tế (`Love Option` unsynced trên cả Host & Client so với `DNA` synced và `Love Option Instrumental`), giữ nguyên thứ tự ưu tiên Custom > External LRC > Embedded.

## 40. Hướng dẫn UAT chuyển mạng thực tế với 2 máy Windows và điểm phát sóng điện thoại
- Tài liệu hướng dẫn từng bước bằng tiếng Việt đơn giản kèm danh sách **68 mục nghiệm thu (Nhóm A–F)** và cảnh báo dung lượng dữ liệu 4G/5G đã được biên soạn đầy đủ tại [`docs/phase-6/PHASE_6.4_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-6/PHASE_6.4_WINDOWS_UAT.md).

## 41. Kết luận trạng thái sẵn sàng cho Phase 6.5
- Toàn bộ mục tiêu kỹ thuật, bảo mật, bàn giao phát nhạc đa định dạng, hiệu năng và đóng gói của **Phase 6.4 (`DoReMi v1.0.0-rc.8`)** đã hoàn tất và vượt qua `100%` cổng kiểm tra tự động (`228/228` tests, `0` lỗ hổng `npm audit`, Dev & Packaged Smoke + Packaged Functional Verification `PASS`).
- **Khuyến nghị bước tiếp theo**: Người dùng thực hiện thử nghiệm thực tế chuyển mạng Wi-Fi nhà ↔ Hotspot điện thoại trên bản `release/v1.0.0-rc.8/` theo hướng dẫn UAT trước (hoặc xác nhận cho phép chuyển sang **Phase 6.5 — Host Availability, Sleep Prevention, Wake-on-LAN & Controlled Background Mode**). Agent dừng đúng ranh giới Phase 6.4 và không tự ý triển khai Phase 6.5.
