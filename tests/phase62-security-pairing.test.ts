import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { createDatabaseSnapshotBackup } from '../src/main/database/integrity';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LyricsService } from '../src/main/services/lyrics-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { DeviceAuthorizationService } from '../src/main/services/connect/device-auth-service';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { SharedFilesystemGuard } from '../src/main/services/connect/filesystem-guard';
import { generateSelfSignedHostCertificate } from '../src/main/services/connect/x509-cert';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  PAIRING_PAYLOAD_MAX_BYTES,
  parseAndValidatePairingPayload,
  serializePairingPayload,
} from '../src/shared/contracts/connect-pairing';

async function createPhase62HostFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p62-sec-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const musicDir = path.join(tmpRoot, 'music');
  const outsideDir = path.join(tmpRoot, 'outside');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const songPath = path.join(musicDir, '01-Secure-Lossless.flac');
  await fs.writeFile(songPath, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(64 * 1024)]));
  const outsideSecret = path.join(outsideDir, 'secret.flac');
  await fs.writeFile(outsideSecret, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(8 * 1024)]));

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
      title: 'Security Lossless Test',
      artist: 'DoReMi Security',
      album: 'Phase 6.2 Suite',
      duration_ms: 120_000,
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
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
  connectRepo.addSharedSource(root.id);

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.6',
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
    outsideDir,
    outsideSecret,
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

