import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as electronModule from 'electron';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { disposeSharedAlacStreamManager, getAlacStreamManager } from '../src/main/services/alac-decoder';
import { ArtworkService } from '../src/main/services/artwork-service';
import { resolveTrackMediaResponse } from '../src/main/services/audio-stream-handler';
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
import {
  buildRemoteTrackMediaUrl,
  buildTrackMediaUrl,
} from '../src/shared/contracts/media-protocol';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
} from '../tests/helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-bench65.tail6500.ts.net';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parsePhaseArg(): 'before' | 'after' {
  const idx = process.argv.indexOf('--phase');
  if (idx >= 0 && process.argv[idx + 1] === 'before') {
    return 'before';
  }
  if (idx >= 0 && process.argv[idx + 1] === 'after') {
    return 'after';
  }
  return 'after';
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2((sorted[mid - 1] + sorted[mid]) / 2)
    : round2(sorted[mid]);
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round2(values.reduce((acc, v) => acc + v, 0) / values.length);
}

function peak(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round2(Math.max(...values));
}

function inspectNodeHandles(): {
  totalActiveHandles: number;
  timerHandles: number;
  socketHandles: number;
  fsReqCount: number;
} {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  const getReqs = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests;
  const handles = typeof getHandles === 'function' ? getHandles.call(process) : [];
  const reqs = typeof getReqs === 'function' ? getReqs.call(process) : [];
  let timerHandles = 0;
  let socketHandles = 0;
  for (const h of handles) {
    const name = (h as { constructor?: { name?: string } } | null)?.constructor?.name ?? '';
    if (name === 'Timeout' || name === 'TimersList') timerHandles += 1;
    if (name === 'Socket' || name === 'TLSSocket') socketHandles += 1;
  }
  return {
    totalActiveHandles: handles.length,
    timerHandles,
    socketHandles,
    fsReqCount: reqs.length,
  };
}

const electronApp = (electronModule as unknown as {
  app?: {
    whenReady?: () => Promise<void>;
    getVersion?: () => string;
    getAppMetrics?: () => Array<{
      memory?: { workingSetSize?: number; privateBytes?: number };
    }>;
    exit?: (code: number) => void;
  };
}).app;

function readPackageVersion(): string {
  try {
    if (electronApp && typeof electronApp.getVersion === 'function') {
      return electronApp.getVersion();
    }
    const pkg = JSON.parse(
      fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '1.0.0-rc.8';
  } catch {
    return '1.0.0-rc.8';
  }
}

function sampleAppProcessTreeWorkingSetMb(): {
  processCount: number;
  workingSetSumMb: number;
  privateMbSum: number | null;
} {
  try {
    if (electronApp && typeof electronApp.getAppMetrics === 'function') {
      const metrics = electronApp.getAppMetrics();
      let wsKb = 0;
      let privKb = 0;
      let hasPriv = false;
      for (const m of metrics) {
        wsKb += m.memory?.workingSetSize ?? 0;
        if (typeof m.memory?.privateBytes === 'number') {
          privKb += m.memory.privateBytes;
          hasPriv = true;
        }
      }
      return {
        processCount: metrics.length,
        workingSetSumMb: round2(wsKb / 1024),
        privateMbSum: hasPriv ? round2(privKb / 1024) : null,
      };
    }
  } catch {
    // Fallback if app metrics unavailable
  }
  return {
    processCount: 1,
    workingSetSumMb: round2(process.memoryUsage().rss / (1024 * 1024)),
    privateMbSum: null,
  };
}

function readTailscaleProcessesReadOnly(): {
  running: boolean;
  processCount: number;
  workingSetSumMb: number;
  privateMemorySumMb: number;
  totalCpuSeconds: number;
  processNames: string[];
} {
  try {
    const psCmd =
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'tailscale*' } | Select-Object ProcessName,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress";
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    ).trim();
    if (!raw) {
      return {
        running: false,
        processCount: 0,
        workingSetSumMb: 0,
        privateMemorySumMb: 0,
        totalCpuSeconds: 0,
        processNames: [],
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      ProcessName?: string;
      WorkingSet64?: number;
      PrivateMemorySize64?: number;
      CPU?: number | null;
    }>;
    let ws = 0;
    let priv = 0;
    let cpu = 0;
    const names: string[] = [];
    for (const item of list) {
      if (item.ProcessName) names.push(item.ProcessName);
      ws += Number(item.WorkingSet64 ?? 0);
      priv += Number(item.PrivateMemorySize64 ?? 0);
      cpu += Number(item.CPU ?? 0);
    }
    return {
      running: list.length > 0,
      processCount: list.length,
      workingSetSumMb: round2(ws / (1024 * 1024)),
      privateMemorySumMb: round2(priv / (1024 * 1024)),
      totalCpuSeconds: round2(cpu),
      processNames: names,
    };
  } catch {
    return {
      running: false,
      processCount: 0,
      workingSetSumMb: 0,
      privateMemorySumMb: 0,
      totalCpuSeconds: 0,
      processNames: [],
    };
  }
}

async function generateAudioFixtures(musicDir: string): Promise<{
  flac16Path: string;
  flacHiResPath: string;
  alac16Path: string;
  alac24Path: string;
  wavPath: string;
}> {
  const ffmpeg =
    process.env.FFMPEG_PATH ||
    'D:\\Dowload\\FFmpeg\\ffmpeg-2026-11-23-git-05c674c913-full_build\\bin\\ffmpeg.exe';

  const flac16Path = path.join(musicDir, 'Bench65-FLAC-16-44k.flac');
  const flacHiResPath = path.join(musicDir, 'Bench65-HiRes-24-96k.flac');
  const alac16Path = path.join(musicDir, 'Co-The-102112-Bench65.m4a');
  const alac24Path = path.join(musicDir, 'Bench65-ALAC-24-96k-EOF.m4a');
  const wavPath = path.join(musicDir, 'Bench65-PCM-16-44k.wav');

  const runFfmpeg = (args: string[]) => {
    const res = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true,
      timeout: 30_000,
    });
    if (res.status !== 0) {
      throw new Error(`FFmpeg fixture generation failed: ${res.stderr?.toString('utf8') ?? ''}`);
    }
  };

  runFfmpeg([
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=44100:duration=18:amplitude=0.25',
    '-ac', '2', '-sample_fmt', 's16', '-c:a', 'flac',
    flac16Path,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=96000:duration=12:amplitude=0.25',
    '-ac', '2', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-c:a', 'flac',
    flacHiResPath,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=44100:duration=18:amplitude=0.25',
    '-ac', '2', '-sample_fmt', 's16p', '-c:a', 'alac', '-movflags', '+faststart',
    alac16Path,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=96000:duration=10:amplitude=0.25',
    '-ac', '2', '-sample_fmt', 's32p', '-bits_per_raw_sample', '24', '-c:a', 'alac',
    alac24Path,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12',
    '-ac', '2', '-c:a', 'pcm_s16le',
    wavPath,
  ]);

  return { flac16Path, flacHiResPath, alac16Path, alac24Path, wavPath };
}

