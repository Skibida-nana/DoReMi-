import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LyricsService } from '../src/main/services/lyrics-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { NetworkChangeMonitor, type NetworkObservationSnapshot } from '../src/main/services/connect/network-monitor';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from '../tests/helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-bench64.tail6400.ts.net';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2))
    : Number(sorted[mid].toFixed(2));
}

async function measure(
  id: string,
  description: string,
  fn: () => Promise<Record<string, unknown> | void>,
) {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  const extra = (await fn()) ?? {};
  const elapsedMs = Math.max(0.1, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const cpuPct = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * logicalCpus)) * 100;
  return {
    id,
    description,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    cpuPercentOfLogicalCapacity: Number(cpuPct.toFixed(2)),
    rssMbBefore: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
    rssMbAfter: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMbAfter: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
    ...extra,
  };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-bench-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const songPath = path.join(musicDir, 'Bench64-8MB.flac');
  const songBytes = Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(8 * 1024 * 1024)]);
  await fs.writeFile(songPath, songBytes);
  const songStat = await fs.stat(songPath);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
  trackRepo.upsertBatch([
    {
      original_path: songPath,
      normalized_path: normalizeTrackPath(songPath),
      title: 'Bench Phase 6.4 8MB FLAC',
      artist: 'DoReMi Bench',
      album: 'Phase 6.4',
      duration_ms: 180_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 96000,
      bit_depth: 24,
      bitrate_bps: 2_800_000,
      file_size_bytes: songBytes.length,
      modified_at_ms: Math.round(songStat.mtimeMs),
      status: 'available',
    },
  ]);
  const track = trackRepo.findAll()[0];

  let routeTarget = '';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      if (args[0] === 'version') {
        return { ok: true, exitCode: 0, stdout: '{"majorMinorPatch":"1.78.1"}', stderr: '', timedOut: false, aborted: false };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: `${REMOTE_HOSTNAME}.`, Capabilities: ['https://tailscale.com/cap/funnel'] },
            CurrentTailnet: { MagicDNSSuffix: 'tail6400.ts.net', MagicDNSEnabled: true },
            CertDomains: [REMOTE_HOSTNAME],
          }),
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      }
      if (args[0] === 'funnel' && args[1] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: routeTarget
            ? JSON.stringify({
                Web: { [`${REMOTE_HOSTNAME}:443`]: { Handlers: { '/doremi-connect': { Proxy: routeTarget } } } },
                AllowFunnel: { [`${REMOTE_HOSTNAME}:443`]: true },
              })
            : '{}',
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      }
      if (args[0] === 'funnel' && args[1] === '--bg') {
        routeTarget = args[args.length - 1];
        return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
      }
      if (args[0] === 'funnel' && args.includes('off')) {
        routeTarget = '';
        return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
      }
      return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    },
  };

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443, maxActiveClients: 3 });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.8',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    enableMdns: false,
  });

  //Controllable LAN TCP gate for deterministic LAN <-> Remote handover benchmarks
  let lanGateOpen = true;
  let realLanPort = 0;
  const lanSockets = new Set<net.Socket>();
  const lanGate = net.createServer((sock) => {
    if (!lanGateOpen) {
      sock.destroy();
      return;
    }
    lanSockets.add(sock);
    const up = net.connect(realLanPort, '127.0.0.1');
    sock.pipe(up);
    up.pipe(sock);
    const clean = () => {
      lanSockets.delete(sock);
      sock.destroy();
      up.destroy();
    };
    sock.on('error', clean);
    up.on('error', clean);
    sock.on('close', clean);
    up.on('close', clean);
  });
  await new Promise<void>((r) => lanGate.listen(0, '127.0.0.1', r));
  const gatedLanPort = (lanGate.address() as { port: number }).port;

  let currentNetObs: NetworkObservationSnapshot = {
    hasAnyExternalIpv4: true,
    hasPrivateLanIpv4: true,
    lanAddresses: ['192.168.1.50'],
    signature: 'Wi-Fi=192.168.1.50/255.255.255.0',
  };
  const netMonitor = new NetworkChangeMonitor({
    pollIntervalMs: 4_000,
    inspectInterfaces: () => currentNetObs,
  });

  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let proxy: { port: number; close(): Promise<void> } | null = null;
  let proxyEnabled = true;

  const extraClients: Array<{ conn: ReturnType<typeof openLibraryDatabase>; svc: ConnectClientService }> = [];
  const scenarios: Array<Record<string, unknown>> = [];

  try {
    // 1. Local Playback without Server (verify zero background SmartConnection / NetworkMonitor activity)
    const idleClient = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
      networkMonitor: netMonitor,
    });
    scenarios.push(
      await measure('1_local_playback_without_server', 'Local file read with Server & Client disconnected', async () => {
        const fh = await fs.open(songPath, 'r');
        const buf = Buffer.alloc(262_144);
        await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        return {
          monitorArmed: idleClient.networkMonitor.isRunning(),
          activeTimers: idleClient.smartManager.getActiveTimerCount(),
        };
      }),
    );
    await idleClient.shutdown();

    // 2. Host OFF baseline
    scenarios.push(
      await measure('2_host_off_idle', 'Host OFF snapshot inspection', async () => {
        const snap = host.getSnapshot();
        return { hostState: snap.state };
      }),
    );

    // 3. Host ON idle
    await host.start();
    realLanPort = host.getSnapshot().listeningPort!;
    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    const rawProxy = await startSimulatedFunnelTlsProxy({
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: enabled.remoteAccess!.gatewayListeningPort!,
    });
    // Gate in front of simulated Funnel TLS proxy so Scenario 14 can toggle Remote down
    const remoteGateSockets = new Set<net.Socket>();
    const remoteGate = net.createServer((sock) => {
      if (!proxyEnabled) {
        sock.destroy();
        return;
      }
      remoteGateSockets.add(sock);
      const up = net.connect(rawProxy.port, '127.0.0.1');
      sock.pipe(up);
      up.pipe(sock);
      const clean = () => {
        remoteGateSockets.delete(sock);
        sock.destroy();
        up.destroy();
      };
      sock.on('error', clean);
      up.on('error', clean);
      sock.on('close', clean);
      up.on('close', clean);
    });
    await new Promise<void>((r) => remoteGate.listen(0, '127.0.0.1', r));
    const gatedRemotePort = (remoteGate.address() as { port: number }).port;
    proxy = {
      port: gatedRemotePort,
      close: async () => {
        for (const s of remoteGateSockets) s.destroy();
        await new Promise<void>((r) => remoteGate.close(() => r()));
        await rawProxy.close();
      },
    };

    scenarios.push(
      await measure('3_host_on_idle', 'Host ON + Remote Gateway READY idle', async () => {
        const snap = host.getSnapshot();
        return { hostState: snap.state, remoteState: snap.remoteAccess?.state };
      }),
    );

    const benchMonitor = new NetworkChangeMonitor({
      pollIntervalMs: 4_000,
      inspectInterfaces: () => currentNetObs,
    });
    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
      networkMonitor: benchMonitor,
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: proxy.port,
      },
      smartPolicy: {
        networkDebounceMs: 25,
        lanRecoveryConfirmMs: 35,
        switchCooldownMs: 15,
        failureThreshold: 2,
        retryBackoffMs: [30, 60, 120],
        maxAutoReconnectAttempts: 3,
        enableJitter: false,
      },
    });

    const hostId = enabled.identity!.hostId;
    const probe = await client.probeHost('127.0.0.1', gatedLanPort);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: gatedLanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Bench-Client-1',
    });
    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await client.syncRemoteAccessOverLan(hostId);
    const streamUrl = buildRemoteTrackMediaUrl(hostId, track.id);

    // 4. Client connected over LAN Only
    scenarios.push(
      await measure('4_client_connected_lan', 'LAN Only mode connect + 1 MB Range stream', async () => {
        await client.setConnectionMode(hostId, 'lan-only');
        const resp = await client.resolveRemoteTrackMediaResponse(
          new Request(streamUrl, { headers: { Range: 'bytes=0-1048575' } }),
        );
        await resp.arrayBuffer();
        return { activeTransport: client.getSnapshot().activeTransport };
      }),
    );

    // 5. Client connected over Remote HTTPS Only
    scenarios.push(
      await measure('5_client_connected_remote_https', 'Remote Only mode connect + 1 MB Range stream', async () => {
        await client.setConnectionMode(hostId, 'remote-only');
        const resp = await client.resolveRemoteTrackMediaResponse(
          new Request(streamUrl, { headers: { Range: 'bytes=0-1048575' } }),
        );
        await resp.arrayBuffer();
        return { activeTransport: client.getSnapshot().activeTransport };
      }),
    );

    // 6. Client connected in Automatic mode idle overhead (500ms observation -> 0 spurious health probes)
    await client.setConnectionMode(hostId, 'automatic');
    scenarios.push(
      await measure('6_automatic_mode_idle_500ms', 'Automatic mode connected idle 500ms', async () => {
        const hcBefore = client.smartManager.getDiagnosticsSnapshot().healthCheckCount;
        await sleep(500);
        const hcAfter = client.smartManager.getDiagnosticsSnapshot().healthCheckCount;
        return {
          smartState: client.getSnapshot().smartState,
          spuriousHealthChecksDuring500msIdle: hcAfter - hcBefore,
        };
      }),
    );

    // 7. LAN connection establishment time
    await client.disconnect();
    scenarios.push(
      await measure('7_lan_connection_establishment', 'Cold connect to verified LAN Direct', async () => {
        const snap = await client.connectToRememberedHost(hostId);
        return { smartState: snap.smartState, activeTransport: snap.activeTransport };
      }),
    );

    // 8. Remote HTTPS connection establishment time
    await client.disconnect();
    lanGateOpen = false;
    scenarios.push(
      await measure('8_remote_https_connection_establishment', 'Automatic connect falling back to verified Remote HTTPS', async () => {
        const snap = await client.connectToRememberedHost(hostId);
        return { smartState: snap.smartState, activeTransport: snap.activeTransport };
      }),
    );
    lanGateOpen = true;
    await client.connectToRememberedHost(hostId);

    // 9 & 10. LAN -> Remote (Break-Before-Make) & Remote -> LAN (Make-Before-Break) x5 cycles with stream reopen
    const lanToRemSamples: number[] = [];
    const remToLanSamples: number[] = [];
    scenarios.push(
      await measure('9_lan_to_remote_handover_x5', '5 cycles of LAN -> Remote Break-Before-Make handover + Range reopen', async () => {
        for (let i = 0; i < 5; i += 1) {
          await client.connectToRememberedHost(hostId);
          const tStart = performance.now();
          lanGateOpen = false;
          for (const s of lanSockets) s.destroy();
          await client.smartManager.reportTransportFailure({
            hostId,
            transport: 'lan-direct',
            errorCode: 'NETWORK_INTERRUPTED',
            message: 'Simulated LAN drop',
            immediate: true,
          });
          const resp = await client.resolveRemoteTrackMediaResponse(
            new Request(streamUrl, { headers: { Range: 'bytes=262144-327679' } }),
          );
          await resp.arrayBuffer();
          lanToRemSamples.push(Number((performance.now() - tStart).toFixed(2)));
          lanGateOpen = true;
        }
        return {
          samplesMs: lanToRemSamples,
          medianHandoverMs: median(lanToRemSamples),
          worstHandoverMs: Math.max(...lanToRemSamples),
        };
      }),
    );

    scenarios.push(
      await measure('10_remote_to_lan_make_before_break_x5', '5 cycles of Remote -> LAN Make-Before-Break handover + Range reopen', async () => {
        for (let i = 0; i < 5; i += 1) {
          lanGateOpen = false;
          await client.connectToRememberedHost(hostId);
          await sleep(20);
          const tStart = performance.now();
          lanGateOpen = true;
          currentNetObs = {
            ...currentNetObs,
            signature: `Wi-Fi=192.168.1.${70 + i}/255.255.255.0`,
            lanAddresses: [`192.168.1.${70 + i}`],
          };
          benchMonitor.checkNow();
          while (client.getSnapshot().activeTransport !== 'lan-direct') {
            await sleep(5);
          }
          const resp = await client.resolveRemoteTrackMediaResponse(
            new Request(streamUrl, { headers: { Range: 'bytes=524288-589823' } }),
          );
          await resp.arrayBuffer();
          remToLanSamples.push(Number((performance.now() - tStart).toFixed(2)));
        }
        return {
          samplesMs: remToLanSamples,
          medianHandoverMs: median(remToLanSamples),
          worstHandoverMs: Math.max(...remToLanSamples),
        };
      }),
    );

    // 11. Recovery from temporary network loss (Offline -> Online)
    scenarios.push(
      await measure('11_recovery_from_network_loss', 'Offline transition -> Network restored automatic reconnect', async () => {
        currentNetObs = {
          hasAnyExternalIpv4: false,
          hasPrivateLanIpv4: false,
          lanAddresses: [],
          signature: '',
        };
        benchMonitor.checkNow();
        await sleep(40);
        const offlineState = client.getSnapshot().smartState;
        const tRec = performance.now();
        currentNetObs = {
          hasAnyExternalIpv4: true,
          hasPrivateLanIpv4: true,
          lanAddresses: ['192.168.1.50'],
          signature: 'Wi-Fi=192.168.1.50/255.255.255.0',
        };
        benchMonitor.checkNow();
        while (client.getSnapshot().status !== 'connected') {
          await sleep(5);
        }
        return {
          offlineState,
          recoveredState: client.getSnapshot().smartState,
          recoveryLatencyMs: Number((performance.now() - tRec).toFixed(2)),
        };
      }),
    );

    // 12. Recovery from brief interruption (< failureThreshold)
    scenarios.push(
      await measure('12_recovery_from_brief_interruption', 'Single transient socket error below failureThreshold=2', async () => {
        const handoversBefore = client.smartManager.getDiagnosticsSnapshot().recentHandovers.length;
        await client.smartManager.reportTransportFailure({
          hostId,
          transport: 'lan-direct',
          errorCode: 'NETWORK_INTERRUPTED',
          message: 'brief 1-packet glitch',
        });
        const degradedState = client.getSnapshot().smartState;
        client.smartManager.recordTransportSuccess('lan-direct');
        const handoversAfter = client.smartManager.getDiagnosticsSnapshot().recentHandovers.length;
        return {
          degradedState,
          restoredState: client.getSnapshot().smartState,
          unnecessaryHandovers: handoversAfter - handoversBefore,
        };
      }),
    );

    // 13. Repeated mode switching x10
    scenarios.push(
      await measure('13_repeated_mode_switching_x10', '10 consecutive mode switches (Automatic -> Remote Only -> LAN Only)', async () => {
        const modes = ['remote-only', 'lan-only', 'automatic'] as const;
        for (let i = 0; i < 10; i += 1) {
          await client.setConnectionMode(hostId, modes[i % modes.length]);
        }
        await client.setConnectionMode(hostId, 'automatic');
        return { finalState: client.getSnapshot().smartState };
      }),
    );

    // 14. Failed reconnection backoff behavior (caps at maxAutoReconnectAttempts=3 -> 0 active timers)
    scenarios.push(
      await measure('14_failed_reconnection_bounded_backoff', 'Both LAN & Remote down -> 3 bounded backoff retries -> HOST_UNAVAILABLE', async () => {
        lanGateOpen = false;
        proxyEnabled = false;
        for (const s of lanSockets) s.destroy();
        await client.smartManager.reportTransportFailure({
          hostId,
          transport: 'lan-direct',
          errorCode: 'NETWORK_INTERRUPTED',
          message: 'total outage',
          immediate: true,
        });
        while (client.getSnapshot().smartState === 'RECONNECTING') {
          await sleep(10);
        }
        const retries = client.smartManager.getRetryCount();
        const timersAfterCap = client.smartManager.getActiveTimerCount();
        lanGateOpen = true;
        proxyEnabled = true;
        await client.manualReconnect();
        return {
          retriesExecuted: retries,
          activeTimersAtRest: timersAfterCap,
          recoveredAfterManualRetry: client.getSnapshot().smartState,
        };
      }),
    );

    // 15. 3 Active Clients (mixed LAN + Remote)
    for (let idx = 0; idx < 2; idx += 1) {
      const eDir = path.join(tmpRoot, `extra-${idx}`);
      await fs.mkdir(eDir, { recursive: true });
      const eConn = openLibraryDatabase(path.join(eDir, 'library.db'));
      const eSvc = new ConnectClientService({
        connectRepo: new ConnectRepository(eConn.db),
        secrets: new ConnectSecretStorage({ userDataDir: eDir, allowFileFallback: true }),
        publicHttpsOptions: {
          ca: ca.caCertPem,
          lookup: createLoopbackLookup(REMOTE_HOSTNAME),
          connectOverridePort: proxy.port,
        },
      });
      const p = await eSvc.probeHost('127.0.0.1', gatedLanPort);
      const i = host.createInvitation({ autoApproveSingleUse: true });
      await eSvc.enrollWithHost({
        address: '127.0.0.1',
        port: gatedLanPort,
        expectedFingerprintSha256: p.observedFingerprintSha256!,
        inviteCode: i.inviteCode,
        deviceName: `Bench-Extra-${idx + 2}`,
      });
      const dId = host.getSnapshot().authorizedDevices.find((d) => d.displayName === `Bench-Extra-${idx + 2}`)!.deviceId;
      host.setDeviceRemoteAccess(dId, true);
      await eSvc.syncRemoteAccessOverLan(hostId);
      if (idx === 0) {
        await eSvc.setConnectionMode(hostId, 'remote-only');
      }
      extraClients.push({ conn: eConn, svc: eSvc });
    }

    scenarios.push(
      await measure('15_three_active_clients_concurrent', '3 simultaneous Clients (2 LAN + 1 Remote HTTPS) streaming 1 MB each', async () => {
        await Promise.all([
          client
            .resolveRemoteTrackMediaResponse(new Request(streamUrl, { headers: { Range: 'bytes=0-1048575' } }))
            .then((r) => r.arrayBuffer()),
          extraClients[0].svc
            .resolveRemoteTrackMediaResponse(new Request(streamUrl, { headers: { Range: 'bytes=1048576-2097151' } }))
            .then((r) => r.arrayBuffer()),
          extraClients[1].svc
            .resolveRemoteTrackMediaResponse(new Request(streamUrl, { headers: { Range: 'bytes=2097152-3145727' } }))
            .then((r) => r.arrayBuffer()),
        ]);
        return {
          connectedDeviceCount: host.getSnapshot().metrics.hostMetrics.connectedDeviceCount,
        };
      }),
    );

    // 16. Host local playback concurrent with active Client handover
    scenarios.push(
      await measure('16_host_local_playback_plus_client_handover', 'Host reading local 4 MB FLAC chunks while Client switches LAN -> Remote -> LAN', async () => {
        const localReadTask = (async () => {
          const fh = await fs.open(songPath, 'r');
          const chunk = Buffer.alloc(524_288);
          for (let off = 0; off < 4 * 1024 * 1024; off += chunk.length) {
            await fh.read(chunk, 0, chunk.length, off);
          }
          await fh.close();
        })();
        const handoverTask = (async () => {
          await client.setConnectionMode(hostId, 'remote-only');
          const r1 = await client.resolveRemoteTrackMediaResponse(
            new Request(streamUrl, { headers: { Range: 'bytes=0-262143' } }),
          );
          await r1.arrayBuffer();
          await client.setConnectionMode(hostId, 'automatic');
          const r2 = await client.resolveRemoteTrackMediaResponse(
            new Request(streamUrl, { headers: { Range: 'bytes=262144-524287' } }),
          );
          await r2.arrayBuffer();
        })();
        await Promise.all([localReadTask, handoverTask]);
        return { finalTransport: client.getSnapshot().activeTransport };
      }),
    );

    // 17. Clean shutdown resource release
    scenarios.push(
      await measure('17_clean_shutdown_resource_release', 'Shutdown all 3 Clients + Host and verify 0 timers/monitors/sessions', async () => {
        for (const ec of extraClients) {
          await ec.svc.shutdown();
        }
        await client.shutdown();
        await host.stop();
        return {
          clientActiveTimers: client.smartManager.getActiveTimerCount(),
          clientMonitorRunning: client.networkMonitor.isRunning(),
          hostState: host.getSnapshot().state,
          hostActiveSessions: host.getSnapshot().activeSessions.length,
        };
      }),
    );

    const outDir = path.join(process.cwd(), 'qa', 'logs');
    await fs.mkdir(outDir, { recursive: true });
    const summary = {
      generatedAt: new Date().toISOString(),
      phase: '6.4',
      version: '1.0.0-rc.8',
      environment:
        'Controlled Local Loopback LAN + Simulated TLS Edge Remote Gateway (NOT physical mobile hotspot / external Internet)',
      cpuModel: os.cpus()[0]?.model ?? 'Unknown CPU',
      logicalCpus: os.cpus().length,
      totalSystemRamGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      scenarios,
    };
    await fs.writeFile(
      path.join(outDir, 'phase64-benchmark-latest.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const ec of extraClients) {
      await ec.svc.shutdown().catch(() => {});
      ec.conn.close();
    }
    for (const s of lanSockets) s.destroy();
    await new Promise<void>((r) => lanGate.close(() => r()));
    await proxy?.close().catch(() => {});
    await host.stop().catch(() => {});
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
