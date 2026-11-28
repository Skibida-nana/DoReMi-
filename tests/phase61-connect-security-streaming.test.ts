import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LyricsService } from '../src/main/services/lyrics-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import {
  SharedFilesystemGuard,
  type GuardedFsOps,
} from '../src/main/services/connect/filesystem-guard';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import {
  decodeMdnsPacket,
  encodeMdnsAnnouncementPacket,
  LanDiscoveryService,
  type MdnsSocketLike,
} from '../src/main/services/connect/lan-discovery-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { normalizeTrackPath } from '../src/main/services/path-utils';

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pinnedHttpsRawRequest(params: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method ?? 'GET',
        headers: params.headers,
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('Phase 6.1C: Shared filesystem guard blocks traversal, unshared tracks, UNC injection, symlink/junction escapes & TOCTOU', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-fs-'));
  const sharedDir = path.join(tmpRoot, 'shared');
  const outsideDir = path.join(tmpRoot, 'outside');
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const insideFile = path.join(sharedDir, 'inside.flac');
  const outsideFile = path.join(outsideDir, 'secret.flac');
  await fs.writeFile(insideFile, Buffer.from('fLaCinside-bytes'));
  await fs.writeFile(outsideFile, Buffer.from('fLaCsecret-outside'));

  const conn = openLibraryDatabase(path.join(tmpRoot, 'lib.db'));
  const trackRepo = new TrackRepository(conn.db);
  const rootRepo = new LibraryRootRepository(conn.db);
  const connectRepo = new ConnectRepository(conn.db);

  const sharedRoot = rootRepo.upsertRoot(sharedDir, normalizeTrackPath(sharedDir));
  const outsideRoot = rootRepo.upsertRoot(outsideDir, normalizeTrackPath(outsideDir));
  connectRepo.addSharedSource(sharedRoot.id);

  trackRepo.upsertBatch([
    {
      original_path: insideFile,
      normalized_path: normalizeTrackPath(insideFile),
      title: 'Inside Track',
      artist: 'Artist',
      album: 'Album',
      duration_ms: 10_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 800_000,
      file_size_bytes: 16,
      modified_at_ms: Date.now(),
      status: 'available',
    },
    {
      original_path: outsideFile,
      normalized_path: normalizeTrackPath(outsideFile),
      title: 'Outside Track',
      artist: 'Artist',
      album: 'Album',
      duration_ms: 10_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 800_000,
      file_size_bytes: 18,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);

  const insideTrack = trackRepo.findByNormalizedPath(normalizeTrackPath(insideFile))!;
  const outsideTrack = trackRepo.findByNormalizedPath(normalizeTrackPath(outsideFile))!;

  try {
    const guard = new SharedFilesystemGuard({ connectRepo, trackRepo });

    // Valid shared file succeeds and opens fd cleanly
    const okRes = await guard.resolveAuthorizedAudioFile(insideTrack.id);
    assert.equal(okRes.ok, true);
    if (okRes.ok) {
      await okRes.handle.close();
    }

    // Unshared folder track is blocked (403)
    const deniedUnshared = await guard.resolveAuthorizedAudioFile(outsideTrack.id);
    assert.equal(deniedUnshared.ok, false);
    if (!deniedUnshared.ok) {
      assert.equal(deniedUnshared.code, 'NOT_SHARED');
    }

    // Invalid track UUID / traversal / encoded traversal blocked
    for (const badId of ['../secret', '..%2fsecret', 'C:\\Windows\\win.ini', 'not-a-uuid']) {
      const bad = await guard.resolveAuthorizedAudioFile(badId);
      assert.equal(bad.ok, false);
    }

    // Unauthorized UNC path rejected
    const uncCheck = await guard.validateAndOpenPathWithinRoot(
      '\\\\evil-server\\share\\song.flac',
      sharedDir,
    );
    assert.equal(uncCheck.ok, false);
    if (!uncCheck.ok) {
      assert.equal(uncCheck.code, 'UNC_REJECTED');
    }

    // Simulated Windows junction / reparse point escape via GuardedFsOps
    const escapeOps: GuardedFsOps = {
      realpath: async (p) => (p === sharedDir ? sharedDir : outsideFile),
      lstat: async () => ({
        isSymbolicLink: () => true,
        isFile: () => true,
        isDirectory: () => false,
      }),
      openRead: async () => {
        throw new Error('Must never open escaped file');
      },
    };
    const simulatedGuard = new SharedFilesystemGuard({
      connectRepo,
      trackRepo,
      fsOps: escapeOps,
    });
    const escaped = await simulatedGuard.resolveAuthorizedAudioFile(insideTrack.id);
    assert.equal(escaped.ok, false);
    if (!escaped.ok) {
      assert.equal(escaped.code, 'PATH_ESCAPE_DENIED');
    }

    // Removing shared source blocks subsequent access immediately
    connectRepo.removeSharedSource(sharedRoot.id);
    const afterRemove = await guard.resolveAuthorizedAudioFile(insideTrack.id);
    assert.equal(afterRemove.ok, false);
    if (!afterRemove.ok) {
      assert.equal(afterRemove.code, 'NOT_SHARED');
    }
    void outsideRoot;
  } finally {
    conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 6.1D & F: Original-file SHA-256 byte integrity, HEAD/206/416 ranges, client concurrency limit, mDNS & Host resource cleanup', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-stream-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  // 512 KB controlled binary FLAC-header fixture
  const payloadBytes = Buffer.concat([
    Buffer.from('fLaC\x00\x00\x00\x22'),
    crypto.randomBytes(512 * 1024),
  ]);
  const expectedFullHash = sha256Hex(payloadBytes);
  const songPath = path.join(musicDir, 'Integrity-HiRes.flac');
  await fs.writeFile(songPath, payloadBytes);

  const conn = openLibraryDatabase(path.join(userDataDir, 'library.db'));
  const trackRepo = new TrackRepository(conn.db);
  const rootRepo = new LibraryRootRepository(conn.db);
  const artworkRepo = new ArtworkRepository(conn.db);
  const lyricsRepo = new LyricsRepository(conn.db);

  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
  trackRepo.upsertBatch([
    {
      original_path: songPath,
      normalized_path: normalizeTrackPath(songPath),
      title: 'Integrity HiRes',
      artist: 'Lossless Artist',
      album: 'Integrity Album',
      duration_ms: 240_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 96000,
      bit_depth: 24,
      bitrate_bps: 3_000_000,
      file_size_bytes: payloadBytes.length,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);
  const track = trackRepo.findAll()[0];
  const connectRepo = new ConnectRepository(conn.db);
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.2',
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir }),
    enableMdns: false,
  });
  host.addSharedSource(root.id);

  const clientTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-stream-client-'));
  const clientDb = openLibraryDatabase(path.join(clientTmp, 'c.db'));
  const client = new ConnectClientService({
    connectRepo: new ConnectRepository(clientDb.db),
    secrets: new ConnectSecretStorage({ userDataDir: clientTmp }),
  });

  try {
    const snap = await host.start();
    const port = snap.listeningPort!;
    const probe = await client.probeHost('127.0.0.1', port);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Streamer 1',
    });

    const token = new ConnectSecretStorage({ userDataDir: clientTmp }).getSecret(
      `client.host.${snap.identity!.hostId}.token`,
    )!;

    // 1. Unauthenticated stream request MUST fail 401
    const unauth = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
    });
    assert.equal(unauth.status, 401);

    // 2. Full file transfer SHA-256 integrity
    const full = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['x-doremi-transfer-mode'], 'direct-original');
    assert.equal(sha256Hex(full.body), expectedFullHash);

    // 3. HEAD request
    const head = await pinnedHttpsRawRequest({
      port,
      method: 'HEAD',
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-1023' },
    });
    assert.equal(head.status, 206);
    assert.equal(head.headers['content-length'], '1024');
    assert.equal(head.body.length, 0);

    // 4. Valid partial range, open-ended range, suffix range vs exact source slices
    const rMid = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=1000-4095' },
    });
    assert.equal(rMid.status, 206);
    assert.equal(rMid.headers['content-range'], `bytes 1000-4095/${payloadBytes.length}`);
    assert.equal(sha256Hex(rMid.body), sha256Hex(payloadBytes.subarray(1000, 4096)));

    const tailStart = payloadBytes.length - 4096;
    const rOpen = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${tailStart}-` },
    });
    assert.equal(rOpen.status, 206);
    assert.equal(sha256Hex(rOpen.body), sha256Hex(payloadBytes.subarray(tailStart)));

    const rSuffix = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=-512' },
    });
    assert.equal(rSuffix.status, 206);
    assert.equal(sha256Hex(rSuffix.body), sha256Hex(payloadBytes.subarray(payloadBytes.length - 512)));

    // 5. Invalid ranges & multi-range -> 416
    for (const badRange of ['bytes=999999999-', 'bytes=500-100', 'bytes=0-10,20-30', 'items=0-5']) {
      const rBad = await pinnedHttpsRawRequest({
        port,
        path: `/api/v1/stream/${track.id}`,
        headers: { Authorization: `Bearer ${token}`, Range: badRange },
      });
      assert.equal(rBad.status, 416, `Expected 416 for Range: ${badRange}`);
    }

    // 6. mDNS packet round-trip guarantees zero sensitive fields and clean discovery lifecycle
    const pkt = encodeMdnsAnnouncementPacket({
      hostId: snap.identity!.hostId,
      displayName: 'Living Room PC',
      address: '192.168.1.44',
      port: 48620,
      apiVersion: '1',
      mode: 'lan-direct',
      fingerprintPrefix: snap.identity!.shortFingerprint,
    });
    const decoded = decodeMdnsPacket(pkt, '192.168.1.44');
    assert.ok(decoded.advertisement);
    assert.equal(decoded.advertisement?.displayName, 'Living Room PC');
    assert.equal(decoded.advertisement?.port, 48620);
    assert.equal(pkt.toString('utf8').includes('Integrity-HiRes'), false);
    assert.equal(pkt.toString('utf8').includes(musicDir), false);

    // Mock mDNS scan + TTL=0 goodbye cleanup
    const mockDisc = new LanDiscoveryService({
      socketFactory: (): MdnsSocketLike => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        return {
          on(ev, cb) {
            handlers.set(ev, cb as (...args: unknown[]) => void);
          },
          bind(_p, _a, cb) {
            cb?.();
            setTimeout(() => {
              handlers.get('message')?.(pkt, { address: '192.168.1.44', port: 5353 });
            }, 20);
          },
          addMembership() {},
          send() {},
          close(cb) {
            cb?.();
          },
        };
      },
    });
    const found = await mockDisc.scanLanHosts(260);
    assert.equal(found.length, 1);
    assert.equal(found[0].address, '192.168.1.44');

    // Goodbye packet TTL=0 removes host
    const goodbye = encodeMdnsAnnouncementPacket(
      {
        hostId: snap.identity!.hostId,
        displayName: 'Living Room PC',
        address: '192.168.1.44',
        port: 48620,
        apiVersion: '1',
        mode: 'lan-direct',
        fingerprintPrefix: snap.identity!.shortFingerprint,
      },
      0,
    );
    mockDisc.ingestDiscoveryPacket(goodbye, '192.168.1.44');
    assert.equal(mockDisc.getCachedDiscoveredHosts().length, 0);

    // 7. Concurrent client limit enforcement (`maxActiveClients = 3`) & single-device multi-Range allowance
    // Enroll 3 additional devices (total 4 enrolled) so we can test 3 concurrent active streams vs 4th blocked
    const extraTokens: string[] = [];
    for (let i = 2; i <= 4; i += 1) {
      const cTmp = await fs.mkdtemp(path.join(os.tmpdir(), `doremi-p61-lim-${i}-`));
      const cDb = openLibraryDatabase(path.join(cTmp, 'c.db'));
      const cSec = new ConnectSecretStorage({ userDataDir: cTmp });
      const cSvc = new ConnectClientService({
        connectRepo: new ConnectRepository(cDb.db),
        secrets: cSec,
      });
      const invExtra = host.createInvitation({ autoApproveSingleUse: true });
      await cSvc.enrollWithHost({
        address: '127.0.0.1',
        port,
        expectedFingerprintSha256: probe.observedFingerprintSha256!,
        inviteCode: invExtra.inviteCode,
        deviceName: `Client ${i}`,
      });
      extraTokens.push(cSec.getSecret(`client.host.${snap.identity!.hostId}.token`)!);
      await cSvc.disconnect();
      cDb.close();
      await fs.rm(cTmp, { recursive: true, force: true });
    }

    // Open 3 slow-reading streams simultaneously on 3 distinct devices
    const openSlowStream = (tok: string) =>
      new Promise<{ req: import('node:http').ClientRequest; res: import('node:http').IncomingMessage }>((resolve, reject) => {
        const r = https.request(
          {
            host: '127.0.0.1',
            port,
            path: `/api/v1/stream/${track.id}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${tok}` },
            rejectUnauthorized: false,
            agent: false,
          },
          (res) => {
            res.pause(); // Hold backpressure open
            resolve({ req: r, res });
          },
        );
        r.on('error', reject);
        r.end();
      });

    const slow1 = await openSlowStream(token);
    const slow2 = await openSlowStream(extraTokens[0]);
    const slow3 = await openSlowStream(extraTokens[1]);
    assert.equal(slow1.res.statusCode, 200);
    assert.equal(slow2.res.statusCode, 200);
    assert.equal(slow3.res.statusCode, 200);
    assert.equal(host.getSnapshot().state, 'ACTIVE');

    // Same device issuing another Range request MUST still succeed (single client != multiple clients)
    const sameDeviceSecondRange = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-127' },
    });
    assert.equal(sameDeviceSecondRange.status, 206);

    // 4th distinct device MUST be rejected with 429 CLIENT_LIMIT_REACHED
    const fourthDeviceRejected = await pinnedHttpsRawRequest({
      port,
      path: `/api/v1/stream/${track.id}`,
      headers: { Authorization: `Bearer ${extraTokens[2]}`, Range: 'bytes=0-127' },
    });
    assert.equal(fourthDeviceRejected.status, 429);

    // Host shutdown mid-stream cleanly terminates active streams and returns to STOPPED
    await host.stop();
    slow1.req.destroy();
    slow2.req.destroy();
    slow3.req.destroy();
    assert.equal(host.getSnapshot().state, 'STOPPED');
    assert.equal(host.getSnapshot().activeSessions.length, 0);
    assert.equal(host.getSnapshot().metrics.hostMetrics.activeHttpRequests, 0);
  } finally {
    await client.disconnect();
    clientDb.close();
    await fs.rm(clientTmp, { recursive: true, force: true });
    await host.stop();
    conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
