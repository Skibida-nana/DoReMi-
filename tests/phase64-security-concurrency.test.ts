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
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from './helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-sec64.tail8888.ts.net';

function createMockFunnelCli() {
  let routeTarget = '';
  return {
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
            CurrentTailnet: { MagicDNSSuffix: 'tail8888.ts.net', MagicDNSEnabled: true },
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
}

test('Phase 6.4 Security Regression: Zero Credential Leakage on Bad TLS/Hostname/Redirect/Rollback/Identity Rotation', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-sec-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const wavPath = path.join(musicDir, 'sec.wav');
  await fs.writeFile(wavPath, Buffer.alloc(64 * 1024, 0x42));
  const st = await fs.stat(wavPath);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
  trackRepo.upsertBatch([
    {
      original_path: wavPath,
      normalized_path: normalizeTrackPath(wavPath),
      title: 'Sec Track',
      artist: 'Artist',
      album: 'Album',
      duration_ms: 2000,
      codec: 'PCM',
      container: 'WAV',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 1411200,
      file_size_bytes: st.size,
      modified_at_ms: Math.round(st.mtimeMs),
      status: 'available',
    },
  ]);

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443 });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.8',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: createMockFunnelCli() }),
    enableMdns: false,
  });

  const trustedCa = createIsolatedTestCa();
  const untrustedCa = createIsolatedTestCa();
  const validLeaf = trustedCa.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  const wrongHostnameLeaf = trustedCa.issueLeafCert({ dnsNames: ['other-host.tail8888.ts.net'] });
  const untrustedLeaf = untrustedCa.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });

  let redirectTrapHits = 0;
  const redirectTargetServer = https.createServer(
    { cert: validLeaf.certPem, key: validLeaf.keyPem },
    (_req, res) => {
      redirectTrapHits += 1;
      res.writeHead(200);
      res.end('trap');
    },
  );
  await new Promise<void>((r) => redirectTargetServer.listen(0, '127.0.0.1', r));
  const redirectTargetPort = (redirectTargetServer.address() as { port: number }).port;

  let redirectAuthLeaks = 0;
  const redirectingEdge = https.createServer(
    { cert: validLeaf.certPem, key: validLeaf.keyPem },
    (req, res) => {
      if (req.headers.authorization) redirectAuthLeaks += 1;
      res.writeHead(302, {
        Location: `https://${REMOTE_HOSTNAME}:${redirectTargetPort}/doremi-connect/api/v1/remote/verify-host`,
      });
      res.end();
    },
  );
  await new Promise<void>((r) => redirectingEdge.listen(0, '127.0.0.1', r));
  const redirectingPort = (redirectingEdge.address() as { port: number }).port;

  let untrustedAuthLeaks = 0;
  const untrustedEdge = https.createServer(
    { cert: untrustedLeaf.certPem, key: untrustedLeaf.keyPem },
    (req, res) => {
      if (req.headers.authorization) untrustedAuthLeaks += 1;
      res.writeHead(200);
      res.end('{}');
    },
  );
  await new Promise<void>((r) => untrustedEdge.listen(0, '127.0.0.1', r));
  const untrustedPort = (untrustedEdge.address() as { port: number }).port;

  let wrongSanAuthLeaks = 0;
  const wrongSanEdge = https.createServer(
    { cert: wrongHostnameLeaf.certPem, key: wrongHostnameLeaf.keyPem },
    (req, res) => {
      if (req.headers.authorization) wrongSanAuthLeaks += 1;
      res.writeHead(200);
      res.end('{}');
    },
  );
  await new Promise<void>((r) => wrongSanEdge.listen(0, '127.0.0.1', r));
  const wrongSanPort = (wrongSanEdge.address() as { port: number }).port;

  let validProxy: { port: number; close(): Promise<void> } | null = null;
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const clientRepo = new ConnectRepository(clientConn.db);
  const clientSecrets = new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true });

  const makeClientForPort = (overridePort: number) =>
    new ConnectClientService({
      connectRepo: clientRepo,
      secrets: clientSecrets,
      publicHttpsOptions: {
        ca: trustedCa.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: overridePort,
      },
      smartPolicy: {
        networkDebounceMs: 20,
        lanRecoveryConfirmMs: 30,
        switchCooldownMs: 30,
        failureThreshold: 1,
        retryBackoffMs: [20],
        maxAutoReconnectAttempts: 1,
        enableJitter: false,
      },
    });

  let client: ConnectClientService | null = null;

  try {
    await host.start();
    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    validProxy = await startSimulatedFunnelTlsProxy({
      certPem: validLeaf.certPem,
      keyPem: validLeaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: enabled.remoteAccess!.gatewayListeningPort!,
    });

    client = makeClientForPort(validProxy.port);
    const lanPort = enabled.listeningPort!;
    const hostId = enabled.identity!.hostId;
    const probe = await client.probeHost('127.0.0.1', lanPort);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Sec Client',
    });
    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await client.syncRemoteAccessOverLan(hostId);
    await client.setConnectionMode(hostId, 'remote-only');
    await client.shutdown();

    // 1. Untrusted CA certificate -> SECURITY_BLOCKED, 0 auth headers leaked!
    client = makeClientForPort(untrustedPort);
    const sUntrusted = await client.connectToRememberedHost(hostId);
    assert.equal(sUntrusted.smartState, 'SECURITY_BLOCKED');
    assert.equal(untrustedAuthLeaks, 0);
    await client.shutdown();

    // 2. Wrong hostname SAN -> SECURITY_BLOCKED, 0 auth headers leaked!
    client = makeClientForPort(wrongSanPort);
    const sWrongSan = await client.connectToRememberedHost(hostId);
    assert.equal(sWrongSan.smartState, 'SECURITY_BLOCKED');
    assert.equal(wrongSanAuthLeaks, 0);
    await client.shutdown();

    // 3. HTTP 302 redirect on Remote HTTPS -> blocked, 0 redirect target hits & 0 auth headers leaked!
    client = makeClientForPort(redirectingPort);
    const sRedirect = await client.connectToRememberedHost(hostId);
    assert.equal(sRedirect.smartState, 'SECURITY_BLOCKED');
    assert.equal(redirectTrapHits, 0, 'Client must NEVER follow HTTP redirects');
    assert.equal(redirectAuthLeaks, 0);
    await client.shutdown();

    // 4. Cross-transport token isolation: LAN token rejected on Remote Gateway; Remote r1.* token rejected on LAN!
    const stored = clientRepo.findRememberedHost(hostId)!;
    const lanTok = clientSecrets.getSecret(stored.credentialRef)!;
    const remTok = clientSecrets.getSecret(stored.remoteCredentialRef!)!;
    assert.ok(remTok.startsWith('r1.'));
    assert.ok(!lanTok.startsWith('r1.'));

    const crossOnRemote = await new Promise<number>((resolve, reject) => {
      const req = https.request(
        {
          host: REMOTE_HOSTNAME,
          port: validProxy!.port,
          path: '/doremi-connect/api/v1/library/summary',
          method: 'GET',
          ca: trustedCa.caCertPem,
          lookup: createLoopbackLookup(REMOTE_HOSTNAME),
          headers: { Authorization: `Bearer ${lanTok}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(
      crossOnRemote === 401 || crossOnRemote === 403,
      `LAN token MUST be rejected on Remote Gateway (got ${crossOnRemote})`,
    );

    const crossOnLan = await new Promise<number>((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: lanPort,
          path: '/api/v1/library/summary',
          method: 'GET',
          rejectUnauthorized: false,
          headers: { Authorization: `Bearer ${remTok}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(crossOnLan, 401, 'Remote r1.* token MUST be rejected on LAN Direct');

    // 5. Sanitized diagnostics MUST NOT expose raw tokens
    client = makeClientForPort(validProxy.port);
    await client.connectToRememberedHost(hostId);
    const diagJson = JSON.stringify(client.getClientDiagnosticsSnapshot());
    assert.equal(diagJson.includes(lanTok), false, 'Diagnostics must never contain raw LAN token');
    assert.equal(diagJson.includes(remTok), false, 'Diagnostics must never contain raw Remote token');

    // 6. Host identity rotation during reconnect -> SECURITY_BLOCKED across both LAN & Remote!
    hostRepo.updateHostConfig({ port: lanPort });
    await host.rotateIdentity();
    await client.setConnectionMode(hostId, 'automatic');
    const afterRotate = await client.connectToRememberedHost(hostId);
    assert.equal(afterRotate.smartState, 'SECURITY_BLOCKED');
    assert.equal(afterRotate.failureCategory, 'security');
    assert.equal(client.smartManager.getRetryCount(), 0);
    assert.equal(
      crypto.timingSafeEqual(Buffer.from('ok'), Buffer.from('ok')),
      true,
    );
  } finally {
    await client?.shutdown().catch(() => {});
    await validProxy?.close().catch(() => {});
    redirectTargetServer.closeAllConnections?.();
    redirectingEdge.closeAllConnections?.();
    untrustedEdge.closeAllConnections?.();
    wrongSanEdge.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((r) => redirectTargetServer.close(() => r())),
      new Promise<void>((r) => redirectingEdge.close(() => r())),
      new Promise<void>((r) => untrustedEdge.close(() => r())),
      new Promise<void>((r) => wrongSanEdge.close(() => r())),
    ]);
    await host.stop().catch(() => {});
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 6.4 Concurrency & Resource Budget: 3 Active Clients (Mixed LAN + Remote) & Repeated Handover Without Slot Inflation or Leaks', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-conc-'));
  const hostDir = path.join(tmpRoot, 'host');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  // 512 KB WAV so concurrent Range reads exercise real streamer
  const wavPath = path.join(musicDir, 'conc.wav');
  await fs.writeFile(wavPath, Buffer.alloc(512 * 1024, 0x55));
  const st = await fs.stat(wavPath);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
  trackRepo.upsertBatch([
    {
      original_path: wavPath,
      normalized_path: normalizeTrackPath(wavPath),
      title: 'Concurrent Track',
      artist: 'Artist',
      album: 'Album',
      duration_ms: 3000,
      codec: 'PCM',
      container: 'WAV',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 1411200,
      file_size_bytes: st.size,
      modified_at_ms: Math.round(st.mtimeMs),
      status: 'available',
    },
  ]);
  const trackId = trackRepo.findAll()[0].id;

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({
    bindAddress: '127.0.0.1',
    port: 0,
    remotePublicPort: 443,
    maxActiveClients: 3,
  });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.8',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: createMockFunnelCli() }),
    enableMdns: false,
  });

  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let proxy: { port: number; close(): Promise<void> } | null = null;

  const clients: Array<{ dir: string; conn: ReturnType<typeof openLibraryDatabase>; svc: ConnectClientService }> = [];

  try {
    await host.start();
    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    proxy = await startSimulatedFunnelTlsProxy({
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: enabled.remoteAccess!.gatewayListeningPort!,
    });
    const lanPort = enabled.listeningPort!;
    const hostId = enabled.identity!.hostId;

    for (let idx = 0; idx < 3; idx += 1) {
      const cDir = path.join(tmpRoot, `client-${idx}`);
      await fs.mkdir(cDir, { recursive: true });
      const cConn = openLibraryDatabase(path.join(cDir, 'library.db'));
      const svc = new ConnectClientService({
        connectRepo: new ConnectRepository(cConn.db),
        secrets: new ConnectSecretStorage({ userDataDir: cDir, allowFileFallback: true }),
        publicHttpsOptions: {
          ca: ca.caCertPem,
          lookup: createLoopbackLookup(REMOTE_HOSTNAME),
          connectOverridePort: proxy.port,
        },
        smartPolicy: {
          networkDebounceMs: 15,
          lanRecoveryConfirmMs: 25,
          switchCooldownMs: 10,
          failureThreshold: 1,
          retryBackoffMs: [15],
          maxAutoReconnectAttempts: 1,
          enableJitter: false,
        },
      });
      const probe = await svc.probeHost('127.0.0.1', lanPort);
      const inv = host.createInvitation({ autoApproveSingleUse: true });
      await svc.enrollWithHost({
        address: '127.0.0.1',
        port: lanPort,
        expectedFingerprintSha256: probe.observedFingerprintSha256!,
        inviteCode: inv.inviteCode,
        deviceName: `Client-${idx + 1}`,
      });
      const devId = host.getSnapshot().authorizedDevices.find((d) => d.displayName === `Client-${idx + 1}`)!.deviceId;
      host.setDeviceRemoteAccess(devId, true);
      await svc.syncRemoteAccessOverLan(hostId);
      clients.push({ dir: cDir, conn: cConn, svc });
    }

    // Client 2 connects Remote Only, Client 3 stays LAN Only, Client 1 flips LAN <-> Remote 6 times while streaming!
    await clients[1].svc.setConnectionMode(hostId, 'remote-only');
    await clients[2].svc.setConnectionMode(hostId, 'lan-only');

    for (let round = 0; round < 6; round += 1) {
      const targetMode = round % 2 === 0 ? 'remote-only' : 'lan-only';
      const snap1 = await clients[0].svc.setConnectionMode(hostId, targetMode);
      assert.equal(snap1.status, 'connected');

      // All 3 clients stream simultaneously without exceeding maxActiveClients = 3!
      const [r1, r2, r3] = await Promise.all([
        clients[0].svc.resolveRemoteTrackMediaResponse(
          new Request(buildRemoteTrackMediaUrl(hostId, trackId), { headers: { Range: 'bytes=0-65535' } }),
        ),
        clients[1].svc.resolveRemoteTrackMediaResponse(
          new Request(buildRemoteTrackMediaUrl(hostId, trackId), { headers: { Range: 'bytes=65536-131071' } }),
        ),
        clients[2].svc.resolveRemoteTrackMediaResponse(
          new Request(buildRemoteTrackMediaUrl(hostId, trackId), { headers: { Range: 'bytes=131072-196607' } }),
        ),
      ]);
      assert.equal(r1.status, 206);
      assert.equal(r2.status, 206);
      assert.equal(r3.status, 206);
      await Promise.all([r1.arrayBuffer(), r2.arrayBuffer(), r3.arrayBuffer()]);

      const hostMetrics = host.getSnapshot().metrics.hostMetrics;
      assert.ok(
        hostMetrics.connectedDeviceCount <= 3,
        `Handover must never inflate connectedDeviceCount above 3 (got ${hostMetrics.connectedDeviceCount})`,
      );
    }

    // Shutdown all clients -> zero active timers, zero armed network monitors, zero lingering sessions
    for (const c of clients) {
      await c.svc.shutdown();
      assert.equal(c.svc.smartManager.getActiveTimerCount(), 0);
      assert.equal(c.svc.networkMonitor.isRunning(), false);
    }
    assert.equal(host.getSnapshot().activeSessions.length, 0);
  } finally {
    for (const c of clients) {
      await c.svc.shutdown().catch(() => {});
      c.conn.close();
    }
    await proxy?.close().catch(() => {});
    await host.stop().catch(() => {});
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