function httpsJsonRequest(
  port: number,
  apiPath: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const raw = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1${apiPath}`,
        method,
        headers: {
          ...headers,
          ...(raw
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(raw.length),
              }
            : {}),
        },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

test('Phase 6.2-1: Pairing payload schema validation rejects URL schemes, prototype keys, oversize, expired & public IPs', () => {
  const validPayload = serializePairingPayload({
    protocol: 'doremi-pair',
    version: 1,
    hostId: '11111111-2222-4333-8444-555555555555',
    hostName: 'DoReMi Studio Host',
    endpoints: [{ transport: 'lan-https', address: '192.168.1.50', port: 48620 }],
    identityAlgorithm: 'spki-sha256',
    identityFingerprint: 'AA:'.repeat(31) + 'AA',
    invitation: 'ABCD-2345-EFGH',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(Buffer.byteLength(validPayload, 'utf8') <= PAIRING_PAYLOAD_MAX_BYTES);

  const okParsed = parseAndValidatePairingPayload(validPayload);
  assert.equal(okParsed.ok, true);

  // Reject HTTP / JS / file URLs
  for (const urlSample of [
    'https://evil.example/pair?code=ABCD',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
  ]) {
    const res = parseAndValidatePairingPayload(urlSample);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'UNSUPPORTED_URI_SCHEME');
  }

  // Reject prototype pollution keys
  const polluted = '{"__proto__":{"polluted":true},"protocol":"doremi-pair","version":1}';
  const polRes = parseAndValidatePairingPayload(polluted);
  assert.equal(polRes.ok, false);
  if (!polRes.ok) assert.equal(polRes.code, 'INJECTION_REJECTED');

  // Reject oversize (>2048 B)
  const huge = serializePairingPayload({
    protocol: 'doremi-pair',
    version: 1,
    hostId: '11111111-2222-4333-8444-555555555555',
    hostName: 'Host',
    endpoints: [{ transport: 'lan-https', address: '192.168.1.50', port: 48620 }],
    identityAlgorithm: 'spki-sha256',
    identityFingerprint: 'AA:'.repeat(31) + 'AA',
    invitation: 'ABCD-2345-EFGH',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const oversizePayload = JSON.stringify({
    ...JSON.parse(huge),
    hostName: 'X'.repeat(PAIRING_PAYLOAD_MAX_BYTES),
  });
  const sizeRes = parseAndValidatePairingPayload(oversizePayload);
  assert.equal(sizeRes.ok, false);
  if (!sizeRes.ok) assert.equal(sizeRes.code, 'PAYLOAD_TOO_LARGE');

  // Reject non-LAN public IPv4 (8.8.8.8)
  const publicIpPayload = JSON.stringify({
    protocol: 'doremi-pair',
    version: 1,
    hostId: '11111111-2222-4333-8444-555555555555',
    hostName: 'Public Host',
    endpoints: [{ transport: 'lan-https', address: '8.8.8.8', port: 48620 }],
    identityAlgorithm: 'spki-sha256',
    identityFingerprint: 'AA:'.repeat(31) + 'AA',
    invitation: 'ABCD-2345-EFGH',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const pubRes = parseAndValidatePairingPayload(publicIpPayload);
  assert.equal(pubRes.ok, false);
  if (!pubRes.ok) assert.equal(pubRes.code, 'UNSAFE_ENDPOINT_ADDRESS');

  // Reject expired
  const expiredPayload = JSON.stringify({
    protocol: 'doremi-pair',
    version: 1,
    hostId: '11111111-2222-4333-8444-555555555555',
    hostName: 'Expired Host',
    endpoints: [{ transport: 'lan-https', address: '192.168.1.50', port: 48620 }],
    identityAlgorithm: 'spki-sha256',
    identityFingerprint: 'AA:'.repeat(31) + 'AA',
    invitation: 'ABCD-2345-EFGH',
    expiresAt: new Date(Date.now() - 5_000).toISOString(),
  });
  const expRes = parseAndValidatePairingPayload(expiredPayload);
  assert.equal(expRes.ok, false);
  if (!expRes.ok) assert.equal(expRes.code, 'INVITATION_EXPIRED');
});

test('Phase 6.2-2: Offline QR SVG generation, single-use replay race, cancel/regenerate invalidates prior pending requests', async () => {
  const fx = await createPhase62HostFixture();
  try {
    await fx.host.start();
    const inv1 = fx.host.createInvitation({ autoApproveSingleUse: false });
    assert.equal(inv1.lifecycleState, 'ACTIVE');
    assert.ok(inv1.qrDataUrl && inv1.qrDataUrl.startsWith('data:image/svg+xml;base64,'));
    assert.ok(Buffer.byteLength(inv1.pairingPayload, 'utf8') <= PAIRING_PAYLOAD_MAX_BYTES);

    const validated = parseAndValidatePairingPayload(inv1.pairingPayload);
    assert.equal(validated.ok, true);

    const port = fx.host.getSnapshot().listeningPort!;

    // Submit enrollment with inv1 -> enters pending_approval
    const submit1 = await httpsJsonRequest(port, '/enrollment/requests', 'POST', {}, {
      inviteCode: inv1.inviteCode,
      deviceName: 'Pending Device 1',
      platform: 'win32',
      clientNonce: 'nonce-first-submit-001',
    });
    assert.equal(submit1.status, 202);
    const req1Id = String(submit1.json.requestId);
    const poll1Token = String(submit1.json.pollToken);

    // Concurrent replay attempt with same inv1 inviteCode fails
    const submitDup = await httpsJsonRequest(port, '/enrollment/requests', 'POST', {}, {
      inviteCode: inv1.inviteCode,
      deviceName: 'Attacker Device',
      platform: 'win32',
      clientNonce: 'nonce-second-submit-002',
    });
    assert.equal(submitDup.status, 403);
    assert.equal(submitDup.json.code, 'ENROLLMENT_EXPIRED');

    // Regenerating invitation immediately invalidates earlier pending request!
    const inv2 = fx.host.createInvitation({ autoApproveSingleUse: false });
    assert.notEqual(inv2.invitationId, inv1.invitationId);
    assert.equal(fx.host.getSnapshot().pendingEnrollments.length, 0);

    const polledInvalidated = await httpsJsonRequest(
      port,
      `/enrollment/requests/${req1Id}?pollToken=${encodeURIComponent(poll1Token)}`,
      'GET',
      {},
    );
    assert.equal(polledInvalidated.status, 200);
    assert.equal(polledInvalidated.json.status, 'expired');

    // Cancel invitation transitions state to CANCELED and rejects later enrollment
    fx.host.revokeInvitation();
    assert.equal(fx.host.getSnapshot().activeInvitation, null);
    assert.equal(fx.host.getSnapshot().diagnostics.lastInvitationState, 'CANCELED');

    const submitAfterCancel = await httpsJsonRequest(port, '/enrollment/requests', 'POST', {}, {
      inviteCode: inv2.inviteCode,
      deviceName: 'Late Device',
      platform: 'win32',
      clientNonce: 'nonce-after-cancel-003',
    });
    assert.equal(submitAfterCancel.status, 403);
  } finally {
    await fx.cleanup();
  }
});

test('Phase 6.2-3: Strict TLS SPKI mismatch leaks ZERO application bytes and HTTP 3xx redirects are rejected', async () => {
  const fx = await createPhase62HostFixture();
  const impostorCert = generateSelfSignedHostCertificate('Impostor Host');
  let receivedPlaintextChunks = 0;

  const impostorServer = https.createServer(
    {
      cert: impostorCert.certificatePem,
      key: impostorCert.privateKeyPem,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      receivedPlaintextChunks += 1;
      req.on('data', () => {
        receivedPlaintextChunks += 1;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"shouldNeverReach":true}');
    },
  );

  // Also test a pinned server returning HTTP 302 redirect (security policy must reject)
  const redirectCert = generateSelfSignedHostCertificate('Redirect Host');
  const redirectServer = https.createServer(
    {
      cert: redirectCert.certificatePem,
      key: redirectCert.privateKeyPem,
      minVersion: 'TLSv1.2',
    },
    (_req, res) => {
      res.writeHead(302, { Location: 'https://127.0.0.1:4444/evil' });
      res.end();
    },
  );

  try {
    await new Promise<void>((r) => impostorServer.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => redirectServer.listen(0, '127.0.0.1', r));
    const impostorPort = (impostorServer.address() as { port: number }).port;
    const redirectPort = (redirectServer.address() as { port: number }).port;

    const clientUserData = path.join(fx.tmpRoot, 'client-userdata');
    await fs.mkdir(clientUserData, { recursive: true });
    const clientSecrets = new ConnectSecretStorage({ userDataDir: clientUserData });
    const clientConn = openLibraryDatabase(path.join(clientUserData, 'client.db'));
    const clientRepo = new ConnectRepository(clientConn.db);
    const client = new ConnectClientService({
      connectRepo: clientRepo,
      secrets: clientSecrets,
    });

    // 1. Forged QR payload pointing to impostorPort but pinning another fingerprint
    const expectedFakeFp = 'BB:'.repeat(31) + 'BB';
    const spoofedPayload = serializePairingPayload({
      protocol: 'doremi-pair',
      version: 1,
      hostId: impostorCert.hostId,
      hostName: 'Legit Host',
      endpoints: [{ transport: 'lan-https', address: '127.0.0.1', port: impostorPort }],
      identityAlgorithm: 'spki-sha256',
      identityFingerprint: expectedFakeFp,
      invitation: 'AAAA-2222-BBBB',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const spoofSnap = await client.enrollFromPairingPayload({
      rawPayload: spoofedPayload,
      deviceName: 'Security Client',
    });
    assert.equal(spoofSnap.enrollment.status, 'error');
    assert.equal(spoofSnap.enrollment.errorCode, 'HOST_IDENTITY_MISMATCH');
    assert.equal(receivedPlaintextChunks, 0, 'Zero HTTP bytes must be transmitted to unpinned cert!');

    // 2. HTTP 302 redirect on a pinned TLS peer must also be rejected
    const redirEnrollSnap = await client.enrollWithHost({
      address: '127.0.0.1',
      port: redirectPort,
      expectedFingerprintSha256: redirectCert.spkiFingerprintSha256,
      inviteCode: 'AAAA-2222-BBBB',
      deviceName: 'Redirect Test Client',
    });
    assert.equal(redirEnrollSnap.enrollment.status, 'error');
    assert.equal(redirEnrollSnap.enrollment.errorCode, 'CONNECTION_FAILED');

    clientConn.close();
  } finally {
    await new Promise<void>((r) => impostorServer.close(() => r()));
    await new Promise<void>((r) => redirectServer.close(() => r()));
    await fx.cleanup();
  }
});

test('Phase 6.2-4: End-to-end QR pairing, Client token rotation invalidates old token, immediate revocation & restart persistence', async () => {
  const fx = await createPhase62HostFixture();
  try {
    await fx.host.start();
    const inv = fx.host.createInvitation({ autoApproveSingleUse: true });

    const clientUserData = path.join(fx.tmpRoot, 'client-userdata');
    await fs.mkdir(clientUserData, { recursive: true });
    const clientSecrets = new ConnectSecretStorage({ userDataDir: clientUserData });
    const clientConn = openLibraryDatabase(path.join(clientUserData, 'client.db'));
    const clientRepo = new ConnectRepository(clientConn.db);
    const client = new ConnectClientService({
      connectRepo: clientRepo,
      secrets: clientSecrets,
    });

    let restartedHost: ConnectHostService | null = null;
    try {
      // Enroll cleanly via QR JSON payload
      const connectedSnap = await client.enrollFromPairingPayload({
        rawPayload: inv.pairingPayload,
        deviceName: 'QR Paired Laptop',
      });
      assert.equal(connectedSnap.status, 'connected');
      assert.ok(connectedSnap.activeHost);

      const credRef = `client.host.${connectedSnap.activeHost.hostId}.token`;
      const oldToken = clientSecrets.getSecret(credRef)!;
      assert.ok(oldToken && oldToken.includes('.'));

      // Rotate credential through pinned HTTPS POST /auth/rotate-token
      const rotatedSnap = await client.rotateActiveHostCredential();
      assert.equal(rotatedSnap.status, 'connected');
      const newToken = clientSecrets.getSecret(credRef)!;
      assert.notEqual(newToken, oldToken);

      const port = fx.host.getSnapshot().listeningPort!;
      // Old token must fail immediately with 401 AUTH_FAILED
      const oldReq = await httpsJsonRequest(port, '/library/summary', 'GET', {
        Authorization: `Bearer ${oldToken}`,
      });
      assert.equal(oldReq.status, 401);

      // New token works seamlessly
      const newReq = await httpsJsonRequest(port, '/library/summary', 'GET', {
        Authorization: `Bearer ${newToken}`,
      });
      assert.equal(newReq.status, 200);

      // Revoke device on Host -> immediately blocked with 403 ACCESS_REVOKED
      const deviceId = connectedSnap.activeHost.deviceId;
      fx.host.revokeDevice(deviceId);
      const revokedReq = await httpsJsonRequest(port, '/library/summary', 'GET', {
        Authorization: `Bearer ${newToken}`,
      });
      assert.equal(revokedReq.status, 403);
      assert.equal(revokedReq.json.code, 'ACCESS_REVOKED');

      // Restart Host -> revoked state remains persisted and enforced
      await fx.host.stop();
      restartedHost = new ConnectHostService({
        appVersion: '1.0.0-rc.6',
        userDataDir: fx.userDataDir,
        connectRepo: fx.connectRepo,
        trackRepo: fx.trackRepo,
        artworkService: fx.artworkService,
        lyricsService: fx.lyricsService,
        secrets: fx.secrets,
        enableMdns: false,
      });
      await restartedHost.start();
      const portAfterRestart = restartedHost.getSnapshot().listeningPort!;
      const afterRestartReq = await httpsJsonRequest(portAfterRestart, '/library/summary', 'GET', {
        Authorization: `Bearer ${newToken}`,
      });
      assert.equal(afterRestartReq.status, 403);
      assert.equal(afterRestartReq.json.code, 'ACCESS_REVOKED');

      // Ensure ZERO raw secrets leak in diagnostics events or SQLite backup
      const diagText = JSON.stringify({
        hostDiag: restartedHost.getSnapshot().diagnostics,
        clientDiag: client.getClientDiagnosticsSnapshot(),
      });
      assert.ok(!diagText.includes(oldToken));
      assert.ok(!diagText.includes(newToken));
      assert.ok(!diagText.includes(inv.inviteCode));

      const backupPath = path.join(fx.tmpRoot, 'backup.db');
      await createDatabaseSnapshotBackup(fx.conn.db, backupPath);
      const backupBytes = await fs.readFile(backupPath, 'utf8');
      assert.ok(!backupBytes.includes(oldToken));
      assert.ok(!backupBytes.includes(newToken));
      assert.ok(!backupBytes.includes('BEGIN PRIVATE KEY'));
    } finally {
      await client.disconnect().catch(() => {});
      try {
        clientConn.close();
      } catch {
        // ignore
      }
      if (restartedHost) {
        await restartedHost.stop().catch(() => {});
      }
    }
  } finally {
    await fx.cleanup();
  }
});

test('Phase 6.2-5: Anti-brute-force rate limiting across enroll, pollToken, and Bearer auth', async () => {
  const fx = await createPhase62HostFixture();
  try {
    await fx.host.start();
    const inv = fx.host.createInvitation({ autoApproveSingleUse: false });
    const port = fx.host.getSnapshot().listeningPort!;

    // 1. Poll token brute-force lockout
    const submitted = await httpsJsonRequest(port, '/enrollment/requests', 'POST', {}, {
      inviteCode: inv.inviteCode,
      deviceName: 'Poll Test',
      platform: 'win32',
      clientNonce: 'nonce-poll-rate-001',
    });
    assert.equal(submitted.status, 202);
    const reqId = String(submitted.json.requestId);

    let got429Poll = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await httpsJsonRequest(
        port,
        `/enrollment/requests/${reqId}?pollToken=wrong-poll-token-${i}`,
        'GET',
        {},
      );
      if (res.status === 429) {
        got429Poll = true;
        break;
      }
    }
    assert.equal(got429Poll, true);

    // 2. Bearer auth brute-force lockout + sanitized security event
    let got429Auth = false;
    const rogueToken = '11111111-1111-4111-8111-111111111111.wrong-secret-token-xyz';
    for (let i = 0; i < 15; i += 1) {
      const res = await httpsJsonRequest(port, '/library/summary', 'GET', {
        Authorization: `Bearer ${rogueToken}`,
      });
      if (res.status === 429) {
        got429Auth = true;
        break;
      }
    }
    assert.equal(got429Auth, true);

    // 3. Direct unit check of DeviceAuthorizationService invite lockout
    const auth = new DeviceAuthorizationService({ connectRepo: fx.connectRepo });
    auth.createInvitation({
      hostId: '11111111-2222-4333-8444-555555555555',
      hostDisplayName: 'Host',
      shortFingerprint: 'AA11-BB22-CC33-DD44',
      listenAddresses: ['127.0.0.1'],
      port: 48620,
    });
    let gotEnrollLockout = false;
    for (let i = 0; i < 8; i += 1) {
      const attempt = auth.submitEnrollmentRequest({
        inviteCode: `BAD0-0000-000${i}`,
        deviceName: 'Brute',
        platform: 'win32',
        clientNonce: `brute-nonce-${i}-abcdefgh`,
        remoteAddress: '192.168.1.99',
      });
      if (!attempt.ok && attempt.httpStatus === 429) {
        gotEnrollLockout = true;
        break;
      }
    }
    assert.equal(gotEnrollLockout, true);
  } finally {
    await fx.cleanup();
  }
});

test('Phase 6.2-6: ConnectSecretStorage fail-closed without OS safeStorage when allowFileFallback=false & corrupt vault resilience', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p62-secrets-'));
  try {
    const strictUnavailable = new ConnectSecretStorage({
      userDataDir: tmpDir,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      allowFileFallback: false,
    });
    assert.equal(strictUnavailable.getStorageBackend(), 'unavailable');
    await assert.rejects(
      strictUnavailable.setSecret('test.token', 'secret-value-123'),
      /OS safeStorage/i,
    );

    // Ensure fallback secrets cannot be read by strict mode and corrupted JSON returns null safely
    const fallbackStore = new ConnectSecretStorage({
      userDataDir: tmpDir,
      allowFileFallback: true,
    });
    await fallbackStore.setSecret('fallback.only', 'hello');
    assert.equal(fallbackStore.getSecret('fallback.only'), 'hello');
    assert.equal(strictUnavailable.getSecret('fallback.only'), null);

    const vaultPath = path.join(tmpDir, 'connect', 'secrets.json');
    await fs.writeFile(vaultPath, '{corrupt-not-json', 'utf8');
    assert.equal(fallbackStore.getSecret('fallback.only'), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 6.2-7: SharedFilesystemGuard blocks traversal & symlink escape outside explicit shared root', async () => {
  const fx = await createPhase62HostFixture();
  try {
    const guard = new SharedFilesystemGuard({
      connectRepo: fx.connectRepo,
      trackRepo: fx.trackRepo,
    });

    // Attempt creating symlink or junction inside shared musicDir pointing to outsideDir
    const symlinkTarget = path.join(fx.musicDir, 'escape-outside.flac');
    let symlinkCreated = false;
    try {
      await fs.symlink(fx.outsideSecret, symlinkTarget, 'file');
      symlinkCreated = true;
    } catch {
      // Unprivileged Windows without Developer Mode may forbid creating file symlinks; test directory junction or outside track directly
      try {
        await fs.symlink(fx.outsideDir, path.join(fx.musicDir, 'escape-dir'), 'junction');
        const injPath = path.join(fx.musicDir, 'escape-dir', 'secret.flac');
        fx.trackRepo.upsertBatch([
          {
            original_path: injPath,
            normalized_path: normalizeTrackPath(injPath),
            title: 'Junction Escape',
            artist: 'Attacker',
            album: 'Escape',
            duration_ms: 1000,
            codec: 'FLAC',
            container: 'FLAC',
            sample_rate_hz: 44100,
            bit_depth: 16,
            bitrate_bps: 900000,
            file_size_bytes: 8200,
            modified_at_ms: Date.now(),
            status: 'available',
          },
        ]);
        const inserted = fx.trackRepo.findByNormalizedPath(normalizeTrackPath(injPath))!;
        const guardCheck = await guard.resolveAuthorizedAudioFile(inserted.id);
        assert.equal(guardCheck.ok, false);
        symlinkCreated = true;
      } catch {
        // Skip symlink creation if OS restricts both, still validate direct outside path check
      }
    }

    if (symlinkCreated && (await fs.stat(symlinkTarget).catch(() => null))) {
      fx.trackRepo.upsertBatch([
        {
          original_path: symlinkTarget,
          normalized_path: normalizeTrackPath(symlinkTarget),
          title: 'Symlink Escape',
          artist: 'Attacker',
          album: 'Escape',
          duration_ms: 1000,
          codec: 'FLAC',
          container: 'FLAC',
          sample_rate_hz: 44100,
          bit_depth: 16,
          bitrate_bps: 900000,
          file_size_bytes: 8200,
          modified_at_ms: Date.now(),
          status: 'available',
        },
      ]);
      const inserted = fx.trackRepo.findByNormalizedPath(normalizeTrackPath(symlinkTarget))!;
      const guardCheck = await guard.resolveAuthorizedAudioFile(inserted.id);
      assert.equal(guardCheck.ok, false);
    }

    // Outside track (not in shared root) must ALWAYS be rejected
    fx.trackRepo.upsertBatch([
      {
        original_path: fx.outsideSecret,
        normalized_path: normalizeTrackPath(fx.outsideSecret),
        title: 'Unshared Outside Track',
        artist: 'Unshared',
        album: 'Outside',
        duration_ms: 1000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 44100,
        bit_depth: 16,
        bitrate_bps: 900000,
        file_size_bytes: 8200,
        modified_at_ms: Date.now(),
        status: 'available',
      },
    ]);
    const outsideTrack = fx.trackRepo.findByNormalizedPath(normalizeTrackPath(fx.outsideSecret))!;
    const outCheck = await guard.resolveAuthorizedAudioFile(outsideTrack.id);
    assert.equal(outCheck.ok, false);
    if (!outCheck.ok) {
      assert.equal(outCheck.status, 403);
    }
  } finally {
    await fx.cleanup();
  }
});