interface InstrumentationCounters {
  lanTcpConnections: number;
  remoteTlsHandshakes: number;
  httpRequestsServed: number;
  sqliteDeviceTouches: number;
  tailscaleCliSpawns: number;
  libraryRebuilds: number;
}

interface ScenarioMetricsResult {
  id: string;
  scenarioNumber: number;
  title: string;
  durationMs: number;
  cpuAvgOneCorePct: number;
  cpuMedianOneCorePct: number;
  cpuPeakOneCorePct: number;
  cpuAvgNormalizedPct: number;
  cpuMedianNormalizedPct: number;
  cpuPeakNormalizedPct: number;
  rssAvgMb: number;
  rssPeakMb: number;
  rssSettledMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  appProcessTreeWorkingSetMb: number;
  openSocketsEnd: number;
  freeSocketsClientPool: number;
  activeStreamsEnd: number;
  openFileHandlesDelta: number;
  activeTimersEnd: number;
  decoderInstancesEnd: number;
  networkRequestCount: number;
  lanTcpConnectionsOpened: number;
  remoteTlsHandshakesOpened: number;
  sqliteDeviceTouchWrites: number;
  tailscaleCliSpawns: number;
  libraryViewRebuilds: number;
  payloadBytesTransferred: number;
  payloadThroughputBytesPerSec: number;
  playbackBufferingEvents: number;
  errorCount: number;
  notes?: string;
}

