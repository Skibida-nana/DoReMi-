import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeTrack, decodeTrack, openTrack } from '@mgz-dev/alac';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { WAV_HEADER_BYTES } from '../src/main/services/alac-decoder';
import { ArtworkService } from '../src/main/services/artwork-service';
import {
  clearFlacSanitizerCache,
  getFlacSanitizerCacheStats,
} from '../src/main/services/flac-stream-sanitizer';
import { LyricsService } from '../src/main/services/lyrics-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { defaultGuardedFsOps, type GuardedFsOps } from '../src/main/services/connect/filesystem-guard';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { RemoteAlacStreamManager } from '../src/main/services/connect/remote-alac-decoder';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  buildRemoteArtworkMediaUrl,
  buildRemoteTrackMediaUrl,
} from '../src/shared/contracts/media-protocol';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
} from './helpers/test-ca-https';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildFlacWithBrokenPictureBlock(audioPayload: Buffer): Buffer {
  // STREAMINFO block (type 0, length 34, not-last)
  const streamInfoHdr = Buffer.from([0x00, 0x00, 0x00, 0x22]);
  const streamInfoBody = Buffer.alloc(34, 0x11);
  // Broken PICTURE block (type 6, last-metadata-block flag 0x80 | 6 = 0x86, mimeLength = 0 -> breaks Chromium demuxer unless sanitized)
  const picBody = Buffer.alloc(40, 0);
  const picHdr = Buffer.from([0x86, 0x00, 0x00, picBody.length]);
  // Prepended ID3v2 header (10 bytes, size=0)
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([
    id3,
    Buffer.from('fLaC', 'ascii'),
    streamInfoHdr,
    streamInfoBody,
    picHdr,
    picBody,
    audioPayload,
  ]);
}

