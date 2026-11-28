# DoReMi Phase 6.1 — Personal Hybrid Server Core, Secure LAN Direct & Cross-Platform API

## 1. Approved Architecture & Single-APK Android Requirement
DoReMi follows the officially approved **Personal Hybrid Server** architecture:
- **Music remains on original local storage** — zero Cloud Music Storage, zero VPS requirement, zero Firebase/AWS dependency, zero paywalls, zero mandatory recurring fees.
- **Single-APK Android Principle**: Future Android Clients (Phase 6.2+) must be distributed as one self-contained APK using DoReMi's own networking and audio components. Users must **never** be forced to install Tailscale, WireGuard, OpenVPN, or external VPN/decoder apps.
- **Independent Lifecycles**:
  - Local Music Player (`AudioEngine` + `AudioDspGraph`)
  - Personal Music Host Server (`ConnectHostService`)
  - Remote Music Client (`ConnectClientService` + `RemotePlaybackSourceAdapter`)
  - Isolated Codec Engine (`src/main/services/codec/*`)
  Each operates independently; Host is **OFF (`STOPPED`) by default** and Local Player + Connect Client work normally while own Host is OFF.
- **Transport Separation**: `ConnectHostService` routes `/api/v1/*` over a replaceable `TransportProvider` (`LanDirectProvider` in Phase 6.1). Future Remote HTTPS (Phase 6.3 Tailscale Funnel candidate) wraps the same core router without running a second music server.

---

## 2. Host Lifecycle State Machine
Explicit, serialized, idempotent transitions in `src/main/services/connect/host-service.ts`:
- `STOPPED` → `STARTING` → `STANDBY` ↔ `ACTIVE` → `STOPPING` → `STOPPED` (or `ERROR`).
- When `STOPPED`: zero listening sockets, zero mDNS timers, zero Host monitoring timers, zero active streams, zero background library reads.
- When `ACTIVE`: transitions automatically when at least one authorized stream session is active, and returns to `STANDBY` immediately when the last active stream finishes.
- On `stop()` or `before-quit`: active streams are aborted, file descriptors closed, sockets destroyed, mDNS goodbye packet (`TTL=0`) sent and socket closed, volatile enrollment state cleared, persistent settings & authorized device records preserved.

---

## 3. Host Identity, TLS Pinning & Device Enrollment
- **Cryptographic Host Identity** (`HostIdentityService` + `x509-cert.ts`):
  - Generates an **ECDSA P-256** (`prime256v1`) keypair + X.509 v3 self-signed certificate using Node `node:crypto` (no OpenSSL CLI dependency).
  - Derives `hostId` (UUIDv4-shaped hash of SPKI) and `fingerprintSha256` / `shortFingerprint` (`XXXX-XXXX-XXXX-XXXX`).
  - Private key is stored encrypted in `userData/connect/secrets.json` via Electron `safeStorage` (Windows DPAPI) — never in SQLite or `library.db` backups.
- **TLS Certificate Pinning** (`ConnectClientService`):
  - Clients never disable TLS verification globally.
  - During explicit Host probe, Client inspects peer certificate SPKI SHA-256 and presents `shortFingerprint` for out-of-band comparison with the Host UI.
  - After pairing, all HTTPS requests enforce strict SPKI SHA-256 pinning inside `secureConnect` **before** sending HTTP headers or Bearer credentials. Unexpected identity changes trigger `HOST_IDENTITY_MISMATCH`.
- **Single-Use Enrollment & Device Auth** (`DeviceAuthorizationService`):
  - Single-use random invite code (`XXXX-XXXX-XXXX`, 5-minute TTL, salted SHA-256 hash), `clientNonce` replay protection, per-IP rate limiting (5 failed attempts → 60s lockout).
  - Supports explicit Host approval/rejection (`pending` → `approved`/`rejected`) and optional single-use auto-approve.
  - Issued device token (`<deviceId>.<secret>`) is stored on Host **only as a salted SHA-256 hash** in `connect_authorized_devices` and on Client inside `safeStorage` (`connect_remembered_hosts.credential_ref`).
  - **Disconnect vs Revoke**: Disconnect closes active sessions while preserving authorization; Revoke invalidates credentials (`auth_state = 'revoked'`), aborts active streams immediately, and rejects future requests with HTTP `403 ACCESS_REVOKED`.

---

