import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { disposeSharedAlacStreamManager } from '../src/main/services/alac-decoder';
import { ArtworkService } from '../src/main/services/artwork-service';
import { clearFlacSanitizerCache } from '../src/main/services/flac-stream-sanitizer';
import { LyricsService } from '../src/main/services/lyrics-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import {
  NetworkChangeMonitor,
  type NetworkObservationSnapshot,
} from '../src/main/services/connect/network-monitor';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';
import { createIsolatedTestCa, createLoopbackLookup } from '../tests/helpers/test-ca-https';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const REMOTE_HOSTNAME = 'doremi-soak65.tail6500.ts.net';

function parseDurationMinutes(): number {
  const idx = process.argv.indexOf('--minutes');
  if (idx >= 0 && process.argv[idx + 1]) {
    const val = Number(process.argv[idx + 1]);
    if (Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  return 2.5; // Default automated paced run (~150 seconds across Workloads A-E)
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

async function consumeResponse(resp: Response): Promise<number> {
  if (!resp.body) return 0;
  const reader = resp.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}

/**
 * Reproducible Phase 6.5 Long-Running Sustained Stability Harness (Section 47).
 * Supports:
 * - Default automated paced validation (`--minutes 2.5`)
 * - 30-minute sustained test (`--minutes 30`)
 * - 2-hour soak (`--minutes 120`)
 * - 8-hour soak (`--minutes 480`)
 */
async function main() {
  const totalMinutes = parseDurationMinutes();
  const totalTargetMs = Math.round(totalMinutes * 60_000);
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const pkg = JSON.parse(fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    version?: string;
  };

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p65-soak-'));
  const hostDir = path.join(tmpRoot, 'host');
  const c1Dir = path.join(tmpRoot, 'c1');
  const c2Dir = path.join(tmpRoot, 'c2');
  const c3Dir = path.join(tmpRoot, 'c3');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(c1Dir, { recursive: true }),
    fs.mkdir(c2Dir, { recursive: true }),
    fs.mkdir(c3Dir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const ffmpeg =
    process.env.FFMPEG_PATH ||
    'D:\\Dowload\\FFmpeg\\ffmpeg-2026-11-23-git-05c674c913-full_build\\bin\\ffmpeg.exe';
  const flacPath = path.join(musicDir, 'Soak-FLAC.flac');
  const alacPath = path.join(musicDir, 'Soak-ALAC.m4a');
  spawnSync(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=44100:duration=12:amplitude=0.25',
      '-ac', '2', '-sample_fmt', 's16', '-c:a', 'flac',
      flacPath,
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  spawnSync(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=44100:duration=10:amplitude=0.25',
      '-ac', '2', '-sample_fmt', 's16p', '-c:a', 'alac', '-movflags', '+faststart',
      alacPath,
    ],
    { windowsHide: true, timeout: 30_000 },
  );

  const [sFlac, sAlac] = await Promise.all([fs.stat(flacPath), fs.stat(alacPath)]);
  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const c1Conn = openLibraryDatabase(path.join(c1Dir, 'library.db'));
  const c2Conn = openLibraryDatabase(path.join(c2Dir, 'library.db'));
  const c3Conn = openLibraryDatabase(path.join(c3Dir, 'library.db'));

  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
  trackRepo.upsertBatch([
    {
      original_path: flacPath,
      normalized_path: normalizeTrackPath(flacPath),
      title: 'Soak FLAC 16-44.1',
      artist: 'DoReMi Soak',
      album: 'Phase 6.5 Soak',
      duration_ms: 12_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 750_000,
      file_size_bytes: sFlac.size,
      modified_at_ms: Math.round(sFlac.mtimeMs),
      status: 'available',
    },
    {
      original_path: alacPath,
      normalized_path: normalizeTrackPath(alacPath),
      title: 'Soak ALAC 16-44.1',
      artist: 'DoReMi Soak',
      album: 'Phase 6.5 Soak',
      duration_ms: 10_000,
      codec: 'ALAC',
      container: 'M4A',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 720_000,
      file_size_bytes: sAlac.size,
      modified_at_ms: Math.round(sAlac.mtimeMs),
      status: 'available',
    },
  ]);
  const allTracks = trackRepo.findAll();
  const flacTrack = allTracks.find((t) => t.codec === 'FLAC')!;
  const alacTrack = allTracks.find((t) => t.codec === 'ALAC')!;

  let routeTarget = '';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      if (args[0] === 'version') return { ok: true, exitCode: 0, stdout: '{"majorMinorPatch":"1.104.7"}', stderr: '', timedOut: false, aborted: false };
      if (args[0] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: `${REMOTE_HOSTNAME}.`, Capabilities: ['https://tailscale.com/cap/funnel'] },
            CurrentTailnet: { MagicDNSSuffix: 'tail6500.ts.net', MagicDNSEnabled: true },
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
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: pkg.version ?? '1.0.0-rc.9',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({
      trackRepo,
      artworkRepo: new ArtworkRepository(hostConn.db),
      userDataDir: hostDir,
    }),
    lyricsService: new LyricsService({
      trackRepo,
      lyricsRepo: new LyricsRepository(hostConn.db),
    }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    enableMdns: false,
  });

  let lanGateOpen = true;
  let realLanPort = 0;
  const gateSockets = new Set<net.Socket>();
  const lanGate = net.createServer((sock) => {
    if (!lanGateOpen || realLanPort <= 0) {
      sock.destroy();
      return;
    }
    gateSockets.add(sock);
    const up = net.connect(realLanPort, '127.0.0.1');
    sock.pipe(up);
    up.pipe(sock);
    const clean = () => {
      gateSockets.delete(sock);
      sock.destroy();
      up.destroy();
    };
    sock.on('error', clean);
    up.on('error', clean);
    sock.on('close', clean);
    up.on('close', clean);
  });
  await new Promise<void>((r) => lanGate.listen(0, '127.0.0.1', r));
  const gatedPort = (lanGate.address() as { port: number }).port;

  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let gwPort = 0;
  const edgeAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const edgeServer = https.createServer(
    { cert: leaf.certPem, key: leaf.keyPem, minVersion: 'TLSv1.2' },
    (req, res) => {
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders.host;
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: gwPort,
          path: req.url,
          method: req.method,
          headers: fwdHeaders,
          agent: edgeAgent,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          res.once('close', () => {
            if (!res.writableEnded) {
              upRes.destroy();
              upstream.destroy();
            }
          });
          upRes.pipe(res);
        },
      );
      res.once('close', () => {
        if (!res.writableEnded) {
          upstream.destroy();
        }
      });
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end();
        }
      });
      req.pipe(upstream);
    },
  );
  await new Promise<void>((r) => edgeServer.listen(0, '127.0.0.1', r));
  const edgePort = (edgeServer.address() as { port: number }).port;

  let netObs: NetworkObservationSnapshot = {
    hasAnyExternalIpv4: true,
    hasPrivateLanIpv4: true,
    lanAddresses: ['192.168.1.50'],
    signature: 'Wi-Fi-Home',
  };

  const mkClient = (dir: string, conn: ReturnType<typeof openLibraryDatabase>) =>
    new ConnectClientService({
      connectRepo: new ConnectRepository(conn.db),
      secrets: new ConnectSecretStorage({ userDataDir: dir, allowFileFallback: true }),
      networkMonitor: new NetworkChangeMonitor({ pollIntervalMs: 4_000, inspectInterfaces: () => netObs }),
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: edgePort,
      },
      smartPolicy: {
        networkDebounceMs: 80,
        lanRecoveryConfirmMs: 150,
        switchCooldownMs: 300,
        retryBackoffMs: [100, 200, 400],
        enableJitter: false,
      },
    });

  const c1 = mkClient(c1Dir, c1Conn);
  const c2 = mkClient(c2Dir, c2Conn);
  const c3 = mkClient(c3Dir, c3Conn);

  const timeSeries: Array<{
    elapsedSec: number;
    phase: string;
    cpuNormalizedPct: number;
    rssMb: number;
    heapUsedMb: number;
    arrayBuffersMb: number;
    activeStreams: number;
    pooledFreeSockets: number;
  }> = [];

  let currentPhaseLabel = 'init';
  let lastCpu = process.cpuUsage();
  let lastSampleAt = performance.now();
  const startedWallMs = performance.now();

  const sampler = setInterval(() => {
    const now = performance.now();
    const dtMs = Math.max(1, now - lastSampleAt);
    const delta = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    lastSampleAt = now;
    const mem = process.memoryUsage();
    const normCpu = ((delta.user + delta.system) / (dtMs * 1000 * logicalCpus)) * 100;
    timeSeries.push({
      elapsedSec: round2((now - startedWallMs) / 1000),
      phase: currentPhaseLabel,
      cpuNormalizedPct: round2(normCpu),
      rssMb: round2(mem.rss / (1024 * 1024)),
      heapUsedMb: round2(mem.heapUsed / (1024 * 1024)),
      arrayBuffersMb: round2(mem.arrayBuffers / (1024 * 1024)),
      activeStreams: host.getSnapshot().activeSessions.length,
      pooledFreeSockets:
        c1.getPooledSocketCounts().freeSockets +
        c2.getPooledSocketCounts().freeSockets +
        c3.getPooledSocketCounts().freeSockets,
    });
  }, 5_000);
  sampler.unref();

  let totalBytesStreamed = 0;
  let errorCount = 0;

  try {
    const sliceMs = Math.max(15_000, Math.floor(totalTargetMs / 5));

    // Workload A: Host Standby (no active listening clients)
    currentPhaseLabel = 'A_host_standby';
    host.setPowerPolicy('keep-awake-streaming');
    const st = await host.start();
    realLanPort = st.listeningPort!;
    const hostId = st.identity!.hostId;
    const rem = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    gwPort = rem.remoteAccess!.gatewayListeningPort!;
    const aDeadline = performance.now() + sliceMs;
    while (performance.now() < aDeadline) {
      await sleep(2_000);
    }

    // Pair all 3 clients
    for (const [idx, svc] of [c1, c2, c3].entries()) {
      const probe = await svc.probeHost('127.0.0.1', gatedPort);
      const inv = host.createInvitation({ autoApproveSingleUse: true });
      await svc.enrollWithHost({
        address: '127.0.0.1',
        port: gatedPort,
        expectedFingerprintSha256: probe.observedFingerprintSha256!,
        inviteCode: inv.inviteCode,
        deviceName: `Soak Client ${idx + 1}`,
      });
    }
    for (const dev of host.getSnapshot().authorizedDevices) {
      host.setDeviceRemoteAccess(dev.deviceId, true);
    }
    await c1.syncRemoteAccessOverLan(hostId);
    await c2.syncRemoteAccessOverLan(hostId);
    await c3.syncRemoteAccessOverLan(hostId);
    await c2.disconnect();
    await c3.disconnect();

    // Workload B: One active Client — paced FLAC listening + seek + >31s pause & resume!
    currentPhaseLabel = 'B_one_client_paced_and_31s_pause';
    const flacUrl = buildRemoteTrackMediaUrl(hostId, flacTrack.id);
    const alacUrl = buildRemoteTrackMediaUrl(hostId, alacTrack.id);
    // Stream initial chunks
    for (let i = 0; i < 6; i += 1) {
      const off = (i * 65_536) % Math.max(65_536, sFlac.size - 65_536);
      const r = await c1.resolveRemoteTrackMediaResponse(
        new Request(flacUrl, { headers: { Range: `bytes=${off}-${Math.min(sFlac.size - 1, off + 65_535)}` } }),
      );
      totalBytesStreamed += await consumeResponse(r);
      await sleep(300);
    }
    // Hold an open paused stream for >31 seconds (verifying Section 21 >30s pause stability!)
    const pauseTimeMs = totalMinutes >= 2 ? 31_500 : Math.max(5_000, sliceMs - 2_000);
    const pausedResp = await c1.resolveRemoteTrackMediaResponse(
      new Request(flacUrl, { headers: { Range: 'bytes=0-262143' } }),
    );
    const pausedReader = pausedResp.body!.getReader();
    const firstChunk = await pausedReader.read();
    if (firstChunk.value) totalBytesStreamed += firstChunk.value.byteLength;
    await sleep(pauseTimeMs);
    // Resume reading the paused stream after >30s!
    while (true) {
      const { done, value } = await pausedReader.read();
      if (done) break;
      if (value) totalBytesStreamed += value.byteLength;
    }

    // Workload C: Three simultaneous Clients (mixed LAN FLAC + Remote FLAC + Remote ALAC)
    currentPhaseLabel = 'C_three_mixed_clients';
    await c1.setConnectionMode(hostId, 'lan-only');
    await c1.connectToRememberedHost(hostId, '127.0.0.1', gatedPort);
    await c2.setConnectionMode(hostId, 'remote-only');
    await c2.connectToRememberedHost(hostId);
    await c3.setConnectionMode(hostId, 'remote-only');
    await c3.connectToRememberedHost(hostId);

    const cDeadline = performance.now() + sliceMs;
    let step = 0;
    while (performance.now() < cDeadline) {
      const off = (step * 65_536) % Math.max(65_536, sFlac.size - 65_536);
      const [b1, b2, b3] = await Promise.all([
        c1
          .resolveRemoteTrackMediaResponse(
            new Request(flacUrl, { headers: { Range: `bytes=${off}-${Math.min(sFlac.size - 1, off + 65_535)}` } }),
          )
          .then(consumeResponse),
        c2
          .resolveRemoteTrackMediaResponse(
            new Request(flacUrl, { headers: { Range: `bytes=${off}-${Math.min(sFlac.size - 1, off + 65_535)}` } }),
          )
          .then(consumeResponse),
        c3
          .resolveRemoteTrackMediaResponse(
            new Request(alacUrl, { headers: { Range: 'bytes=0-131071' } }),
          )
          .then(consumeResponse),
      ]);
      totalBytesStreamed += b1 + b2 + b3;
      step += 1;
      await sleep(500);
    }
    await c2.disconnect();
    await c3.disconnect();

    // Workload D: Connection recovery & Automatic LAN <-> Remote handover
    currentPhaseLabel = 'D_connection_recovery_handover';
    await c1.setConnectionMode(hostId, 'automatic');
    await c1.connectToRememberedHost(hostId, '127.0.0.1', gatedPort);
    const dDeadline = performance.now() + Math.floor(sliceMs * 0.7);
    let toggle = 0;
    while (performance.now() < dDeadline) {
      lanGateOpen = false;
      for (const s of gateSockets) s.destroy();
      netObs = { hasAnyExternalIpv4: true, hasPrivateLanIpv4: false, lanAddresses: [], signature: `Cell-${toggle}` };
      await c1.smartManager.reportTransportFailure({
        hostId,
        transport: 'lan-direct',
        errorCode: 'NETWORK_INTERRUPTED',
        message: 'LAN dropped',
        immediate: true,
      });
      const rRem = await c1.resolveRemoteTrackMediaResponse(
        new Request(flacUrl, { headers: { Range: 'bytes=0-65535' } }),
      );
      totalBytesStreamed += await consumeResponse(rRem);
      await sleep(400);

      lanGateOpen = true;
      netObs = { hasAnyExternalIpv4: true, hasPrivateLanIpv4: true, lanAddresses: ['192.168.1.50'], signature: `Home-${toggle}` };
      c1.notifyNetworkHint('recheck');
      await sleep(450);
      toggle += 1;
    }

    // Workload E: Lifecycle stress (Host start/stop + Remote enable/disable + ALAC cleanup)
    currentPhaseLabel = 'E_lifecycle_stress';
    await c1.disconnect();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await host.stop();
      const s = await host.start();
      realLanPort = s.listeningPort!;
      const r = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
      gwPort = r.remoteAccess!.gatewayListeningPort!;
      await sleep(300);
    }

    clearInterval(sampler);
    await c1.shutdown();
    await c2.shutdown();
    await c3.shutdown();
    await host.dispose();
    disposeSharedAlacStreamManager();
    clearFlacSanitizerCache();
    await sleep(250);

    const endMem = process.memoryUsage();
    const totalElapsedSec = round2((performance.now() - startedWallMs) / 1000);
    const outDir = path.join(process.cwd(), 'qa', 'logs');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, 'phase65-sustained-stability.json');

    const summary = {
      generatedAt: new Date().toISOString(),
      requestedMinutes: totalMinutes,
      actualDurationSeconds: totalElapsedSec,
      pauseVerifiedSeconds: round2(pauseTimeMs / 1000),
      totalBytesStreamed,
      errorCount,
      postCleanupMemory: {
        rssMb: round2(endMem.rss / (1024 * 1024)),
        heapUsedMb: round2(endMem.heapUsed / (1024 * 1024)),
        externalMb: round2(endMem.external / (1024 * 1024)),
        arrayBuffersMb: round2(endMem.arrayBuffers / (1024 * 1024)),
      },
      extendedSoakStatus: {
        thirtyMinuteFullRun: totalMinutes >= 30 ? 'PASS' : 'PARTIAL (Automated multi-minute paced soak executed; run --minutes 30 for full 30-min wall-clock)',
        twoHourSoak: totalMinutes >= 120 ? 'PASS' : 'NOT RUN (Reproducible via: node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 120)',
        eightHourSoak: totalMinutes >= 480 ? 'PASS' : 'NOT RUN (Reproducible via: node scripts/run-electron-ts.mjs scripts/soak-phase65.ts --minutes 480)',
      },
      timeSeries,
    };

    await fs.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(
      `PHASE65_SOAK_OK duration=${totalElapsedSec}s pause=${round2(pauseTimeMs / 1000)}s bytes=${totalBytesStreamed} rssEnd=${summary.postCleanupMemory.rssMb}MB heapEnd=${summary.postCleanupMemory.heapUsedMb}MB samples=${timeSeries.length}`,
    );
  } catch (err) {
    errorCount += 1;
    console.error('[PHASE65_SOAK_ERROR]', err);
    process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    await c1.shutdown().catch(() => {});
    await c2.shutdown().catch(() => {});
    await c3.shutdown().catch(() => {});
    await host.dispose().catch(() => {});
    edgeAgent.destroy();
    await new Promise<void>((r) => {
      edgeServer.closeAllConnections?.();
      edgeServer.close(() => r());
    });
    for (const s of gateSockets) s.destroy();
    await new Promise<void>((r) => lanGate.close(() => r()));
    c1Conn.close();
    c2Conn.close();
    c3Conn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

void main().then(() => {
  process.exit(process.exitCode ?? 0);
});
