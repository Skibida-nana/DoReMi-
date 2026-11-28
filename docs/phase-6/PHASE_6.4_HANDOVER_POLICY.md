# DoReMi — Phase 6.4 Connection Selection & Playback Handover Policy

- **Version**: `1.0.0-rc.8` (`Phase 6.4`)
- **Implementation**: [`smart-connection-manager.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/smart-connection-manager.ts), [`connect-client.ts`](file:///G:/Source%20code%20DoReMi/src/main/services/connect/connect-client.ts), [`connect-store-core.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/stores/connect-store-core.ts), [`audio-engine.ts`](file:///G:/Source%20code%20DoReMi/src/renderer/src/player/audio-engine.ts)

---

## 1. User Connection Modes (`ConnectionSelectionMode`)

| Mode | Stored Value | Candidate Policy | Automatic Handover |
|---|---|---|---|
| **Tự động** *(Default for newly paired Hosts)* | `'automatic'` | Evaluates **LAN Direct first**; falls back to **Remote HTTPS** only if LAN fails with a `recoverable_network` error and Remote HTTPS passes full descriptor + identity proof + `r1.*` auth. | **Yes**: `LAN -> Remote` (`Break-Before-Make` on active LAN failure) & `Remote -> LAN` (`Make-Before-Break` when home LAN returns). |
| **Chỉ LAN** | `'lan-only'` | Evaluates **LAN Direct only** (including secure mDNS rediscovery on LAN IP change). **Never** contacts Remote HTTPS endpoints. | Reconnects on LAN only; zero Remote traffic. |
| **Chỉ Remote** | `'remote-only'` | Evaluates **Remote HTTPS only**. **Never** opens LAN Direct sockets or falls back to LAN. | Reconnects on Remote HTTPS only; zero LAN traffic. |

### Upgrade Compatibility (`RC.7 -> RC.8`, SQLite `v10`)
- Existing `connect_remembered_hosts.preferred_transport` values from Phase 6.3 (`'lan-direct'` / `'remote-https'`) map deterministically to `'lan-only'` / `'remote-only'` so existing user policies are never silently altered on upgrade, while newly paired Hosts default to `'automatic'`.

---

## 2. Default Hysteresis, Cooldown & Retry Parameters (`DEFAULT_SMART_CONNECTION_POLICY`)

| Parameter | Default Value | Rationale |
|---|---|---|
| `networkDebounceMs` | `800 ms` | Coalesces rapid OS adapter / DHCP transitions into a single evaluation. |
| `lanRecoveryConfirmMs` | `2,500 ms` | Requires home Wi-Fi to stay stable before switching away from a working Remote HTTPS stream. |
| `switchCooldownMs` | `15,000 ms` | Blocks non-emergency transport oscillation (`Remote -> LAN`), while **emergency failures bypass cooldown immediately**. |
| `failureThreshold` | `2` | Absorbs a single transient hiccup (`DEGRADED`) without needlessly restarting the audio stream; triggers recovery on the 2nd consecutive failure or immediate hard disconnect. |
| `retryBackoffMs` | `[500, 1000, 2000, 4000, 8000] ms` (`±12%` jitter) | Bounded exponential backoff avoiding Host/network storms. |
| `maxAutoReconnectAttempts` | `6` | Caps automatic retries and rests in `HOST_UNAVAILABLE` (`0` active timers) until OS network changes or manual user Retry. |

---

## 3. Security-Aware Failure Classification (`classifyConnectFailure`)

| Category | Error Codes / Conditions | Retry / Fallback Behavior |
|---|---|---|
| **`security`** | `HOST_IDENTITY_MISMATCH`, `UNSUPPORTED_API_VERSION`, untrusted CA, wrong TLS SAN hostname, HTTP `3xx` redirect, forged/rollback descriptor | **STOP IMMEDIATELY (`SECURITY_BLOCKED`)**: `0` retries, `0` fallback to alternate transport, `0` credentials transmitted, clears active remote playback/library state. |
| **`authorization`** (Full Revocation) | `ACCESS_REVOKED` | **STOP IMMEDIATELY (`ACCESS_REVOKED`)**: `0` retries, blocks both LAN and Remote, clears active remote playback/library state. |
| **`authorization`** (Scoped Remote) | `REMOTE_ACCESS_NOT_GRANTED`, `REMOTE_ENDPOINT_NOT_CONFIGURED`, `REMOTE_ENDPOINT_EXPIRED` | Blocks **Remote HTTPS** (`AUTHORIZATION_REQUIRED` in `Remote Only`); in `Automatic` mode, still permits verified **LAN Direct** (and refreshes expired descriptors over trusted LAN). |
| **`content`** | `404` missing/unshared track, `UNSUPPORTED_FORMAT`, `CONTENT_CHANGED` | **Track-scoped only**: Pauses/reports track issue without switching transports or entering connection retry loops. |
| **`recoverable_network`** | `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `502/503`, `NETWORK_INTERRUPTED`, `HOST_UNAVAILABLE` | Eligible for mDNS rediscovery, `Automatic` fallback (`LAN -> Remote`), and bounded exponential backoff. |

---

## 4. Playback Handover & Source Consistency Protocol

1. **`Make-Before-Break` (`Remote HTTPS -> LAN Direct`)**:
   - Triggered when `NetworkChangeMonitor` detects a private LAN interface while `CONNECTED_REMOTE` in `Automatic` mode.
   - `Remote HTTPS` continues streaming uninterrupted during `lanRecoveryConfirmMs` and background `prepareLanTransport()`.
   - If the current private Wi-Fi is a foreign LAN (e.g., café/office `192.168.1.x` with unreachable Host or different TLS cert), `SmartConnectionManager` transmits `0` credentials to the foreign LAN and keeps `Remote HTTPS` playing without interruption.
   - Once authentic Home LAN is verified, `ConnectClientService` drains the old stream socket with a `600 ms` overlap window while `ConnectStore` + `AudioEngine.recoverCurrentTrackTransport` switch to `lossless-media://remote-track/<hostId>/<trackId>?ho=<seq>` at the current timestamp.
2. **`Break-Before-Make` (`LAN Direct -> Remote HTTPS` or Network Drop)**:
   - While `SmartConnectionManager` is in `RECONNECTING` / `HANDOVER_*`, `AudioEngine`'s `isRemoteHandoverPending` predicate holds the exact `currentTimeSeconds` in `'loading'` without failing the Queue entry, triggering Auto Next, or duplicating Listening Sessions.
   - Once the new transport is verified, `ConnectStore` verifies track source consistency (`GET /library/tracks/:id` + `HEAD /stream/:id` `X-DoReMi-Source-Revision: <size>:<mtimeMs>`):
     - **Unchanged source**: reloads `?ho=<seq>`, waits for `loadedmetadata`, seeks once to exact timestamp, and resumes ONLY if the user's intent was playing (paused tracks stay paused!).
     - **Modified source on Host**: invalidates `RemoteAlacStreamManager` and track metadata caches for that track and reloads safely from `0:00` instead of splicing mismatched byte offsets.
     - **Deleted / unshared track (`404`)**: pauses cleanly without oscillating transports.