## 4. Shared Music Library & Filesystem Security
- **Explicit Opt-In**: `connect_shared_sources` starts empty; zero folders are shared by default.
- **Read-Only**: Remote Clients cannot delete files, modify metadata, edit tags, or browse arbitrary directories.
- **SharedFilesystemGuard** (`filesystem-guard.ts`):
  - Validates `trackId` UUID format and membership in an enabled, available `connect_shared_sources` root.
  - Resolves `realpath` of both shared root and target file, verifying root containment via `isNormalizedPathWithinRoot` (blocks `../`, encoded `%2f`/`%5c`/`%00`, symlink/junction escapes, unauthorized UNC paths).
  - Opens read descriptor and re-verifies `fstat()` (`isFile()`) and `realpath` to mitigate TOCTOU file replacement.
  - Equivalent validation applies to folder artwork and `.lrc` sidecar lyrics.

---

## 5. Cross-Platform Versioned API (`/api/v1/`)
No Electron objects, SQLite queries, or Windows filesystem paths are exposed.

| Method & Path | Auth | Purpose & Response |
|---|---|---|
| `GET /api/v1/capabilities` | Public (non-sensitive) | `apiVersion`, `minSupportedApiVersion`, `hostId`, `hostDisplayName`, `hostFingerprintSha256`, `shortFingerprint`, `supportedTransports`, `enrollmentOpen`, `directStreamOnly` |
| `POST /api/v1/enrollment/requests` | Invite + Nonce | Submits `{ inviteCode, deviceName, platform, clientNonce }`. Returns `200` (auto-approved) or `202` (`pending` + `requestId` + `pollToken`). |
| `GET /api/v1/enrollment/requests/:requestId?pollToken=...` | `pollToken` | Single-delivery polling for `pending` / `approved` (`deviceId`, `deviceToken`) / `rejected` / `expired`. |
| `POST /api/v1/auth/disconnect` | Bearer | Marks device disconnected without revoking authorization. |
| `GET /api/v1/library/summary` | Bearer | Shared counts (`totalSharedTracks`, `totalAlbums`, `totalArtists`, `sharedSourceCount`). |
| `GET /api/v1/library/tracks?offset&limit&q&albumKey&artist` | Bearer | Bounded pagination (`limit <= 200`), returns `RemoteLibraryPage<RemoteTrackDto>` (opaque `trackId` UUIDs). |
| `GET /api/v1/library/albums?offset&limit&q` | Bearer | Bounded pagination, `RemoteLibraryPage<RemoteAlbumDto>`. |
| `GET /api/v1/library/artists?offset&limit&q` | Bearer | Bounded pagination, `RemoteLibraryPage<RemoteArtistDto>`. |
| `GET /api/v1/library/tracks/:trackId` | Bearer | Single `RemoteTrackDto`. |
| `GET /api/v1/library/tracks/:trackId/artwork?size=full\|thumb` | Bearer | Artwork image bytes (`image/jpeg`, `image/png`, `image/webp`). |
| `GET /api/v1/library/tracks/:trackId/lyrics` | Bearer | `ResolvedTrackLyrics` with `sidecarPath: null`. |
| `GET\|HEAD /api/v1/stream/:trackId` | Bearer | Original-file audio streaming (`200`, `206 Partial Content`, `416 Range Not Satisfiable`). |

### HTTP Byte-Range Semantics
- Supports full GET, HEAD, single byte range (`bytes=start-end`), open-ended (`bytes=start-`), and suffix (`bytes=-suffix`).
- Multi-range requests (`bytes=0-10,20-30`) are rejected safely with `416 Range Not Satisfiable` (`MULTI_RANGE_UNSUPPORTED`) to prevent unbounded amplification.
- Streams asynchronously in 64 KB chunks (`highWaterMark: 65536`) with Node `pipeline` backpressure and immediate fd cleanup on abort/close.

---

## 6. Security Threat Model & Known Limitations
- **Mitigated**: Unauthorized LAN clients (Bearer auth + salted token hashes), MITM / rogue LAN servers (SPKI SHA-256 certificate pinning + out-of-band fingerprint verification), invite brute-forcing (5-attempt lockout + single-use + 5m TTL + nonce replay check), filesystem escapes (`realpath` + fd validation), public Internet exposure (RFC 1918 / loopback socket filter).
- **Remaining Limitations (Phase 6.1)**:
  - Self-signed ECDSA trust relies on manual out-of-band `shortFingerprint` comparison during initial pairing (Phase 6.2 QR pairing will encode fingerprint + ephemeral secret into one scan).
  - Windows Firewall private-network rules are not auto-modified silently; if Windows Defender blocks incoming LAN traffic on the configured port, users must allow DoReMi on **Private Networks** when prompted or manually.
  - Multi-device physical LAN and Android Client compatibility are deferred to manual multi-PC UAT and Phase 6.2/6.4 respectively.
