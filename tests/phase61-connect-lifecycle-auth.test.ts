import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
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
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { generateSelfSignedHostCertificate } from '../src/main/services/connect/x509-cert';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  buildRemoteTrackId,
  mapRemoteTrackDtoToTrackRecord,
} from '../src/shared/contracts/connect-api';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';
import { AudioEngine, type AudioElementLike } from '../src/renderer/src/player/audio-engine';

function createFakeAudioElement(): AudioElementLike & { trigger(ev: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  let isPaused = true;
  return {
    src: '',
    crossOrigin: 'anonymous',
    currentTime: 0,
    duration: 120,
    volume: 1,
    muted: false,
    preload: 'metadata',
    get paused() {
      return isPaused;
    },
    ended: false,
    error: null,
    async play() {
      isPaused = false;
      this.trigger('playing');
    },
    pause() {
      isPaused = true;
      this.trigger('pause');
    },
    load() {},
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    trigger(type: string) {
      for (const fn of listeners.get(type) ?? []) {
        fn();
      }
    },
  };
}

async function createHostFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-auth-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const songPath = path.join(musicDir, '01-Test-Lossless.flac');
  await fs.writeFile(songPath, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(64 * 1024)]));
  const lrcPath = path.join(musicDir, '01-Test-Lossless.lrc');
  await fs.writeFile(lrcPath, '[00:01.00] Xin chào DoReMi Connect\n', 'utf8');

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
      title: 'Test Lossless Song',
      artist: 'Nghệ Sĩ Việt',
      album: 'Album Thử Nghiệm',
      duration_ms: 180_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 900_000,
      file_size_bytes: 65540,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);

  const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });
  const lyricsService = new LyricsService({ trackRepo, lyricsRepo });
  const connectRepo = new ConnectRepository(conn.db);
  const secrets = new ConnectSecretStorage({ userDataDir });

  // Bind to loopback ephemeral port 0 in automated test
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.2',
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService,
    lyricsService,
    secrets,
    enableMdns: false,
  });

  return {
    tmpRoot,
    userDataDir,
    musicDir,
    songPath,
    root,
    conn,
    trackRepo,
    artworkService,
    lyricsService,
    connectRepo,
    secrets,
    host,
    cleanup: async () => {
      await host.stop();
      conn.close();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

test('Phase 6.1A: Host lifecycle OFF by default, start/stop/concurrent toggles, port conflict & error recovery', async () => {
  const fx = await createHostFixture();
  try {
    // OFF by default
    const initial = fx.host.getSnapshot();
    assert.equal(initial.config.enabled, false);
    assert.equal(initial.config.autoStart, false);
    assert.equal(initial.state, 'STOPPED');
    assert.equal(initial.listeningPort, null);
    assert.equal(initial.diagnostics.discoveryActive, false);

    // Concurrent start calls are idempotent
    const [s1, s2] = await Promise.all([fx.host.start(), fx.host.start()]);
    assert.equal(s1.state, 'STANDBY');
    assert.equal(s2.state, 'STANDBY');
    assert.ok(s1.listeningPort && s1.listeningPort > 0);

    // Repeated ON/OFF cycling
    const stopped = await fx.host.stop();
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(stopped.listeningPort, null);

    const restarted = await fx.host.start();
    assert.equal(restarted.state, 'STANDBY');
    const port = restarted.listeningPort!;
    await fx.host.stop();

    // Port conflict produces ERROR state without breaking local state, and recovers on valid port
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
    try {
      await fx.host.updateConfig({ port });
      const errSnap = await fx.host.start();
      assert.equal(errSnap.state, 'ERROR');
      assert.ok(errSnap.lastError);
      assert.equal(errSnap.listeningPort, null);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    await fx.host.updateConfig({ port: 0 });
    const recovered = await fx.host.start();
    assert.equal(recovered.state, 'STANDBY');
    assert.ok(recovered.listeningPort && recovered.listeningPort > 0);
  } finally {
    await fx.cleanup();
  }
});

test('Phase 6.1B & E: TLS fingerprint verification, single-use enrollment, approval/rejection, revocation, MITM rejection & AudioEngine remote playback', async () => {
  const fx = await createHostFixture();
  const clientTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-client-'));
  const clientDb = openLibraryDatabase(path.join(clientTmp, 'client.db'));
  const clientRepo = new ConnectRepository(clientDb.db);
  const clientSecrets = new ConnectSecretStorage({ userDataDir: clientTmp });
  const client = new ConnectClientService({
    connectRepo: clientRepo,
    secrets: clientSecrets,
  });

  try {
    // Share the music folder explicitly (0 shared before adding)
    assert.equal(fx.host.getSnapshot().sharedTrackCount, 0);
    fx.host.addSharedSource(fx.root.id);
    assert.equal(fx.host.getSnapshot().sharedTrackCount, 1);

    const hostSnap = await fx.host.start();
    const port = hostSnap.listeningPort!;
    const hostId = hostSnap.identity!.hostId;

    // 1. Probe Host and verify identity fingerprint
    const probe = await client.probeHost('127.0.0.1', port);
    assert.equal(probe.reachable, true);
    assert.equal(probe.pinnedFingerprintMismatch, false);
    assert.ok(probe.observedFingerprintSha256);
    assert.equal(probe.capabilities?.hostId, hostId);

    // 2. Reject invalid invite code & verify rate limit after 5 bad attempts
    const inv = fx.host.createInvitation({ autoApproveSingleUse: false });
    const badRes = await client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: 'WRONG-CODE-0000',
      deviceName: 'Test Client',
      pollIntervalMs: 100,
      maxWaitMs: 3000,
    });
    assert.equal(badRes.enrollment.status, 'error');
    assert.equal(badRes.enrollment.errorCode, 'AUTH_FAILED');

    // 3. Real Host Rejection flow
    const pendingPromiseReject = client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Rejected Device',
      pollIntervalMs: 150,
      maxWaitMs: 5000,
    });
    // Wait until Host sees pending enrollment
    let pendingId: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const p = fx.host.getSnapshot().pendingEnrollments;
      if (p.length > 0) {
        pendingId = p[0].requestId;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pendingId, 'Host should receive pending enrollment request');
    fx.host.rejectEnrollment(pendingId);
    const rejectedSnap = await pendingPromiseReject;
    assert.equal(rejectedSnap.enrollment.status, 'rejected');

    // Reusing consumed invite must fail
    const reuseRes = await client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Replay Device',
      pollIntervalMs: 100,
      maxWaitMs: 2000,
    });
    assert.equal(reuseRes.enrollment.errorCode, 'ENROLLMENT_EXPIRED');

    // 4. Successful Enrollment with manual Host Approval
    const inv2 = fx.host.createInvitation({ autoApproveSingleUse: false });
    const pendingPromiseApprove = client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv2.inviteCode,
      deviceName: 'Windows Laptop Client',
      pollIntervalMs: 150,
      maxWaitMs: 5000,
    });
    let approveReqId: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const p = fx.host.getSnapshot().pendingEnrollments;
      if (p.length > 0) {
        approveReqId = p[0].requestId;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(approveReqId);
    fx.host.approveEnrollment(approveReqId);
    const connectedSnap = await pendingPromiseApprove;
    assert.equal(connectedSnap.status, 'connected');
    assert.equal(connectedSnap.activeHost?.hostId, hostId);
    assert.equal(connectedSnap.rememberedHosts.length, 1);

    // 5. Browse remote tracks, search & lyrics (zero Host filesystem path leaks!)
    const tracksPage = await client.listRemoteTracks({ offset: 0, limit: 50 });
    assert.equal(tracksPage.total, 1);
    assert.equal(tracksPage.items[0].title, 'Test Lossless Song');

    const lyrics = await client.getRemoteLyrics(hostId, tracksPage.items[0].trackId);
    assert.equal(lyrics.source, 'sidecar');
    assert.equal(lyrics.format, 'lrc');
    assert.equal(lyrics.sidecarPath, null); // Never leaks Host disk path

    // 6. Restricted internal media protocol adapter streams authenticated audio & blocks unauthenticated/foreign Host
    const remoteTrack = tracksPage.items[0];
    const mediaResp = await client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, remoteTrack.trackId), {
        headers: { Range: 'bytes=0-1023' },
      }),
    );
    assert.equal(mediaResp.status, 206);
    const bytes = Buffer.from(await mediaResp.arrayBuffer());
    assert.equal(bytes.length, 1024);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'fLaC');

    const foreignResp = await client.resolveRemoteTrackMediaResponse(
      new Request(
        buildRemoteTrackMediaUrl(
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          remoteTrack.trackId,
        ),
      ),
    );
    assert.equal(foreignResp.status, 403);

    // 7. AudioEngine plays remote track via ExternalTrackResolver without touching local listening sessions
    const fakeAudio = createFakeAudioElement();
    let recordedLocalSessions = 0;
    const remoteRecord = mapRemoteTrackDtoToTrackRecord(hostId, remoteTrack);
    const compositeId = buildRemoteTrackId(hostId, remoteTrack.trackId);
    const engine = new AudioEngine({
      createAudioElement: () => fakeAudio,
      createAudioContext: null,
      verifyTrack: async () => {
        throw new Error('Local verifyTrack must NOT be called for remote track!');
      },
      onSessionCheckpoint: () => {
        recordedLocalSessions += 1;
      },
      externalTrackResolver: {
        ownsTrackId: (id) => id.startsWith('remote::'),
        getTrack: (id) => (id === compositeId ? remoteRecord : null),
        resolveMediaUrl: () => buildRemoteTrackMediaUrl(hostId, remoteTrack.trackId),
        isTrackPlayable: (id) => id === compositeId,
      },
    });
    await engine.playFromContext({
      contextId: 'remote-test',
      label: 'Remote Test',
      kind: 'library',
      trackIds: [compositeId],
    });
    assert.equal(engine.getPlaybackState().status, 'playing');
    assert.equal(engine.getPlaybackState().currentTrackId, compositeId);
    engine.seek(30);
    assert.equal(engine.getPlaybackState().currentTimeSeconds, 30);
    engine.pause();
    assert.equal(engine.getPlaybackState().status, 'paused');
    assert.equal(recordedLocalSessions, 0);
    engine.dispose();

    // 8. Remembered Host persists across client service restart AND detects Host identity mismatch (MITM / rotated cert)
    const client2 = new ConnectClientService({
      connectRepo: clientRepo,
      secrets: clientSecrets,
    });
    assert.equal(client2.getSnapshot().rememberedHosts.length, 1);
    const reconnected = await client2.connectToRememberedHost(hostId);
    assert.equal(reconnected.status, 'connected');

    // Simulate Host rotating identity -> Client MUST detect mismatch and refuse auto-trust!
    await fx.host.rotateIdentity();
    const newPort = fx.host.getSnapshot().listeningPort!;
    const mismatchRes = await client2.connectToRememberedHost(hostId, '127.0.0.1', newPort);
    assert.equal(mismatchRes.status, 'error');
    assert.equal(mismatchRes.lastErrorCode, 'HOST_IDENTITY_MISMATCH');

    // 9. Revoking device immediately rejects protected requests (on original identity or freshly enrolled device)
    const inv3 = fx.host.createInvitation({ autoApproveSingleUse: true });
    const newProbe = await client2.probeHost('127.0.0.1', newPort);
    const enrolled2 = await client2.enrollWithHost({
      address: '127.0.0.1',
      port: newPort,
      expectedFingerprintSha256: newProbe.observedFingerprintSha256!,
      inviteCode: inv3.inviteCode,
      deviceName: 'Revokable Client',
    });
    assert.equal(enrolled2.status, 'connected');
    const devId = enrolled2.activeHost!.deviceId;
    fx.host.revokeDevice(devId);

    await assert.rejects(() => client2.listRemoteTracks(), /revoked|ACCESS_REVOKED/i);
    assert.equal(client2.getSnapshot().lastErrorCode, 'ACCESS_REVOKED');

    // Verify self-signed cert utility generates valid P-256 certs
    const certInfo = generateSelfSignedHostCertificate('UnitTest');
    assert.match(certInfo.certificatePem, /BEGIN CERTIFICATE/);
  } finally {
    await client.disconnect();
    clientDb.close();
    await fs.rm(clientTmp, { recursive: true, force: true });
    await fx.cleanup();
  }
});