function createInstrumentedFsOps(): {
  fsOps: GuardedFsOps;
  getOpenHandleCount: () => number;
  getTotalOpens: () => number;
} {
  let openHandles = 0;
  let totalOpens = 0;
  return {
    getOpenHandleCount: () => openHandles,
    getTotalOpens: () => totalOpens,
    fsOps: {
      realpath: (p) => defaultGuardedFsOps.realpath(p),
      lstat: (p) => defaultGuardedFsOps.lstat(p),
      async openRead(targetPath: string) {
        const rawHandle = await defaultGuardedFsOps.openRead(targetPath);
        openHandles += 1;
        totalOpens += 1;
        let closed = false;
        return new Proxy(rawHandle, {
          get(target, prop, receiver) {
            if (prop === 'close') {
              return async () => {
                if (!closed) {
                  closed = true;
                  openHandles = Math.max(0, openHandles - 1);
                }
                return target.close();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      },
    },
  };
}

test('Phase 6.5 Resource Lifecycle — Host OFF/STANDBY/ACTIVE, Keep-Alive Pool Isolation, File Handles, Caches, Pause >30s vs Abandoned & Resource Sampler', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p65-res-'));
  const hostDir = path.join(tmpRoot, 'host');
  const host2Dir = path.join(tmpRoot, 'host2');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(host2Dir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const cleanFlacPath = path.join(musicDir, 'Clean-Lossless.flac');
  const cleanFlacBytes = Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(2560 * 1024)]);
  await fs.writeFile(cleanFlacPath, cleanFlacBytes);

  const compatFlacPath = path.join(musicDir, 'Compat-ID3-BrokenPic.flac');
  const rawAudioFrames = crypto.randomBytes(128 * 1024);
  const compatFlacBytes = buildFlacWithBrokenPictureBlock(rawAudioFrames);
  await fs.writeFile(compatFlacPath, compatFlacBytes);

  const coverJpgPath = path.join(musicDir, 'cover.jpg');
  // Valid minimal JPEG header + payload
  const coverBytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    crypto.randomBytes(24 * 1024),
    Buffer.from([0xff, 0xd9]),
  ]);
  await fs.writeFile(coverJpgPath, coverBytes);

  const sidecarLrcPath = path.join(musicDir, 'Clean-Lossless.lrc');
  await fs.writeFile(sidecarLrcPath, '[00:01.00] Sidecar LRC line 1\n[00:05.00] Sidecar LRC line 2\n', 'utf8');

  const [s1, s2] = await Promise.all([fs.stat(cleanFlacPath), fs.stat(compatFlacPath)]);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const host2Conn = openLibraryDatabase(path.join(host2Dir, 'library.db'));
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));

  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  trackRepo.upsertBatch([
    {
      original_path: cleanFlacPath,
      normalized_path: normalizeTrackPath(cleanFlacPath),
      title: 'Clean Lossless',
      artist: 'DoReMi Artist',
      album: 'Lifecycle Album',
      duration_ms: 120_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 800_000,
      file_size_bytes: cleanFlacBytes.length,
      modified_at_ms: Math.round(s1.mtimeMs),
      status: 'available',
    },
    {
      original_path: compatFlacPath,
      normalized_path: normalizeTrackPath(compatFlacPath),
      title: 'Compat FLAC Track',
      artist: 'DoReMi Artist',
      album: 'Lifecycle Album',
      duration_ms: 90_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 48_000,
      bit_depth: 24,
      bitrate_bps: 1_500_000,
      file_size_bytes: compatFlacBytes.length,
      modified_at_ms: Math.round(s2.mtimeMs),
      status: 'available',
    },
  ]);

  const tracks = trackRepo.findAll();
  const cleanTrack = tracks.find((t) => t.title === 'Clean Lossless')!;
  const compatTrack = tracks.find((t) => t.title === 'Compat FLAC Track')!;
  lyricsRepo.setEmbeddedLyrics(cleanTrack.id, 'Embedded fallback lyrics');

  let tsCliCount = 0;
  let routeTarget = '';
  const REMOTE_HOSTNAME = 'doremi-life65.tail6500.ts.net';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      tsCliCount += 1;
      if (args[0] === 'version') {
        return { ok: true, exitCode: 0, stdout: '{"majorMinorPatch":"1.104.7"}', stderr: '', timedOut: false, aborted: false };
      }
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

  const fsTracker = createInstrumentedFsOps();
  let sqliteTouchCount = 0;
  const hostRepo = new ConnectRepository(hostConn.db);
  const origTouch = hostRepo.touchDeviceActivity.bind(hostRepo);
  hostRepo.touchDeviceActivity = (devId, ip) => {
    sqliteTouchCount += 1;
    origTouch(devId, ip);
  };
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
  hostRepo.addSharedSource(root.id);

  let artworkServiceCalls = 0;
  const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir });
  await artworkService.syncAutoArtworkForTrack(cleanTrack);
  const origResolveArtwork = artworkService.resolveArtworkHttpResponse.bind(artworkService);
  artworkService.resolveArtworkHttpResponse = async (req) => {
    artworkServiceCalls += 1;
    await sleep(25); // Allow concurrent requests to overlap and test deduplication
    return origResolveArtwork(req);
  };

  const lyricsService = new LyricsService({ trackRepo, lyricsRepo });
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.9',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService,
    lyricsService,
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    fsOps: fsTracker.fsOps,
    enableMdns: false,
  });

  // Second independent Host to prove HTTP Agent & credential boundary isolation
  const host2TrackRepo = new TrackRepository(host2Conn.db);
  const host2Repo = new ConnectRepository(host2Conn.db);
  host2Repo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, displayName: 'Second Host' });
  const host2 = new ConnectHostService({
    appVersion: '1.0.0-rc.9',
    userDataDir: host2Dir,
    connectRepo: host2Repo,
    trackRepo: host2TrackRepo,
    artworkService: new ArtworkService({
      trackRepo: host2TrackRepo,
      artworkRepo: new ArtworkRepository(host2Conn.db),
      userDataDir: host2Dir,
    }),
    lyricsService: new LyricsService({
      trackRepo: host2TrackRepo,
      lyricsRepo: new LyricsRepository(host2Conn.db),
    }),
    secrets: new ConnectSecretStorage({ userDataDir: host2Dir, allowFileFallback: true }),
    enableMdns: false,
  });

  // Keep-alive simulated Funnel TLS edge with TLS handshake counter
  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let gwPort = 0;
  let remoteTlsHandshakes = 0;
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
  edgeServer.on('secureConnection', () => {
    remoteTlsHandshakes += 1;
  });
  await new Promise<void>((r) => edgeServer.listen(0, '127.0.0.1', r));
  const edgePort = (edgeServer.address() as { port: number }).port;

  const client = new ConnectClientService({
    connectRepo: new ConnectRepository(clientConn.db),
    secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
    publicHttpsOptions: {
      ca: ca.caCertPem,
      lookup: createLoopbackLookup(REMOTE_HOSTNAME),
      connectOverridePort: edgePort,
    },
  });

  try {
    // 1. Host OFF initial state: 0 listeners, 0 streams, 0 caches, 0 file opens
    const offSnap = host.getSnapshot();
    assert.equal(offSnap.state, 'STOPPED');
    assert.equal(offSnap.listeningPort, null);
    assert.equal(offSnap.activeSessions.length, 0);
    assert.equal(offSnap.metrics.hostMetrics.metadataCacheEntries, 0);
    assert.equal(offSnap.metrics.hostMetrics.artworkCacheEntries, 0);
    assert.equal(fsTracker.getTotalOpens(), 0);

    // 2. Host STANDBY: lazy cache (libraryViewCache still 0 until a Client queries library!)
    const started = await host.start();
    const lanPort = started.listeningPort!;
    const hostId = started.identity!.hostId;
    assert.equal(started.state, 'STANDBY');
    assert.equal(started.metrics.hostMetrics.metadataCacheEntries, 0);
    assert.equal(fsTracker.getTotalOpens(), 0);

    // Tailscale status caching: 4 rapid checks spawn CLI only once (3 subcommands instead of 12)
    tsCliCount = 0;
    await Promise.all([
      host.checkRemoteProvider(),
      host.checkRemoteProvider(),
      host.checkRemoteProvider(),
      host.checkRemoteProvider(),
    ]);
    assert.equal(tsCliCount, 3, 'Concurrent & cached Tailscale provider checks must coalesce');

    // Enable Remote Access & pair Client
    const remSnap = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    gwPort = remSnap.remoteAccess!.gatewayListeningPort!;
    const probe = await client.probeHost('127.0.0.1', lanPort);
    assert.equal(
      client.getPooledSocketCounts().agentCount,
      0,
      'Unauthenticated probeHost must use agent: false and retain 0 pooled agents',
    );

    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Lifecycle Client',
    });
    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await client.syncRemoteAccessOverLan(hostId);

    // Switch to Remote HTTPS & verify Keep-Alive connection reuse + SQLite touch throttling across 20 Range requests!
    await client.setConnectionMode(hostId, 'remote-only');
    await client.connectToRememberedHost(hostId);
    const handshakesAfterConnect = remoteTlsHandshakes;
    const touchesBeforeBurst = sqliteTouchCount;

    const cleanUrl = buildRemoteTrackMediaUrl(hostId, cleanTrack.id);
    const reassembled: Buffer[] = [];
    for (let offset = 0; offset < cleanFlacBytes.length; offset += 131_072) {
      const end = Math.min(cleanFlacBytes.length - 1, offset + 131_071);
      const r = await client.resolveRemoteTrackMediaResponse(
        new Request(cleanUrl, { headers: { Range: `bytes=${offset}-${end}` } }),
      );
      assert.equal(r.status, 206);
      reassembled.push(Buffer.from(await r.arrayBuffer()));
    }
    assert.equal(
      sha256(Buffer.concat(reassembled)),
      sha256(cleanFlacBytes),
      'Original encoded FLAC bytes must remain 100% bit-identical',
    );
    const newHandshakesDuringRanges = remoteTlsHandshakes - handshakesAfterConnect;
    assert.ok(
      newHandshakesDuringRanges <= 2,
      `Scoped HTTPS keep-alive pool should reuse TLS sockets across 20 sequential ranges (got ${newHandshakesDuringRanges} handshakes)`,
    );
    assert.ok(
      sqliteTouchCount - touchesBeforeBurst <= 1,
      `SQLite touchDeviceActivity must be throttled during Range burst (got ${sqliteTouchCount - touchesBeforeBurst} writes)`,
    );
    assert.equal(fsTracker.getOpenHandleCount(), 0, 'Zero open file handles after stream completion');

    // Unauthenticated & outside-prefix Remote abuse requests rejected cleanly without leaking handles
    const unauthStatus = await new Promise<number>((resolve, reject) => {
      const req = https.get(
        {
          host: '127.0.0.1',
          port: edgePort,
          servername: REMOTE_HOSTNAME,
          ca: ca.caCertPem,
          path: '/doremi-connect/api/v1/library/tracks?offset=0&limit=10',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
    });
    assert.equal(unauthStatus, 401, 'Unauthenticated Remote API call must fail closed with 401');

    const outsidePrefixStatus = await new Promise<number>((resolve, reject) => {
      const req = https.get(
        {
          host: '127.0.0.1',
          port: edgePort,
          servername: REMOTE_HOSTNAME,
          ca: ca.caCertPem,
          path: '/admin/debug',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
    });
    assert.equal(outsidePrefixStatus, 404, 'Requests outside /doremi-connect must fail closed with 404');
    assert.equal(fsTracker.getOpenHandleCount(), 0);

    // Stream cancellation, paused stream preservation vs abandoned stream sweep, & 416 invalid range cleanup
    const invalidRangeResp = await client.resolveRemoteTrackMediaResponse(
      new Request(cleanUrl, { headers: { Range: `bytes=${cleanFlacBytes.length + 100}-${cleanFlacBytes.length + 200}` } }),
    );
    assert.equal(invalidRangeResp.status, 416);
    assert.equal(fsTracker.getOpenHandleCount(), 0);

    // Legitimate paused stream held under TCP backpressure must NOT be prematurely killed by a 60s sweep window,
    // and must resume delivering bit-identical bytes; then an abandoned stream exceeding idle threshold IS swept cleanly.
    const pausedResp = await client.resolveRemoteTrackMediaResponse(
      new Request(cleanUrl, { headers: { Range: `bytes=0-${cleanFlacBytes.length - 1}` } }),
    );
    assert.equal(pausedResp.status, 206);
    const pausedReader = pausedResp.body!.getReader();
    const firstPausedChunk = await pausedReader.read();
    assert.equal(firstPausedChunk.done, false);
    const pausedChunks: Buffer[] = [Buffer.from(firstPausedChunk.value!)];
    await sleep(80);
    // Normal Host idle sweep threshold (180s) does NOT touch an active paused stream
    assert.equal(host['budget'].sweepAbandonedStreams(180_000), 0);
    while (true) {
      const next = await pausedReader.read();
      if (next.done) break;
      pausedChunks.push(Buffer.from(next.value));
    }
    assert.equal(
      sha256(Buffer.concat(pausedChunks)),
      sha256(cleanFlacBytes),
      'Paused stream must resume and deliver 100% bit-identical bytes',
    );
    assert.equal(fsTracker.getOpenHandleCount(), 0);

    // Abandoned stream stalled beyond maxIdleMs is deterministically swept & closes Host file handle
    const abandonedResp = await client.resolveRemoteTrackMediaResponse(
      new Request(cleanUrl, { headers: { Range: `bytes=0-${cleanFlacBytes.length - 1}` } }),
    );
    const abandonedReader = abandonedResp.body!.getReader();
    await abandonedReader.read();
    await sleep(60);
    if (host.getSnapshot().activeSessions.length > 0) {
      const swept = host['budget'].sweepAbandonedStreams(20);
      assert.ok(swept >= 1, 'Abandoned stalled stream past maxIdleMs must be swept');
    }
    await abandonedReader.cancel().catch(() => {});
    await sleep(60);
    assert.equal(fsTracker.getOpenHandleCount(), 0, 'Swept abandoned stream must release Host file handle');

    const cancelCtrl = new AbortController();
    const cancelResp = await client.resolveRemoteTrackMediaResponse(
      new Request(cleanUrl, { headers: { Range: `bytes=0-${cleanFlacBytes.length - 1}` }, signal: cancelCtrl.signal }),
    );
    const cancelReader = cancelResp.body!.getReader();
    await cancelReader.read();
    cancelCtrl.abort();
    await cancelReader.cancel().catch(() => {});
    await sleep(60);
    assert.equal(fsTracker.getOpenHandleCount(), 0, 'Canceled stream must release Host file handle');
    assert.equal(host.getSnapshot().activeSessions.length, 0);

    // Artwork request deduplication & non-starvation under 12 concurrent requests
    artworkServiceCalls = 0;
    const artUrl = buildRemoteArtworkMediaUrl(hostId, cleanTrack.id, 'thumb');
    const artResponses = await Promise.all(
      Array.from({ length: 12 }, () => client.resolveRemoteArtworkMediaResponse(new Request(artUrl))),
    );
    for (const ar of artResponses) {
      assert.equal(ar.status, 200);
      await ar.arrayBuffer();
    }
    assert.equal(
      artworkServiceCalls,
      1,
      'Host inflightArtwork deduplication + cache must read underlying artwork only once',
    );

    // Lyrics priority (Custom > External LRC > Embedded) + Client cache across handover + invalidation
    const lyr1 = await client.getRemoteLyrics(hostId, cleanTrack.id);
    assert.equal(lyr1.source, 'sidecar', 'External sidecar LRC must beat embedded lyrics');
    lyricsService.saveCustomLyrics(cleanTrack.id, 'lrc', '[00:02.00] Custom Override Line');
    host.invalidateLibraryCache();
    // Simulate source/metadata refresh & verify Custom lyrics wins
    await client.listRemoteTracks({ offset: 0, limit: 10 });
    client['remoteLyricsCache'].clear();
    const lyr2 = await client.getRemoteLyrics(hostId, cleanTrack.id);
    assert.equal(lyr2.source, 'custom', 'Custom lyrics must beat sidecar & embedded');
    assert.ok(lyr2.rawContent.includes('Custom Override Line'));

    // FLAC compatibility plan caching + sourceRevision invalidation
    clearFlacSanitizerCache();
    const compatUrl = buildRemoteTrackMediaUrl(hostId, compatTrack.id);
    const compatResp1 = await client.resolveRemoteTrackMediaResponse(
      new Request(compatUrl, { headers: { Range: 'bytes=0-4095' } }),
    );
    assert.equal(compatResp1.status, 206);
    assert.equal(compatResp1.headers.get('X-DoReMi-Transfer-Mode'), 'remote-flac-normalized');
    const compatHead1 = Buffer.from(await compatResp1.arrayBuffer());
    assert.equal(compatHead1.subarray(0, 4).toString('ascii'), 'fLaC', 'Prepended ID3v2 stripped virtually');
    assert.equal(getFlacSanitizerCacheStats().entries, 1);

    // Modify compat FLAC file on disk -> verifyTrackSourceConsistency invalidates stale FLAC plan!
    const updatedCompatBytes = buildFlacWithBrokenPictureBlock(crypto.randomBytes(160 * 1024));
    await fs.writeFile(compatFlacPath, updatedCompatBytes);
    const updatedStat = await fs.stat(compatFlacPath);
    trackRepo.upsertBatch([
      {
        original_path: compatFlacPath,
        normalized_path: normalizeTrackPath(compatFlacPath),
        title: 'Compat FLAC Track',
        artist: 'DoReMi Artist',
        album: 'Lifecycle Album',
        duration_ms: 95_000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 48_000,
        bit_depth: 24,
        bitrate_bps: 1_500_000,
        file_size_bytes: updatedCompatBytes.length,
        modified_at_ms: Math.round(updatedStat.mtimeMs) + 5_000,
        status: 'available',
      },
    ]);
    host.invalidateLibraryCache();
    const consistency = await client.verifyTrackSourceConsistency({
      hostId,
      trackId: compatTrack.id,
      expectedFileSize: compatFlacBytes.length,
      expectedSourceRevision: `${compatFlacBytes.length}:${Math.round(s2.mtimeMs)}`,
    });
    assert.equal(consistency.sourceConsistent, false);
    assert.equal(
      getFlacSanitizerCacheStats().entries,
      0,
      'Modified sourceRevision must invalidate cached remote FLAC sanitizer plan',
    );

    // Scoped Resource Breakdown (Phase 7.4 backend contract — zero background timers)
    const breakdown = await host.getResourceBreakdown({ includeTailscaleProcesses: false });
    assert.equal(breakdown.hostState, 'STANDBY');
    assert.ok(breakdown.mainProcess.rssBytes > 0);
    assert.ok(breakdown.serverCounters.totalRemoteBytesSent > 0);
    assert.equal(breakdown.tailscaleProcesses.sampled, false);

    // Cross-Host isolation & disconnect socket cleanup
    const h2Snap = await host2.start();
    const p2 = await client.probeHost('127.0.0.1', h2Snap.listeningPort!);
    const inv2 = host2.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: h2Snap.listeningPort!,
      expectedFingerprintSha256: p2.observedFingerprintSha256!,
      inviteCode: inv2.inviteCode,
      deviceName: 'Lifecycle Client',
    });
    assert.equal(client.getSnapshot().activeHost?.hostId, h2Snap.identity!.hostId);

    await client.disconnect();
    assert.deepEqual(client.getPooledSocketCounts(), {
      agentCount: 0,
      activeSockets: 0,
      freeSockets: 0,
    });
    assert.equal(getFlacSanitizerCacheStats().entries, 0);

    // Host OFF releases caches, listeners, Remote Gateway & owned Funnel route
    const stoppedSnap = await host.stop();
    assert.equal(stoppedSnap.state, 'STOPPED');
    assert.equal(stoppedSnap.listeningPort, null);
    assert.equal(stoppedSnap.remoteAccess?.state, 'DISABLED');
    assert.equal(stoppedSnap.remoteAccess?.gatewayListeningPort, null);
    assert.equal(routeTarget, '');
    assert.equal(stoppedSnap.metrics.hostMetrics.metadataCacheEntries, 0);
    assert.equal(stoppedSnap.metrics.hostMetrics.artworkCacheEntries, 0);
    assert.equal(stoppedSnap.metrics.hostMetrics.lyricsCacheEntries, 0);
    assert.equal(fsTracker.getOpenHandleCount(), 0);
  } finally {
    await client.shutdown().catch(() => {});
    await host2.dispose().catch(() => {});
    await host.dispose().catch(() => {});
    edgeAgent.destroy();
    await new Promise<void>((r) => {
      edgeServer.closeAllConnections?.();
      edgeServer.close(() => r());
    });
    clientConn.close();
    host2Conn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 6.5 ALAC WASM Memory Lifecycle & Audio Parity — Window/Index Idle Eviction, Byte Cap & PCM Parity (16/24/96 + EOF moov)', async () => {
  const ffmpeg =
    process.env.FFMPEG_PATH ||
    'D:\\Dowload\\FFmpeg\\ffmpeg-2026-11-23-git-05c674c913-full_build\\bin\\ffmpeg.exe';
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p65-alac-'));

  try {
    const mkAlac = (name: string, args: string[]) => {
      const out = path.join(tmpDir, name);
      const res = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], {
        windowsHide: true,
        timeout: 30_000,
      });
      assert.equal(res.status, 0, `FFmpeg failed for ${name}`);
      return out;
    };

    const coThePath = mkAlac('Co-The-102112-Version.m4a', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
      '-ac', '2', '-sample_fmt', 's16p', '-c:a', 'alac', '-movflags', '+faststart',
    ]);
    const secondAlacPath = mkAlac('Another-ALAC-24-48k.m4a', [
      '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=48000:duration=5',
      '-ac', '2', '-sample_fmt', 's32p', '-bits_per_raw_sample', '24', '-c:a', 'alac', '-movflags', '+faststart',
    ]);
    const hiResEofMoovPath = mkAlac('HiRes-ALAC-24-96k-EOF-Moov.m4a', [
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=96000:duration=5',
      '-ac', '2', '-sample_fmt', 's32p', '-bits_per_raw_sample', '24', '-c:a', 'alac',
    ]);

    const mgr = new RemoteAlacStreamManager({ windowIdleMs: 1_000, indexIdleMs: 2_200 });

    const verifyParityAndSeeking = async (filePath: string, key: string) => {
      const fullBytes = await fs.readFile(filePath);
      const directTrack = openTrack(new Uint8Array(fullBytes.buffer, fullBytes.byteOffset, fullBytes.byteLength));
      assert.ok(directTrack, `Direct @mgz-dev/alac must open ${path.basename(filePath)}`);
      const expectedPcm = Buffer.from(decodeTrack(directTrack, 0, directTrack.samples));
      closeTrack(directTrack);

      let maxRangeFetched = 0;
      const fetcher = async (start: number, end: number) => {
        const clampedEnd = Math.min(fullBytes.length - 1, end);
        const slice = Buffer.from(fullBytes.subarray(start, clampedEnd + 1));
        maxRangeFetched = Math.max(maxRangeFetched, slice.length);
        return { status: 206, totalSize: fullBytes.length, buffer: slice };
      };

      const entry = await mgr.resolveEntry(key, fetcher);
      assert.ok('codec' in entry && entry.codec === 'alac');

      // Full stream PCM parity check
      const fullWavResp = await mgr.createWavMediaResponse({
        entry,
        method: 'GET',
        rangeHeader: null,
        corsHeaders: {},
        fetcher,
      });
      const fullWavBuf = Buffer.from(await fullWavResp.arrayBuffer());
      const actualPcm = fullWavBuf.subarray(WAV_HEADER_BYTES);
      assert.equal(actualPcm.length, expectedPcm.length);
      assert.equal(sha256(actualPcm), sha256(expectedPcm), `Decoded PCM parity mismatch on ${key}`);
      assert.ok(maxRangeFetched < 600 * 1024, `Range window stayed bounded (${maxRangeFetched} B)`);

      // Repeated arbitrary mid-track seeking parity check
      for (const seekOffset of [44 + 12_345, 44 + 160_000, 44 + Math.floor(expectedPcm.length * 0.7)]) {
        const seekEnd = Math.min(fullWavBuf.length - 1, seekOffset + 32_767);
        const seekResp = await mgr.createWavMediaResponse({
          entry,
          method: 'GET',
          rangeHeader: `bytes=${seekOffset}-${seekEnd}`,
          corsHeaders: {},
          fetcher,
        });
        assert.equal(seekResp.status, 206);
        const seekBytes = Buffer.from(await seekResp.arrayBuffer());
        assert.equal(
          sha256(seekBytes),
          sha256(fullWavBuf.subarray(seekOffset, seekEnd + 1)),
          `Seek byte parity must match exact WAV offset ${seekOffset}`,
        );
      }
    };

    await verifyParityAndSeeking(coThePath, 'host::co-the::1');
    await verifyParityAndSeeking(secondAlacPath, 'host::another-24-48::1');
    await verifyParityAndSeeking(hiResEofMoovPath, 'host::hires-eof::1');

    const activeStats = mgr.getStats();
    assert.equal(activeStats.cachedIndexes, 3);
    assert.ok(activeStats.windowBytes <= 6 * 1024 * 1024, 'Decoded PCM windows must respect <= 6 MB cap');
    assert.equal(activeStats.sweepTimerActive, true);

    // Wait > windowIdleMs (1.0s) -> decoded PCM windows freed while lightweight index remains
    await sleep(1_250);
    mgr.sweepIdleState();
    const midStats = mgr.getStats();
    assert.equal(midStats.activeWindows, 0, 'Idle decoded PCM windows must be released first');
    assert.equal(midStats.windowBytes, 0);
    assert.equal(midStats.cachedIndexes, 3);

    // Wait > indexIdleMs (2.2s total) -> all indexes evicted & sweep timer self-disarms to false!
    await sleep(1_200);
    mgr.sweepIdleState();
    const idleStats = mgr.getStats();
    assert.equal(idleStats.cachedIndexes, 0);
    assert.equal(idleStats.activeWindows, 0);
    assert.equal(idleStats.sweepTimerActive, false, 'Sweep timer must self-disarm when cache is empty');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