async function consumeRangeBytes(resp: Response): Promise<number> {
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP stream failed with status ${resp.status}`);
  }
  if (!resp.body) {
    return 0;
  }
  const reader = resp.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}

async function main() {
  if (electronApp && typeof electronApp.whenReady === 'function') {
    await electronApp.whenReady();
  }
  const appVersion = readPackageVersion();
  const phase = parsePhaseArg();
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const cpuModel = os.cpus()[0]?.model ?? 'Unknown CPU';

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `doremi-p65-bench-${phase}-`));
  const hostDir = path.join(tmpRoot, 'host');
  const client1Dir = path.join(tmpRoot, 'client1');
  const client2Dir = path.join(tmpRoot, 'client2');
  const client3Dir = path.join(tmpRoot, 'client3');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(client1Dir, { recursive: true }),
    fs.mkdir(client2Dir, { recursive: true }),
    fs.mkdir(client3Dir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const fixtures = await generateAudioFixtures(musicDir);
  const stats = await Promise.all([
    fs.stat(fixtures.flac16Path),
    fs.stat(fixtures.flacHiResPath),
    fs.stat(fixtures.alac16Path),
    fs.stat(fixtures.alac24Path),
    fs.stat(fixtures.wavPath),
  ]);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  trackRepo.upsertBatch([
    {
      original_path: fixtures.flac16Path,
      normalized_path: normalizeTrackPath(fixtures.flac16Path),
      title: 'Bench65 FLAC 16-44.1',
      artist: 'DoReMi Audio Lab',
      album: 'Phase 6.5 Benchmark',
      duration_ms: 18_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 750_000,
      file_size_bytes: stats[0].size,
      modified_at_ms: Math.round(stats[0].mtimeMs),
      status: 'available',
    },
    {
      original_path: fixtures.flacHiResPath,
      normalized_path: normalizeTrackPath(fixtures.flacHiResPath),
      title: 'Bench65 Hi-Res FLAC 24-96',
      artist: 'DoReMi Audio Lab',
      album: 'Phase 6.5 Benchmark',
      duration_ms: 12_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 96_000,
      bit_depth: 24,
      bitrate_bps: 2_600_000,
      file_size_bytes: stats[1].size,
      modified_at_ms: Math.round(stats[1].mtimeMs),
      status: 'available',
    },
    {
      original_path: fixtures.alac16Path,
      normalized_path: normalizeTrackPath(fixtures.alac16Path),
      title: 'Có Thể (102112 Version) [Bench]',
      artist: 'DoReMi Audio Lab',
      album: 'Phase 6.5 Benchmark',
      duration_ms: 18_000,
      codec: 'ALAC',
      container: 'M4A',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 720_000,
      file_size_bytes: stats[2].size,
      modified_at_ms: Math.round(stats[2].mtimeMs),
      status: 'available',
    },
    {
      original_path: fixtures.alac24Path,
      normalized_path: normalizeTrackPath(fixtures.alac24Path),
      title: 'Bench65 ALAC 24-96 EOF',
      artist: 'DoReMi Audio Lab',
      album: 'Phase 6.5 Benchmark',
      duration_ms: 10_000,
      codec: 'ALAC',
      container: 'M4A',
      sample_rate_hz: 96_000,
      bit_depth: 24,
      bitrate_bps: 2_500_000,
      file_size_bytes: stats[3].size,
      modified_at_ms: Math.round(stats[3].mtimeMs),
      status: 'available',
    },
    {
      original_path: fixtures.wavPath,
      normalized_path: normalizeTrackPath(fixtures.wavPath),
      title: 'Bench65 WAV 16-44.1',
      artist: 'DoReMi Audio Lab',
      album: 'Phase 6.5 Benchmark',
      duration_ms: 12_000,
      codec: 'PCM',
      container: 'WAV',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 1_411_200,
      file_size_bytes: stats[4].size,
      modified_at_ms: Math.round(stats[4].mtimeMs),
      status: 'available',
    },
  ]);

  const allTracks = trackRepo.findAll();
  const flac16Track = allTracks.find((t) => t.title.includes('FLAC 16-44.1'))!;
  const hiResTrack = allTracks.find((t) => t.title.includes('Hi-Res FLAC'))!;
  const alac16Track = allTracks.find((t) => t.title.includes('Có Thể'))!;
  const alac24Track = allTracks.find((t) => t.title.includes('ALAC 24-96'))!;
  const wavTrack = allTracks.find((t) => t.title.includes('WAV 16-44.1'))!;

  const counters: InstrumentationCounters = {
    lanTcpConnections: 0,
    remoteTlsHandshakes: 0,
    httpRequestsServed: 0,
    sqliteDeviceTouches: 0,
    tailscaleCliSpawns: 0,
    libraryRebuilds: 0,
  };

  let routeTarget = '';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      counters.tailscaleCliSpawns += 1;
      if (args[0] === 'version') {
        return {
          ok: true,
          exitCode: 0,
          stdout: '{"majorMinorPatch":"1.104.7"}',
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: {
              DNSName: `${REMOTE_HOSTNAME}.`,
              Capabilities: ['https://tailscale.com/cap/funnel'],
            },
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
                Web: {
                  [`${REMOTE_HOSTNAME}:443`]: {
                    Handlers: { '/doremi-connect': { Proxy: routeTarget } },
                  },
                },
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
  const origTouch = hostRepo.touchDeviceActivity.bind(hostRepo);
  hostRepo.touchDeviceActivity = (deviceId: string, ip: string | null) => {
    counters.sqliteDeviceTouches += 1;
    origTouch(deviceId, ip);
  };
  const origBuildLib = hostRepo.buildRemoteLibraryView.bind(hostRepo);
  hostRepo.buildRemoteLibraryView = (...args) => {
    counters.libraryRebuilds += 1;
    return origBuildLib(...args);
  };

  hostRepo.updateHostConfig({
    bindAddress: '127.0.0.1',
    port: 0,
    remotePublicPort: 443,
    maxActiveClients: 3,
  });
  hostRepo.addSharedSource(root.id);

  const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir });
  const lyricsService = new LyricsService({ trackRepo, lyricsRepo });
  const host = new ConnectHostService({
    appVersion,
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService,
    lyricsService,
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    enableMdns: false,
  });

  // Controllable LAN TCP proxy gate to count exact LAN TCP/TLS connections & test network drops
  let lanGateOpen = true;
  let realLanPort = 0;
  const activeGateSockets = new Set<net.Socket>();
  const lanGate = net.createServer((sock) => {
    if (!lanGateOpen || realLanPort <= 0) {
      sock.destroy();
      return;
    }
    counters.lanTcpConnections += 1;
    activeGateSockets.add(sock);
    const up = net.connect(realLanPort, '127.0.0.1');
    sock.pipe(up);
    up.pipe(sock);
    const clean = () => {
      activeGateSockets.delete(sock);
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

  // Simulated Tailscale Funnel HTTPS reverse proxy with keep-alive & TLS handshake counter
  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let dynamicGatewayPort = 0;
  let remoteGateOpen = true;
  const proxyUpstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  const remoteProxyServer = https.createServer(
    {
      cert: leaf.certPem,
      key: leaf.keyPem,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      counters.httpRequestsServed += 1;
      if (!remoteGateOpen || dynamicGatewayPort <= 0) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'BAD_GATEWAY', message: 'Simulated Funnel offline' }));
        return;
      }
      const urlPath = req.url || '/';
      if (!urlPath.startsWith('/doremi-connect')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND' }));
        return;
      }
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders.host;
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: dynamicGatewayPort,
          path: urlPath,
          method: req.method,
          headers: fwdHeaders,
          agent: proxyUpstreamAgent,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'BAD_GATEWAY' }));
        }
      });
      req.pipe(upstream);
    },
  );
  remoteProxyServer.on('secureConnection', () => {
    counters.remoteTlsHandshakes += 1;
  });
  await new Promise<void>((r) => remoteProxyServer.listen(0, '127.0.0.1', r));
  const remoteProxyPort = (remoteProxyServer.address() as { port: number }).port;

  let currentNetObs: NetworkObservationSnapshot = {
    hasAnyExternalIpv4: true,
    hasPrivateLanIpv4: true,
    lanAddresses: ['192.168.1.50'],
    signature: 'Wi-Fi=192.168.1.50/24',
  };

  const makeClient = (dir: string, conn: ReturnType<typeof openLibraryDatabase>) => {
    const monitor = new NetworkChangeMonitor({
      pollIntervalMs: 4_000,
      inspectInterfaces: () => currentNetObs,
    });
    return new ConnectClientService({
      connectRepo: new ConnectRepository(conn.db),
      secrets: new ConnectSecretStorage({ userDataDir: dir, allowFileFallback: true }),
      networkMonitor: monitor,
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: remoteProxyPort,
      },
      smartPolicy: {
        networkDebounceMs: 60,
        lanRecoveryConfirmMs: 120,
        switchCooldownMs: 250,
        retryBackoffMs: [80, 160, 320],
        enableJitter: false,
      },
    });
  };

  const client1Conn = openLibraryDatabase(path.join(client1Dir, 'library.db'));
  const client2Conn = openLibraryDatabase(path.join(client2Dir, 'library.db'));
  const client3Conn = openLibraryDatabase(path.join(client3Dir, 'library.db'));
  const client1 = makeClient(client1Dir, client1Conn);
  const client2 = makeClient(client2Dir, client2Conn);
  const client3 = makeClient(client3Dir, client3Conn);

  const countClientFreeSockets = (svc: ConnectClientService): number => {
    const maybeGetter = (svc as unknown as { getPooledSocketCounts?: () => { freeSockets: number } })
      .getPooledSocketCounts;
    return typeof maybeGetter === 'function' ? maybeGetter.call(svc).freeSockets : 0;
  };

  const countDecoders = (svc: ConnectClientService): number => {
    const alacLocal = (getAlacStreamManager() as unknown as { cache?: Map<string, unknown> }).cache?.size ?? 0;
    const alacRem =
      ((svc as unknown as { remoteAlac?: { cache?: Map<string, unknown> } }).remoteAlac?.cache?.size) ?? 0;
    return alacLocal + alacRem;
  };

  const runScenario = async (
    scenarioNumber: number,
    id: string,
    title: string,
    work: () => Promise<{
      requests?: number;
      bytes?: number;
      bufferingEvents?: number;
      errors?: number;
      notes?: string;
    }>,
  ): Promise<ScenarioMetricsResult> => {
    const handlesBefore = inspectNodeHandles();
    const lanBefore = counters.lanTcpConnections;
    const tlsBefore = counters.remoteTlsHandshakes;
    const sqlBefore = counters.sqliteDeviceTouches;
    const tsBefore = counters.tailscaleCliSpawns;
    const libBefore = counters.libraryRebuilds;

    const cpuSamplesOneCore: number[] = [];
    const cpuSamplesNormalized: number[] = [];
    const rssSamplesMb: number[] = [];

    let lastCpu = process.cpuUsage();
    let lastSampleMs = performance.now();
    let sampling = true;

    const sampleInterval = setInterval(() => {
      if (!sampling) return;
      const now = performance.now();
      const dtMs = Math.max(1, now - lastSampleMs);
      const delta = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();
      lastSampleMs = now;
      const oneCorePct = ((delta.user + delta.system) / (dtMs * 1000)) * 100;
      const normPct = oneCorePct / logicalCpus;
      cpuSamplesOneCore.push(Math.max(0, oneCorePct));
      cpuSamplesNormalized.push(Math.max(0, normPct));
      rssSamplesMb.push(process.memoryUsage().rss / (1024 * 1024));
    }, 100);
    sampleInterval.unref();

    const totalCpuStart = process.cpuUsage();
    const t0 = performance.now();
    let workOut: {
      requests?: number;
      bytes?: number;
      bufferingEvents?: number;
      errors?: number;
      notes?: string;
    } = {};

    try {
      workOut = await work();
    } finally {
      sampling = false;
      clearInterval(sampleInterval);
    }

    const durationMs = Math.max(1, performance.now() - t0);
    const totalCpuDelta = process.cpuUsage(totalCpuStart);
    const overallOneCorePct = ((totalCpuDelta.user + totalCpuDelta.system) / (durationMs * 1000)) * 100;
    const overallNormPct = overallOneCorePct / logicalCpus;
    if (cpuSamplesOneCore.length === 0) {
      cpuSamplesOneCore.push(overallOneCorePct);
      cpuSamplesNormalized.push(overallNormPct);
    }
    rssSamplesMb.push(process.memoryUsage().rss / (1024 * 1024));

    // Allow microtasks & closed socket callbacks to settle (~150ms) without forcing artificial GC
    await sleep(150);
    const settledMem = process.memoryUsage();
    const handlesAfter = inspectNodeHandles();
    const treeMetrics = sampleAppProcessTreeWorkingSetMb();
    const hostSnap = host.getSnapshot();
    const freeSockets =
      countClientFreeSockets(client1) +
      countClientFreeSockets(client2) +
      countClientFreeSockets(client3);

    const bytes = workOut.bytes ?? 0;
    const throughputBps = durationMs > 0 ? Math.round((bytes * 1000) / durationMs) : 0;

    const result: ScenarioMetricsResult = {
      id,
      scenarioNumber,
      title,
      durationMs: round2(durationMs),
      cpuAvgOneCorePct: round2(overallOneCorePct),
      cpuMedianOneCorePct: median(cpuSamplesOneCore),
      cpuPeakOneCorePct: peak(cpuSamplesOneCore),
      cpuAvgNormalizedPct: round2(overallNormPct),
      cpuMedianNormalizedPct: median(cpuSamplesNormalized),
      cpuPeakNormalizedPct: peak(cpuSamplesNormalized),
      rssAvgMb: avg(rssSamplesMb),
      rssPeakMb: peak(rssSamplesMb),
      rssSettledMb: round2(settledMem.rss / (1024 * 1024)),
      heapUsedMb: round2(settledMem.heapUsed / (1024 * 1024)),
      externalMb: round2(settledMem.external / (1024 * 1024)),
      arrayBuffersMb: round2(settledMem.arrayBuffers / (1024 * 1024)),
      appProcessTreeWorkingSetMb: treeMetrics.workingSetSumMb,
      openSocketsEnd: handlesAfter.socketHandles,
      freeSocketsClientPool: freeSockets,
      activeStreamsEnd: hostSnap.activeSessions.length,
      openFileHandlesDelta: Math.max(0, handlesAfter.fsReqCount - handlesBefore.fsReqCount),
      activeTimersEnd:
        client1.smartManager.getActiveTimerCount() +
        client2.smartManager.getActiveTimerCount() +
        client3.smartManager.getActiveTimerCount(),
      decoderInstancesEnd: countDecoders(client1),
      networkRequestCount: workOut.requests ?? 0,
      lanTcpConnectionsOpened: counters.lanTcpConnections - lanBefore,
      remoteTlsHandshakesOpened: counters.remoteTlsHandshakes - tlsBefore,
      sqliteDeviceTouchWrites: counters.sqliteDeviceTouches - sqlBefore,
      tailscaleCliSpawns: counters.tailscaleCliSpawns - tsBefore,
      libraryViewRebuilds: counters.libraryRebuilds - libBefore,
      payloadBytesTransferred: bytes,
      payloadThroughputBytesPerSec: throughputBps,
      playbackBufferingEvents: workOut.bufferingEvents ?? 0,
      errorCount: workOut.errors ?? 0,
      ...(workOut.notes ? { notes: workOut.notes } : {}),
    };
    console.log(
      `[${phase.toUpperCase()}] #${String(scenarioNumber).padStart(2, '0')} ${id}: cpuNorm=${result.cpuAvgNormalizedPct}% (1core=${result.cpuAvgOneCorePct}%), rssSettled=${result.rssSettledMb}MB, lanConn=${result.lanTcpConnectionsOpened}, remTls=${result.remoteTlsHandshakesOpened}, sqlTouch=${result.sqliteDeviceTouchWrites}`,
    );
    return result;
  };

  const results: ScenarioMetricsResult[] = [];
  let hostId = '';

  try {
    // 1. Local Player idle
    results.push(
      await runScenario(1, '01_local_player_idle', 'Local Player idle (Host OFF, Client disconnected)', async () => {
        await sleep(1_000);
        return { requests: 0, bytes: 0 };
      }),
    );

    // 2. Local Player playing FLAC
    results.push(
      await runScenario(2, '02_local_player_playing_flac', 'Local Player paced FLAC 16/44.1 playback', async () => {
        let bytes = 0;
        const url = buildTrackMediaUrl(flac16Track.id);
        for (let i = 0; i < 6; i += 1) {
          const start = i * 65_536;
          const end = Math.min(stats[0].size - 1, start + 65_535);
          const resp = await resolveTrackMediaResponse(
            new Request(url, { headers: { Range: `bytes=${start}-${end}` } }),
            { trackRepo },
          );
          bytes += await consumeRangeBytes(resp);
          await sleep(150);
        }
        return { requests: 0, bytes };
      }),
    );

    // 3. Local Player playing ALAC
    results.push(
      await runScenario(3, '03_local_player_playing_alac', 'Local Player paced ALAC 16/44.1 WASM playback', async () => {
        let bytes = 0;
        const url = buildTrackMediaUrl(alac16Track.id);
        for (let i = 0; i < 6; i += 1) {
          const start = i * 131_072;
          const resp = await resolveTrackMediaResponse(
            new Request(url, { headers: { Range: `bytes=${start}-${start + 131_071}` } }),
            { trackRepo },
          );
          bytes += await consumeRangeBytes(resp);
          await sleep(150);
        }
        return { requests: 0, bytes };
      }),
    );

    // 4. Host OFF
    results.push(
      await runScenario(4, '04_host_off', 'Host OFF (repeated status check, zero listeners/timers)', async () => {
        for (let i = 0; i < 5; i += 1) {
          host.getSnapshot();
          await sleep(160);
        }
        return { requests: 0, bytes: 0 };
      }),
    );

    // 5. Host STANDBY (start Host -> no connected clients)
    const startedSnap = await host.start();
    realLanPort = startedSnap.listeningPort!;
    hostId = startedSnap.identity!.hostId;

    results.push(
      await runScenario(5, '05_host_standby', 'Host STANDBY (listener active, zero connected clients)', async () => {
        for (let i = 0; i < 6; i += 1) {
          host.getSnapshot();
          await sleep(200);
        }
        return { requests: 0, bytes: 0 };
      }),
    );

    // Pair Client 1, Client 2, Client 3 over LAN Gate
    const pairClient = async (svc: ConnectClientService, name: string) => {
      const probe = await svc.probeHost('127.0.0.1', gatedLanPort);
      const inv = host.createInvitation({ autoApproveSingleUse: true });
      await svc.enrollWithHost({
        address: '127.0.0.1',
        port: gatedLanPort,
        expectedFingerprintSha256: probe.observedFingerprintSha256!,
        inviteCode: inv.inviteCode,
        deviceName: name,
      });
    };
    await pairClient(client1, 'Bench Client 1');
    await pairClient(client2, 'Bench Client 2');
    await pairClient(client3, 'Bench Client 3');
    await client2.disconnect();
    await client3.disconnect();

    // 6. Host ON with LAN only (1 authorized connected inactive client)
    results.push(
      await runScenario(6, '06_host_on_lan_only', 'Host ON with LAN only (1 authorized idle client)', async () => {
        await client1.listRemoteTracks({ offset: 0, limit: 20 });
        await sleep(900);
        return { requests: 1, bytes: 0 };
      }),
    );

    // 7. Host ON with Remote Gateway enabled
    await client1.disconnect();
    const remEnabled = await host.enableRemoteAccess({
      confirmPublicExposure: true,
      preferredPublicPort: 443,
    });
    dynamicGatewayPort = remEnabled.remoteAccess!.gatewayListeningPort!;
    for (const dev of host.getSnapshot().authorizedDevices) {
      host.setDeviceRemoteAccess(dev.deviceId, true);
    }

    results.push(
      await runScenario(
        7,
        '07_host_on_remote_gateway_enabled',
        'Host ON with Remote Gateway enabled (0 active clients + provider check x4)',
        async () => {
          for (let i = 0; i < 4; i += 1) {
            await host.checkRemoteProvider();
            await sleep(200);
          }
          return { requests: 0, bytes: 0 };
        },
      ),
    );

    // 8. Tailscale running without active DoReMi Funnel (read-only OS process observation)
    const tsProcessSample = readTailscaleProcessesReadOnly();
    results.push(
      await runScenario(
        8,
        '08_tailscale_running_without_doremi_funnel',
        'Tailscale processes on Windows without active DoReMi real Funnel route (read-only OS observation)',
        async () => {
          await sleep(400);
          return {
            requests: 0,
            bytes: 0,
            notes: `Read-only OS Tailscale processes (${tsProcessSample.processNames.join(', ') || 'none'}): workingSet=${tsProcessSample.workingSetSumMb} MB, private=${tsProcessSample.privateMemorySumMb} MB, cpuSec=${tsProcessSample.totalCpuSeconds}`,
          };
        },
      ),
    );

    // Provision Remote credentials to all 3 clients over LAN
    await client1.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort, 'lan-direct');
    await client1.syncRemoteAccessOverLan(hostId);
    await client2.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort, 'lan-direct');
    await client2.syncRemoteAccessOverLan(hostId);
    await client2.disconnect();
    await client3.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort, 'lan-direct');
    await client3.syncRemoteAccessOverLan(hostId);
    await client3.disconnect();

    // 9. Remote Access standby (Client 1 connected via Remote HTTPS, idle)
    await client1.setConnectionMode(hostId, 'remote-only');
    await client1.connectToRememberedHost(hostId);
    results.push(
      await runScenario(9, '09_remote_access_standby', 'Remote Access standby (1 Remote HTTPS client idle)', async () => {
        await sleep(1_200);
        return { requests: 0, bytes: 0 };
      }),
    );

    // 10. One LAN FLAC Client (paced Range chunks)
    await client1.setConnectionMode(hostId, 'lan-only');
    await client1.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);
    const flac16RemoteUrl = buildRemoteTrackMediaUrl(hostId, flac16Track.id);
    results.push(
      await runScenario(10, '10_one_lan_flac_client', 'One LAN Direct FLAC 16/44.1 Client (paced Range streaming)', async () => {
        let bytes = 0;
        let reqs = 0;
        for (let i = 0; i < 8; i += 1) {
          const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
          const end = Math.min(stats[0].size - 1, start + 65_535);
          const resp = await client1.resolveRemoteTrackMediaResponse(
            new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
          );
          bytes += await consumeRangeBytes(resp);
          reqs += 1;
          await sleep(140);
        }
        return { requests: reqs, bytes };
      }),
    );

    // 11. One Remote HTTPS FLAC Client
    await client1.setConnectionMode(hostId, 'remote-only');
    await client1.connectToRememberedHost(hostId);
    results.push(
      await runScenario(
        11,
        '11_one_remote_https_flac_client',
        'One Remote HTTPS FLAC 16/44.1 Client (paced Range streaming)',
        async () => {
          let bytes = 0;
          let reqs = 0;
          for (let i = 0; i < 8; i += 1) {
            const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
            const end = Math.min(stats[0].size - 1, start + 65_535);
            const resp = await client1.resolveRemoteTrackMediaResponse(
              new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
            );
            bytes += await consumeRangeBytes(resp);
            reqs += 1;
            await sleep(140);
          }
          return { requests: reqs, bytes };
        },
      ),
    );

    // 12. One Remote HTTPS ALAC Client (Có Thể 102112 Version WASM range-window decoding)
    const alac16RemoteUrl = buildRemoteTrackMediaUrl(hostId, alac16Track.id);
    results.push(
      await runScenario(
        12,
        '12_one_remote_https_alac_client',
        'One Remote HTTPS ALAC Client (Range-backed WASM decoding)',
        async () => {
          let bytes = 0;
          let reqs = 0;
          for (let i = 0; i < 8; i += 1) {
            const start = i * 131_072;
            const resp = await client1.resolveRemoteTrackMediaResponse(
              new Request(alac16RemoteUrl, { headers: { Range: `bytes=${start}-${start + 131_071}` } }),
            );
            bytes += await consumeRangeBytes(resp);
            reqs += 1;
            await sleep(140);
          }
          return { requests: reqs, bytes };
        },
      ),
    );

    // 13. One Hi-Res Client (24-bit / 96 kHz FLAC)
    const hiResRemoteUrl = buildRemoteTrackMediaUrl(hostId, hiResTrack.id);
    results.push(
      await runScenario(
        13,
        '13_one_hires_client',
        'One Hi-Res 24-bit/96kHz FLAC Client (paced Range streaming)',
        async () => {
          let bytes = 0;
          let reqs = 0;
          for (let i = 0; i < 8; i += 1) {
            const start = (i * 131_072) % Math.max(131_072, stats[1].size - 131_072);
            const end = Math.min(stats[1].size - 1, start + 131_071);
            const resp = await client1.resolveRemoteTrackMediaResponse(
              new Request(hiResRemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
            );
            bytes += await consumeRangeBytes(resp);
            reqs += 1;
            await sleep(140);
          }
          return { requests: reqs, bytes };
        },
      ),
    );

    // 14. Three simultaneous Clients (all 3 FLAC over LAN)
    await client1.setConnectionMode(hostId, 'lan-only');
    await client1.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);
    await client2.setConnectionMode(hostId, 'lan-only');
    await client2.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);
    await client3.setConnectionMode(hostId, 'lan-only');
    await client3.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);

    results.push(
      await runScenario(
        14,
        '14_three_simultaneous_clients',
        'Three simultaneous LAN FLAC Clients',
        async () => {
          const streamPaced = async (svc: ConnectClientService) => {
            let b = 0;
            for (let i = 0; i < 6; i += 1) {
              const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
              const end = Math.min(stats[0].size - 1, start + 65_535);
              const r = await svc.resolveRemoteTrackMediaResponse(
                new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
              );
              b += await consumeRangeBytes(r);
              await sleep(140);
            }
            return b;
          };
          const [b1, b2, b3] = await Promise.all([
            streamPaced(client1),
            streamPaced(client2),
            streamPaced(client3),
          ]);
          return { requests: 18, bytes: b1 + b2 + b3 };
        },
      ),
    );

    // 15. Mixed LAN and Remote Clients (Client 1 LAN FLAC, Client 2 Remote Hi-Res FLAC, Client 3 Remote ALAC)
    await client2.setConnectionMode(hostId, 'remote-only');
    await client2.connectToRememberedHost(hostId);
    await client3.setConnectionMode(hostId, 'remote-only');
    await client3.connectToRememberedHost(hostId);

    results.push(
      await runScenario(
        15,
        '15_mixed_lan_and_remote_clients',
        'Mixed LAN (FLAC) and Remote HTTPS (Hi-Res FLAC + ALAC) Clients',
        async () => {
          const runOne = async (svc: ConnectClientService, url: string, sizeLimit: number) => {
            let b = 0;
            for (let i = 0; i < 5; i += 1) {
              const start = (i * 65_536) % Math.max(65_536, sizeLimit - 65_536);
              const r = await svc.resolveRemoteTrackMediaResponse(
                new Request(url, { headers: { Range: `bytes=${start}-${start + 65_535}` } }),
              );
              b += await consumeRangeBytes(r);
              await sleep(150);
            }
            return b;
          };
          const [b1, b2, b3] = await Promise.all([
            runOne(client1, flac16RemoteUrl, stats[0].size),
            runOne(client2, hiResRemoteUrl, stats[1].size),
            runOne(client3, alac16RemoteUrl, 1_500_000),
          ]);
          return { requests: 15, bytes: b1 + b2 + b3 };
        },
      ),
    );

    await client2.disconnect();
    await client3.disconnect();

    // 16. Host Local Playback with Client streaming
    results.push(
      await runScenario(
        16,
        '16_host_local_playback_with_client_streaming',
        'Host Local Playback (FLAC) concurrent with Client streaming (Remote HTTPS FLAC)',
        async () => {
          await client1.setConnectionMode(hostId, 'remote-only');
          await client1.connectToRememberedHost(hostId);
          const localUrl = buildTrackMediaUrl(flac16Track.id);
          const [localBytes, remoteBytes] = await Promise.all([
            (async () => {
              let b = 0;
              for (let i = 0; i < 6; i += 1) {
                const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
                const end = Math.min(stats[0].size - 1, start + 65_535);
                const r = await resolveTrackMediaResponse(
                  new Request(localUrl, { headers: { Range: `bytes=${start}-${end}` } }),
                  { trackRepo },
                );
                b += await consumeRangeBytes(r);
                await sleep(140);
              }
              return b;
            })(),
            (async () => {
              let b = 0;
              for (let i = 0; i < 6; i += 1) {
                const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
                const end = Math.min(stats[0].size - 1, start + 65_535);
                const r = await client1.resolveRemoteTrackMediaResponse(
                  new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
                );
                b += await consumeRangeBytes(r);
                await sleep(140);
              }
              return b;
            })(),
          ]);
          return { requests: 6, bytes: localBytes + remoteBytes };
        },
      ),
    );

    // 17. Repeated seeking (24 rapid HTTP 206 Range seeks across FLAC + ALAC)
    results.push(
      await runScenario(
        17,
        '17_repeated_seeking',
        'Repeated seeking (24 rapid HTTP 206 Range seeks across FLAC + ALAC)',
        async () => {
          let bytes = 0;
          for (let i = 0; i < 16; i += 1) {
            const start = (i * 32_768) % Math.max(32_768, stats[0].size - 32_768);
            const end = Math.min(stats[0].size - 1, start + 32_767);
            const r = await client1.resolveRemoteTrackMediaResponse(
              new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
            );
            bytes += await consumeRangeBytes(r);
          }
          for (let i = 0; i < 8; i += 1) {
            const start = i * 98_304;
            const r = await client1.resolveRemoteTrackMediaResponse(
              new Request(alac16RemoteUrl, { headers: { Range: `bytes=${start}-${start + 65_535}` } }),
            );
            bytes += await consumeRangeBytes(r);
          }
          return { requests: 24, bytes };
        },
      ),
    );

    // 18. Repeated track switching (12 rapid switches with AbortController cancellation)
    const switchUrls = [
      flac16RemoteUrl,
      hiResRemoteUrl,
      alac16RemoteUrl,
      buildRemoteTrackMediaUrl(hostId, alac24Track.id),
      buildRemoteTrackMediaUrl(hostId, wavTrack.id),
    ];
    results.push(
      await runScenario(
        18,
        '18_repeated_track_switching',
        'Repeated track switching (12 switches across FLAC/Hi-Res/ALAC16/ALAC24/WAV with stream abort)',
        async () => {
          let bytes = 0;
          for (let i = 0; i < 12; i += 1) {
            const ctrl = new AbortController();
            const url = switchUrls[i % switchUrls.length];
            const resp = await client1.resolveRemoteTrackMediaResponse(
              new Request(url, { headers: { Range: 'bytes=0-65535' }, signal: ctrl.signal }),
            );
            if (resp.body) {
              const reader = resp.body.getReader();
              const first = await reader.read();
              if (first.value) bytes += first.value.byteLength;
              ctrl.abort();
              await reader.cancel().catch(() => {});
            }
          }
          return { requests: 12, bytes };
        },
      ),
    );

    // 19. Repeated connection recovery (4 temporary Remote outages + automatic recovery)
    results.push(
      await runScenario(
        19,
        '19_repeated_connection_recovery',
        'Repeated connection recovery (4 temporary outages & SmartConnectionManager recovery)',
        async () => {
          await client1.setConnectionMode(hostId, 'remote-only');
          await client1.connectToRememberedHost(hostId);
          for (let i = 0; i < 4; i += 1) {
            remoteGateOpen = false;
            await client1.smartManager.reportTransportFailure({
              hostId,
              transport: 'remote-https',
              errorCode: 'HOST_UNAVAILABLE',
              message: 'Temporary outage',
              immediate: true,
            });
            remoteGateOpen = true;
            await client1.manualReconnect();
          }
          return { requests: 8, bytes: 0 };
        },
      ),
    );

    // 20. Repeated transport handover (4 LAN <-> Remote handovers in Automatic mode)
    results.push(
      await runScenario(
        20,
        '20_repeated_transport_handover',
        'Repeated transport handover (LAN <-> Remote HTTPS Automatic mode x4)',
        async () => {
          lanGateOpen = true;
          remoteGateOpen = true;
          await client1.setConnectionMode(hostId, 'automatic');
          await client1.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);
          for (let i = 0; i < 2; i += 1) {
            // LAN -> Remote (Break-Before-Make)
            lanGateOpen = false;
            for (const s of activeGateSockets) s.destroy();
            currentNetObs = {
              hasAnyExternalIpv4: true,
              hasPrivateLanIpv4: false,
              lanAddresses: [],
              signature: `Hotspot-${i}`,
            };
            await client1.smartManager.reportTransportFailure({
              hostId,
              transport: 'lan-direct',
              errorCode: 'NETWORK_INTERRUPTED',
              message: 'LAN dropped',
              immediate: true,
            });
            // Remote -> LAN (Make-Before-Break)
            lanGateOpen = true;
            currentNetObs = {
              hasAnyExternalIpv4: true,
              hasPrivateLanIpv4: true,
              lanAddresses: ['192.168.1.50'],
              signature: `HomeWiFi-${i}`,
            };
            client1.notifyNetworkHint('recheck');
            await sleep(320);
          }
          return { requests: 12, bytes: 0 };
        },
      ),
    );

    // 21. Repeated Host start and stop (4 full cycles)
    await client1.disconnect();
    results.push(
      await runScenario(
        21,
        '21_repeated_host_start_and_stop',
        'Repeated Host start/stop & Remote Gateway enable/disable (4 cycles)',
        async () => {
          for (let i = 0; i < 4; i += 1) {
            await host.stop();
            const st = await host.start();
            realLanPort = st.listeningPort!;
            const rem = await host.enableRemoteAccess({
              confirmPublicExposure: true,
              preferredPublicPort: 443,
            });
            dynamicGatewayPort = rem.remoteAccess!.gatewayListeningPort!;
          }
          return { requests: 0, bytes: 0 };
        },
      ),
    );

    // Reconnect Client 1 on updated LAN port
    await client1.setConnectionMode(hostId, 'lan-only');
    await client1.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);

    // 22. Application minimized (0 UI polling subscribers while streaming)
    results.push(
      await runScenario(
        22,
        '22_application_minimized',
        'Application minimized / zero UI resource polling while serving 1 LAN Client',
        async () => {
          let bytes = 0;
          for (let i = 0; i < 6; i += 1) {
            const start = (i * 65_536) % Math.max(65_536, stats[0].size - 65_536);
            const end = Math.min(stats[0].size - 1, start + 65_535);
            const r = await client1.resolveRemoteTrackMediaResponse(
              new Request(flac16RemoteUrl, { headers: { Range: `bytes=${start}-${end}` } }),
            );
            bytes += await consumeRangeBytes(r);
            await sleep(150);
          }
          return { requests: 6, bytes };
        },
      ),
    );

    // 23. Pause and resume (hold paused position -> reopen Range at exact byte offset)
    results.push(
      await runScenario(
        23,
        '23_pause_and_resume',
        'Pause and resume (partial read -> quiet pause -> exact byte-offset Range resume)',
        async () => {
          let bytes = 0;
          const r1 = await client1.resolveRemoteTrackMediaResponse(
            new Request(flac16RemoteUrl, { headers: { Range: 'bytes=0-65535' } }),
          );
          bytes += await consumeRangeBytes(r1);
          await sleep(800); // Quiet pause without polling
          const r2 = await client1.resolveRemoteTrackMediaResponse(
            new Request(flac16RemoteUrl, { headers: { Range: 'bytes=65536-131071' } }),
          );
          bytes += await consumeRangeBytes(r2);
          return { requests: 2, bytes };
        },
      ),
    );

    // 24. Device revocation (revoke Client 2 -> verify immediate rejection & clean state)
    await client2.setConnectionMode(hostId, 'lan-only');
    await client2.connectToRememberedHost(hostId, '127.0.0.1', gatedLanPort);
    const client2DevId = client2.getSnapshot().activeHost!.deviceId;
    results.push(
      await runScenario(
        24,
        '24_device_revocation',
        'Device revocation mid-session and cleanup verification',
        async () => {
          host.revokeDevice(client2DevId);
          const blockedResp = await client2.resolveRemoteTrackMediaResponse(
            new Request(flac16RemoteUrl, { headers: { Range: 'bytes=0-4095' } }),
          );
          await blockedResp.text().catch(() => {});
          await client2.disconnect();
          return { requests: 1, bytes: 0, errors: blockedResp.status === 403 ? 0 : 1 };
        },
      ),
    );

    // 25. Suspend and resume (software lifecycle reconciliation; physical OS Sleep NOT RUN)
    results.push(
      await runScenario(
        25,
        '25_suspend_and_resume',
        'Suspend and resume lifecycle reconciliation (software event; physical S3/Modern Standby NOT RUN)',
        async () => {
          const maybeHostSuspend = (host as unknown as { handleSystemSuspend?: () => Promise<void> | void })
            .handleSystemSuspend;
          const maybeHostResume = (host as unknown as { handleSystemResume?: () => Promise<void> | void })
            .handleSystemResume;
          const maybeClientSuspend = (client1 as unknown as { handleSystemSuspend?: () => void })
            .handleSystemSuspend;
          const maybeClientResume = (client1 as unknown as { handleSystemResume?: () => void })
            .handleSystemResume;

          if (typeof maybeHostSuspend === 'function') await maybeHostSuspend.call(host);
          if (typeof maybeClientSuspend === 'function') maybeClientSuspend.call(client1);
          await sleep(150);
          if (typeof maybeHostResume === 'function') await maybeHostResume.call(host);
          if (typeof maybeClientResume === 'function') maybeClientResume.call(client1);
          await sleep(250);

          const r = await client1.resolveRemoteTrackMediaResponse(
            new Request(flac16RemoteUrl, { headers: { Range: 'bytes=0-32767' } }),
          );
          const bytes = await consumeRangeBytes(r);
          return {
            requests: 1,
            bytes,
            notes:
              typeof maybeHostResume === 'function'
                ? 'Software suspend/resume reconciliation executed; physical OS Sleep marked NOT RUN.'
                : 'Pre-Phase 6.5 baseline (no dedicated suspend/resume hook yet); physical OS Sleep NOT RUN.',
          };
        },
      ),
    );

    await client1.shutdown();
    await client2.shutdown();
    await client3.shutdown();
    await host.stop();
    disposeSharedAlacStreamManager();
    clearFlacSanitizerCache();
    await sleep(200);

    const finalMem = process.memoryUsage();
    const outDir = path.join(process.cwd(), 'qa', 'logs');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `phase65-benchmark-${phase}.json`);

    const report = {
      generatedAt: new Date().toISOString(),
      phase,
      appVersion,
      environment: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.version,
        cpuModel,
        logicalCpus,
        totalSystemMemoryGb: round2(os.totalmem() / (1024 * 1024 * 1024)),
        freeSystemMemoryGb: round2(os.freemem() / (1024 * 1024 * 1024)),
        transportModeNote:
          'LAN Direct via controlled loopback gate + Remote HTTPS via local CA-verified TLS reverse proxy (no personal Funnel exposure).',
        lowEndReferenceHardwareStatus:
          'NOT RUN on physical i5-5200U / i5-1035G1 hardware (desktop measurements never extrapolated as low-end hardware numbers).',
      },
      tailscaleReadOnlySnapshot: tsProcessSample,
      cumulativeTotals: {
        ...counters,
        finalPostShutdownRssMb: round2(finalMem.rss / (1024 * 1024)),
        finalPostShutdownHeapUsedMb: round2(finalMem.heapUsed / (1024 * 1024)),
        finalPostShutdownExternalMb: round2(finalMem.external / (1024 * 1024)),
        finalPostShutdownArrayBuffersMb: round2(finalMem.arrayBuffers / (1024 * 1024)),
      },
      scenarios: results,
    };

    await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');
    console.log(`PHASE65_BENCHMARK_${phase.toUpperCase()}_SAVED=${outFile}`);
  } finally {
    await client1.shutdown().catch(() => {});
    await client2.shutdown().catch(() => {});
    await client3.shutdown().catch(() => {});
    await host.stop().catch(() => {});
    disposeSharedAlacStreamManager();
    clearFlacSanitizerCache();
    proxyUpstreamAgent.destroy();
    await new Promise<void>((r) => {
      remoteProxyServer.closeAllConnections?.();
      remoteProxyServer.close(() => r());
    });
    for (const s of activeGateSockets) s.destroy();
    await new Promise<void>((r) => lanGate.close(() => r()));
    client1Conn.close();
    client2Conn.close();
    client3Conn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (electronApp && typeof electronApp.exit === 'function') {
    electronApp.exit(0);
  } else {
    process.exit(0);
  }
}

void main().catch((err) => {
  console.error('[PHASE65_BENCHMARK_FATAL]', err);
  if (electronApp && typeof electronApp.exit === 'function') {
    electronApp.exit(1);
  } else {
    process.exit(1);
  }
});
