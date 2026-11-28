# DoReMi — Phase 6.4 Controlled Performance & Handover Benchmark Report (`1.0.0-rc.8`)

- **Generated From**: [`scripts/benchmark-phase64.ts`](file:///G:/Source%20code%20DoReMi/scripts/benchmark-phase64.ts) → [`qa/logs/phase64-benchmark-latest.json`](file:///G:/Source%20code%20DoReMi/qa/logs/phase64-benchmark-latest.json) & [`tests/phase64-playback-handover-e2e.test.ts`](file:///G:/Source%20code%20DoReMi/tests/phase64-playback-handover-e2e.test.ts)
- **Execution Environment**: Windows (`win32 x64`), Electron `45.4.1` (`Node v24.22.3`), `Intel(R) Core(TM) i5-14600K` (`20` logical CPUs, `31.65 GB` RAM)
- **Network Caveat**: Controlled local loopback LAN + simulated TLS Edge Remote Gateway (`127.0.0.1` + Test Root CA). Physical external Wi-Fi / 4G/5G hotspot latency and Tailscale free-tier relay throughput will add real-world WAN RTT (`~30–180 ms`).

---

## 1. Controlled 17-Scenario Benchmark Matrix (`qa/logs/phase64-benchmark-latest.json`)

| # | Scenario | Elapsed | CPU (% Logical) | RSS After | Heap Used | Key Verification Evidence |
|---|---|---|---|---|---|---|
| **1** | Local Playback without Server | `0.41 ms` | `0.00%` | `104.25 MB` | `16.98 MB` | `monitorArmed: false`, `activeTimers: 0` |
| **2** | Host OFF Idle | `3.11 ms` | `0.00%` | `104.18 MB` | `17.07 MB` | `hostState: "STOPPED"` |
| **3** | Host ON + Remote Gateway READY Idle | `2.25 ms` | `0.00%` | `105.16 MB` | `17.55 MB` | `hostState: "STANDBY"`, `remoteState: "READY"` |
| **4** | Client Connected over LAN Only (`1 MB` Range) | `29.32 ms` | `2.73%` | `112.14 MB` | `17.72 MB` | `activeTransport: "lan-direct"` |
| **5** | Client Connected over Remote HTTPS (`1 MB` Range) | `21.46 ms` | `3.73%` | `121.62 MB` | `18.61 MB` | `activeTransport: "remote-https"` |
| **6** | Client Connected in `Automatic` Mode (`500 ms` Idle) | `504.37 ms` | `0.00%` | `122.05 MB` | `19.07 MB` | `spuriousHealthChecksDuring500msIdle: 0` |
| **7** | Cold LAN Connection Establishment | `6.62 ms` | `12.08%` | `122.52 MB` | `19.46 MB` | TLS SPKI pin + `/library/summary` verified |
| **8** | Automatic Fallback to Remote HTTPS | `1,222.61 ms` | `0.00%` | `123.64 MB` | `20.12 MB` | Includes `1,200 ms` bounded mDNS LAN check + `verify-host` ECDSA proof |
| **9** | `LAN -> Remote` Handover (`Break-Before-Make` x5) | `6,185.94 ms` (total) | `0.10%` | `112.77 MB` | `20.08 MB` | **Median `1,231.88 ms`** · **Worst `1,236.15 ms`** (includes `1,200 ms` mDNS scan + Range reopen) |
| **10** | `Remote -> LAN` Handover (`Make-Before-Break` x5) | `6,755.37 ms` (total) | `0.15%` | `111.64 MB` | `19.34 MB` | **Median `95.43 ms`** · **Worst `113.50 ms`** (zero stream drop!) |
| **11** | Recovery from Temporary Network Loss (`Offline -> LAN`) | `91.52 ms` | `0.87%` | `111.87 MB` | `19.70 MB` | **Recovery latency `48.25 ms`** (`NETWORK_UNAVAILABLE -> CONNECTED_LAN`) |
| **12** | Recovery from Brief Interruption (`< failureThreshold=2`) | `0.49 ms` | `0.00%` | `111.87 MB` | `19.73 MB` | `DEGRADED -> CONNECTED_LAN`, **`unnecessaryHandovers: 0`** |
| **13** | Repeated Mode Switching (`x10` cycles) | `105.21 ms` | `6.70%` | `112.46 MB` | `20.69 MB` | Stable heap (`20.69 MB`), `finalState: "CONNECTED_LAN"` |
| **14** | Failed Reconnection Bounded Backoff (`Both Down`) | `1,298.87 ms` | `0.06%` | `111.83 MB` | `20.50 MB` | Rests in `HOST_UNAVAILABLE` with **`activeTimersAtRest: 0`** |
| **15** | `3` Active Clients Concurrent (`2 LAN + 1 Remote`) | `61.81 ms` | `3.72%` | `137.56 MB` | `24.38 MB` | `connectedDeviceCount: 3` (`3 × 1 MB` parallel streams) |
| **16** | Host Local Playback (`4 MB`) + Client Handover | `51.12 ms` | `4.69%` | `117.61 MB` | `16.47 MB` | Zero Host read stall; `finalTransport: "lan-direct"` |
| **17** | Clean Shutdown Resource Release | `27.95 ms` | `5.54%` | `117.73 MB` | `16.90 MB` | `clientActiveTimers: 0`, `clientMonitorRunning: false`, `hostActiveSessions: 0` |

---

## 2. Comparison Against `v1.0.0-rc.7` Baseline & Low-End Laptop Target (`i5-U / 8 GB RAM`)

1. **Startup & Bundle Size Overhead**:
   - Critical Local Player Renderer bundle (`out/renderer/assets/index-*.js`): **`677.38 kB` in `rc.8` vs `677.38 kB` in `rc.7` (`+0.00 kB` delta)** because `ServerPage` (`396.47 kB`) remains lazy-loaded via `React.lazy`.
   - Codec Engine (`codec-manager-*.js`): remains isolated at `122.05 kB`.
2. **Idle CPU & Memory in `Automatic` Mode**:
   - When disconnected (Local Playback): `0` timers, `0.00%` CPU, `~17 MB` JS heap.
   - When connected in `Automatic` mode: `NetworkChangeMonitor` checks in-memory `os.networkInterfaces()` once every `4,000 ms` (`timer.unref()`), generating **`0` network packets** and **`0.00%` measurable CPU** while idle (`+0.4 MB` JS heap vs `rc.7`).
3. **Chromium Multi-Codec Playback Handover Verification (`tests/phase64-playback-handover-e2e.test.ts`)**:
   - Verified end-to-end across `FLAC 16/44.1`, `ALAC 16/44.1` (*Có Thể (102112 Version)*), `ALAC 24/48` (`moov`-at-EOF), `WAV 16/44.1`, `AAC (.m4a)`, and `Hi-Res FLAC 24/96` (`12/12` handovers completed in `17.9 s` total suite runtime, position recovery within `< 0.5 s` tolerance, zero duplicate Listening Sessions, zero full-file ALAC download).
