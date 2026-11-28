import crypto from 'node:crypto';
import fs from 'node:fs/promises';
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
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from '../tests/helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-bench.tail6300.ts.net';

async function measure(label: string, fn: () => Promise<void>) {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  await fn();
  const elapsedMs = Math.max(0.1, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const cpuPct = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * logicalCpus)) * 100;
  return {
    label,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    cpuPercentOfLogicalCapacity: Number(cpuPct.toFixed(2)),
    rssMbBefore: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
    rssMbAfter: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMbAfter: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p63-bench-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const songPath = path.join(musicDir, 'Bench63-8MB.flac');
  const songBytes = Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(8 * 1024 * 1024)]);
  await fs.writeFile(songPath, songBytes);

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
      title: 'Bench Remote HTTPS 8MB',
      artist: 'Bench',
      album: 'Phase 6.3',
      duration_ms: 180_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 96000,
      bit_depth: 24,
      bitrate_bps: 2_800_000,
      file_size_bytes: songBytes.length,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);
  const track = trackRepo.findAll()[0];

  let routeTarget = '';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      if (args[0] === 'version') return { ok: true, exitCode: 0, stdout: '{"majorMinorPatch":"1.78.1"}', stderr: '', timedOut: false, aborted: false };
      if (args[0] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: `${REMOTE_HOSTNAME}.`, Capabilities: ['https://tailscale.com/cap/funnel'] },
            CurrentTailnet: { MagicDNSSuffix: 'tail6300.ts.net', MagicDNSEnabled: true },
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
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443 });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.7',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    enableMdns: false,
  });

  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });

  const results: Array<Record<string, unknown>> = [];

  try {
    results.push(
      await measure('1_host_off_baseline', async () => {
        host.getSnapshot();
      }),
    );

    await host.start();
    results.push(
      await measure('2_host_on_remote_off', async () => {
        host.getSnapshot();
      }),
    );

    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    const gwPort = enabled.remoteAccess!.gatewayListeningPort!;
    const proxy = await startSimulatedFunnelTlsProxy({
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: gwPort,
    });

    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: proxy.port,
      },
    });

    const hostId = enabled.identity!.hostId;
    const lanPort = host.getSnapshot().listeningPort!;
    const probe = await client.probeHost('127.0.0.1', lanPort);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Bench Client',
    });
    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await client.syncRemoteAccessOverLan(hostId);

    results.push(
      await measure('3_remote_https_verify_host_and_connect', async () => {
        await client.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
      }),
    );

    const streamUrl = buildRemoteTrackMediaUrl(hostId, track.id);
    results.push(
      await measure('4_remote_https_stream_8mb_flac_x3', async () => {
        for (let i = 0; i < 3; i += 1) {
          const resp = await client.resolveRemoteTrackMediaResponse(new Request(streamUrl));
          await resp.arrayBuffer();
        }
      }),
    );

    results.push(
      await measure('5_remote_https_seek_ranges_x20', async () => {
        for (let i = 0; i < 20; i += 1) {
          const start = i * 262144;
          const resp = await client.resolveRemoteTrackMediaResponse(
            new Request(streamUrl, { headers: { Range: `bytes=${start}-${start + 65535}` } }),
          );
          await resp.arrayBuffer();
        }
      }),
    );

    results.push(
      await measure('6_concurrent_3_streams_remote_https', async () => {
        await Promise.all([
          client.resolveRemoteTrackMediaResponse(new Request(streamUrl)).then((r) => r.arrayBuffer()),
          client.resolveRemoteTrackMediaResponse(new Request(streamUrl)).then((r) => r.arrayBuffer()),
          client.resolveRemoteTrackMediaResponse(new Request(streamUrl)).then((r) => r.arrayBuffer()),
        ]);
      }),
    );

    await proxy.close();
    results.push(
      await measure('7_repeated_remote_enable_disable_x5', async () => {
        for (let i = 0; i < 5; i += 1) {
          await host.disableRemoteAccess();
          await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
        }
        await host.disableRemoteAccess();
      }),
    );

    await client.disconnect();
    const outDir = path.join(process.cwd(), 'qa', 'logs');
    await fs.mkdir(outDir, { recursive: true });
    const summary = {
      generatedAt: new Date().toISOString(),
      environment: 'Simulated Loopback Remote Gateway + Local TLS Proxy (NOT external public Internet)',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      logicalCpus: os.cpus().length,
      scenarios: results,
    };
    await fs.writeFile(
      path.join(outDir, 'phase63-benchmark-latest.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await host.stop();
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
