import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
} from './helpers/test-ca-https';

const REMOTE_HOST_A = 'doremi-alpha.tail8888.ts.net';
const REMOTE_HOST_B = 'doremi-bravo.tail8888.ts.net';

function createTinyWav(): Buffer {
  const sr = 44100;
  const frames = 4410; // 100ms
  const dataSize = frames * 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function createMockFunnelCli(dnsName: string) {
  let routeTarget = '';
  return {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      if (args[0] === 'version') {
        return {
          ok: true,
          exitCode: 0,
          stdout: '{"majorMinorPatch":"1.78.1"}',
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
              DNSName: `${dnsName}.`,
              Capabilities: ['https://tailscale.com/cap/funnel'],
            },
            CurrentTailnet: { MagicDNSSuffix: 'tail8888.ts.net', MagicDNSEnabled: true },
            CertDomains: [dnsName],
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
                  [`${dnsName}:443`]: {
                    Handlers: { '/doremi-connect': { Proxy: routeTarget } },
                  },
                },
                AllowFunnel: { [`${dnsName}:443`]: true },
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

async function startCountingTlsProxy(options: {
  certPem: string;
  keyPem: string;
  mountPath: string;
  getGatewayPort: () => number | null;
  interceptVerifyHost?: () => object | null;
}) {
  let requestCount = 0;
  let authHeaderCount = 0;
  let enabled = true;

  const server = https.createServer(
    { cert: options.certPem, key: options.keyPem, minVersion: 'TLSv1.2' },
    (req, res) => {
      requestCount += 1;
      if (req.headers.authorization) {
        authHeaderCount += 1;
      }
      if (!enabled) {
        req.socket.destroy();
        return;
      }
      const urlPath = req.url || '/';
      if (!urlPath.startsWith(options.mountPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND' }));
        return;
      }
      if (options.interceptVerifyHost && urlPath.endsWith('/remote/verify-host')) {
        const fake = options.interceptVerifyHost();
        if (fake) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fake));
          return;
        }
      }
      const gwPort = options.getGatewayPort();
      if (!gwPort) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'BAD_GATEWAY' }));
        return;
      }
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders.host;
      const up = http.request(
        {
          host: '127.0.0.1',
          port: gwPort,
          path: urlPath,
          method: req.method,
          headers: fwdHeaders,
          agent: false,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'BAD_GATEWAY' }));
        }
      });
      req.pipe(up);
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    getRequestCount: () => requestCount,
    getAuthHeaderCount: () => authHeaderCount,
    resetCounts: () => {
      requestCount = 0;
      authHeaderCount = 0;
    },
    setEnabled: (val: boolean) => {
      enabled = val;
      if (!val) {
        server.closeAllConnections?.();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('Phase 6.4 Smart Connection Selection Matrix (20 Scenarios): Automatic, LAN Only, Remote Only, Auth/Security Eligibility, Persistence & Multi-Host Isolation', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-select-'));
  const hostADir = path.join(tmpRoot, 'host-a');
  const hostBDir = path.join(tmpRoot, 'host-b');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostADir, { recursive: true }),
    fs.mkdir(hostBDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const wavPath = path.join(musicDir, 'selection-track.wav');
  await fs.writeFile(wavPath, createTinyWav());
  const st = await fs.stat(wavPath);

  const setupHostInstance = (dir: string, dnsName: string, displayName: string) => {
    const conn = openLibraryDatabase(path.join(dir, 'library.db'));
    const trackRepo = new TrackRepository(conn.db);
    const rootRepo = new LibraryRootRepository(conn.db);
    const artworkRepo = new ArtworkRepository(conn.db);
    const lyricsRepo = new LyricsRepository(conn.db);
    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
    trackRepo.upsertBatch([
      {
        original_path: wavPath,
        normalized_path: normalizeTrackPath(wavPath),
        title: `Track-${dnsName}`,
        artist: 'DoReMi QA',
        album: 'Phase 6.4',
        duration_ms: 100,
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
    const connectRepo = new ConnectRepository(conn.db);
    connectRepo.updateHostConfig({
      displayName,
      bindAddress: '127.0.0.1',
      port: 0,
      remotePublicPort: 443,
    });
    connectRepo.addSharedSource(root.id);
    const host = new ConnectHostService({
      appVersion: '1.0.0-rc.8',
      userDataDir: dir,
      connectRepo,
      trackRepo,
      artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: dir }),
      lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
      secrets: new ConnectSecretStorage({ userDataDir: dir, allowFileFallback: true }),
      remoteProvider: new TailscaleFunnelProvider({ cli: createMockFunnelCli(dnsName) }),
      enableMdns: false,
    });
    return { conn, trackRepo, connectRepo, host };
  };

  const ca = createIsolatedTestCa();
  const leafA = ca.issueLeafCert({ dnsNames: [REMOTE_HOST_A] });
  const leafB = ca.issueLeafCert({ dnsNames: [REMOTE_HOST_B] });

  // Both Hosts intentionally share the SAME displayName to verify strict hostId separation (Scenario 20)
  const instA = setupHostInstance(hostADir, REMOTE_HOST_A, 'Living Room Lossless Host');
  const instB = setupHostInstance(hostBDir, REMOTE_HOST_B, 'Living Room Lossless Host');

  let forgeVerifyHostProof = false;
  const proxyA = await startCountingTlsProxy({
    certPem: leafA.certPem,
    keyPem: leafA.keyPem,
    mountPath: '/doremi-connect',
    getGatewayPort: () => instA.host.getSnapshot().remoteAccess?.gatewayListeningPort ?? null,
    interceptVerifyHost: () =>
      forgeVerifyHostProof
        ? {
            schema: 'doremi-remote-host-proof',
            version: 1,
            hostId: instA.host.getSnapshot().identity!.hostId,
            publicOrigin: `https://${REMOTE_HOST_A}`,
            apiBasePath: '/doremi-connect/api/v1',
            endpointGeneration: 1,
            clientNonce: 'tampered',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            hostPublicKeySpkiBase64: Buffer.alloc(65, 7).toString('base64'),
            signatureBase64: Buffer.alloc(64, 9).toString('base64'),
          }
        : null,
  });
  const proxyB = await startCountingTlsProxy({
    certPem: leafB.certPem,
    keyPem: leafB.keyPem,
    mountPath: '/doremi-connect',
    getGatewayPort: () => instB.host.getSnapshot().remoteAccess?.gatewayListeningPort ?? null,
  });

  const clientDbPath = path.join(clientDir, 'library.db');
  let clientConn = openLibraryDatabase(clientDbPath);
  const fastPolicy = {
    networkDebounceMs: 25,
    lanRecoveryConfirmMs: 40,
    switchCooldownMs: 60,
    failureThreshold: 1,
    retryBackoffMs: [20, 40],
    maxAutoReconnectAttempts: 0,
    enableJitter: false,
  };

  const makeClient = (conn: ReturnType<typeof openLibraryDatabase>, remotePort: number, remoteDns: string) =>
    new ConnectClientService({
      connectRepo: new ConnectRepository(conn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(remoteDns),
        connectOverridePort: remotePort,
      },
      smartPolicy: fastPolicy,
    });

  let client = makeClient(clientConn, proxyA.port, REMOTE_HOST_A);

  try {
    await instA.host.start();
    await instB.host.start();
    const snapA = await instA.host.enableRemoteAccess({
      confirmPublicExposure: true,
      preferredPublicPort: 443,
    });
    assert.equal(snapA.remoteAccess?.state, 'READY');
    const hostIdA = snapA.identity!.hostId;
    const lanPortA = snapA.listeningPort!;
    const trackIdA = instA.trackRepo.findAll()[0].id;

    // Pair with Host A (Scenario 9: LAN-only authorized device initially)
    const probeA = await client.probeHost('127.0.0.1', lanPortA);
    const invA = instA.host.createInvitation({ autoApproveSingleUse: true });
    const enrolledA = await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPortA,
      expectedFingerprintSha256: probeA.observedFingerprintSha256!,
      inviteCode: invA.inviteCode,
      deviceName: 'Phase 6.4 Laptop',
    });
    assert.equal(enrolledA.status, 'connected');
    assert.equal(enrolledA.selectedMode, 'automatic');
    assert.equal(enrolledA.smartState, 'CONNECTED_LAN');
    assert.equal(enrolledA.activeTransport, 'lan-direct');

    // Scenario 9 & 10: Remote Access NOT yet granted on Host -> Remote Only reports AUTHORIZATION_REQUIRED, Automatic uses LAN
    await client.syncRemoteAccessOverLan(hostIdA);
    const remDeniedSnap = await client.setConnectionMode(hostIdA, 'remote-only');
    assert.equal(remDeniedSnap.smartState, 'AUTHORIZATION_REQUIRED');
    assert.equal(remDeniedSnap.failureCategory, 'authorization');

    const backAutoLanOnlyAuth = await client.setConnectionMode(hostIdA, 'automatic');
    assert.equal(backAutoLanOnlyAuth.smartState, 'CONNECTED_LAN');
    assert.equal(backAutoLanOnlyAuth.activeTransport, 'lan-direct');

    // Now grant Remote Access on Host A and sync over trusted LAN
    const devIdA = instA.host.getSnapshot().authorizedDevices[0].deviceId;
    instA.host.setDeviceRemoteAccess(devIdA, true);
    await client.syncRemoteAccessOverLan(hostIdA);

    // Scenario 1: Automatic mode, BOTH LAN & Remote available -> MUST prefer LAN Direct and send 0 stream bytes over Remote proxy!
    proxyA.resetCounts();
    const s1 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s1.smartState, 'CONNECTED_LAN');
    assert.equal(s1.activeTransport, 'lan-direct');
    assert.equal(s1.alternativeTransportAvailable, 'remote-https');
    const streamLanResp = await client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostIdA, trackIdA)),
    );
    assert.equal(streamLanResp.status, 200);
    await streamLanResp.arrayBuffer();
    assert.equal(proxyA.getRequestCount(), 0, 'Scenario 1: Stream on LAN Direct must NOT touch Remote HTTPS proxy');

    // Scenario 3: Automatic mode, LAN available, Remote unavailable -> selects LAN Direct cleanly
    proxyA.setEnabled(false);
    const s3 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s3.smartState, 'CONNECTED_LAN');
    assert.equal(s3.activeTransport, 'lan-direct');
    proxyA.setEnabled(true);

    // Scenario 7: Remote Only mode, Remote available & LAN available -> selects Remote HTTPS and NEVER uses LAN
    proxyA.resetCounts();
    const s7 = await client.setConnectionMode(hostIdA, 'remote-only');
    assert.equal(s7.smartState, 'CONNECTED_REMOTE');
    assert.equal(s7.activeTransport, 'remote-https');
    const streamRemResp = await client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostIdA, trackIdA)),
    );
    assert.equal(streamRemResp.status, 200);
    await streamRemResp.arrayBuffer();
    assert.ok(proxyA.getRequestCount() >= 2, 'Scenario 7: Remote Only must route through Remote HTTPS');

    // Scenario 8: Remote Only mode, Remote unavailable while LAN IS available -> fails cleanly & NEVER falls back to LAN!
    proxyA.setEnabled(false);
    const s8 = await client.connectToRememberedHost(hostIdA);
    assert.notEqual(s8.status, 'connected');
    assert.equal(s8.activeTransport, null);
    assert.equal(s8.smartState, 'HOST_UNAVAILABLE');
    proxyA.setEnabled(true);

    // Scenario 5: LAN Only mode, LAN available -> connects LAN Direct
    const s5 = await client.setConnectionMode(hostIdA, 'lan-only');
    assert.equal(s5.smartState, 'CONNECTED_LAN');
    assert.equal(s5.activeTransport, 'lan-direct');

    // Scenario 6: LAN Only mode, LAN unavailable while Remote IS available -> fails cleanly & NEVER uses Remote HTTPS!
    // Simulate wrong unreachable LAN port while keeping Remote Gateway alive
    const clientRepo1 = new ConnectRepository(clientConn.db);
    const origPortA = lanPortA;
    clientRepo1.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', 65431);
    proxyA.resetCounts();
    const s6 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s6.smartState, 'HOST_UNAVAILABLE');
    assert.equal(s6.activeTransport, null);
    assert.equal(proxyA.getRequestCount(), 0, 'Scenario 6: LAN Only must send 0 requests to Remote HTTPS');

    // Scenario 2: Automatic mode, LAN unavailable, Remote available -> automatically selects Remote HTTPS!
    const s2 = await client.setConnectionMode(hostIdA, 'automatic');
    assert.equal(s2.smartState, 'CONNECTED_REMOTE');
    assert.equal(s2.activeTransport, 'remote-https');

    // Scenario 4: Automatic mode, NEITHER LAN nor Remote available -> enters HOST_UNAVAILABLE
    proxyA.setEnabled(false);
    const s4 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s4.smartState, 'HOST_UNAVAILABLE');
    assert.equal(s4.activeTransport, null);

    // Restore LAN & Remote
    proxyA.setEnabled(true);
    clientRepo1.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', origPortA);

    // Scenario 18: User changes mode while connected (Automatic LAN -> Remote Only -> LAN Only -> Automatic)
    const s18a = await client.connectToRememberedHost(hostIdA);
    assert.equal(s18a.smartState, 'CONNECTED_LAN');
    const s18b = await client.setConnectionMode(hostIdA, 'remote-only');
    assert.equal(s18b.smartState, 'CONNECTED_REMOTE');
    assert.equal(s18b.activeTransport, 'remote-https');
    const s18c = await client.setConnectionMode(hostIdA, 'lan-only');
    assert.equal(s18c.smartState, 'CONNECTED_LAN');
    assert.equal(s18c.activeTransport, 'lan-direct');
    const s18d = await client.setConnectionMode(hostIdA, 'automatic');
    assert.equal(s18d.smartState, 'CONNECTED_LAN');

    // Scenario 17: Mode persistence across app restart AND legacy RC.7 preferred_transport compatibility
    await client.setConnectionMode(hostIdA, 'remote-only');
    await client.shutdown();
    clientConn.close();

    clientConn = openLibraryDatabase(clientDbPath);
    const reopenedRepo = new ConnectRepository(clientConn.db);
    assert.equal(reopenedRepo.findRememberedHost(hostIdA)?.connectionMode, 'remote-only');
    // Simulate legacy Phase 6.3 DB row ('lan-direct' & 'remote-https')
    clientConn.db
      .prepare('UPDATE connect_remembered_hosts SET preferred_transport = ? WHERE host_id = ?')
      .run('lan-direct', hostIdA);
    assert.equal(reopenedRepo.findRememberedHost(hostIdA)?.connectionMode, 'lan-only');
    clientConn.db
      .prepare('UPDATE connect_remembered_hosts SET preferred_transport = ? WHERE host_id = ?')
      .run('automatic', hostIdA);
    assert.equal(reopenedRepo.findRememberedHost(hostIdA)?.connectionMode, 'automatic');

    client = makeClient(clientConn, proxyA.port, REMOTE_HOST_A);

    // Scenario 15: Expired Remote Endpoint Descriptor -> REMOTE_ENDPOINT_EXPIRED (never connects over expired Remote, Automatic still uses LAN!)
    const savedRowBeforeTamper = reopenedRepo.findRememberedHost(hostIdA)!;
    const validDesc = savedRowBeforeTamper.remoteEndpoint!;
    // Build a descriptor with past expiresAt (will fail shape/expiry check before network call)
    const expiredDesc = {
      ...validDesc,
      issuedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    reopenedRepo.saveRememberedHostRemoteAssociation({
      hostId: hostIdA,
      descriptor: expiredDesc,
      remoteCredentialRef: savedRowBeforeTamper.remoteCredentialRef,
    });
    await client.setConnectionMode(hostIdA, 'remote-only');
    proxyA.resetCounts();
    const s15RemoteOnly = await client.connectToRememberedHost(hostIdA);
    assert.equal(s15RemoteOnly.smartState, 'AUTHORIZATION_REQUIRED');
    assert.equal(s15RemoteOnly.lastErrorCode, 'REMOTE_ENDPOINT_EXPIRED');
    assert.equal(proxyA.getRequestCount(), 0, 'Expired descriptor must be blocked before network request');

    // In Automatic mode with valid LAN, LAN still connects!
    const s15Auto = await client.setConnectionMode(hostIdA, 'automatic');
    assert.equal(s15Auto.smartState, 'CONNECTED_LAN');
    // Re-sync fresh descriptor over LAN
    await client.syncRemoteAccessOverLan(hostIdA);

    // Scenario 16: Unexpected / tampered Remote origin -> SECURITY_BLOCKED (0 credentials sent)
    const freshRow = reopenedRepo.findRememberedHost(hostIdA)!;
    const forgedTsNetDesc = {
      ...freshRow.remoteEndpoint!,
      publicOrigin: 'https://evil-spoof.tail8888.ts.net',
      endpointGeneration: 99,
    };
    reopenedRepo.saveRememberedHostRemoteAssociation({
      hostId: hostIdA,
      descriptor: forgedTsNetDesc,
      remoteCredentialRef: freshRow.remoteCredentialRef,
    });
    const s16 = await client.setConnectionMode(hostIdA, 'remote-only');
    assert.equal(s16.smartState, 'SECURITY_BLOCKED');
    assert.equal(s16.failureCategory, 'security');

    // Restore valid descriptor
    reopenedRepo.saveRememberedHostRemoteAssociation({
      hostId: hostIdA,
      descriptor: freshRow.remoteEndpoint ?? null,
      remoteCredentialRef: freshRow.remoteCredentialRef,
    });

    // Scenario 14: Invalid Remote Host identity proof -> SECURITY_BLOCKED & 0 bearer tokens sent!
    forgeVerifyHostProof = true;
    proxyA.resetCounts();
    const s14 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s14.smartState, 'SECURITY_BLOCKED');
    assert.equal(s14.lastErrorCode, 'HOST_IDENTITY_MISMATCH');
    assert.equal(
      proxyA.getAuthHeaderCount(),
      0,
      'Scenario 14: Client MUST NOT transmit Remote token when Host identity proof fails',
    );
    forgeVerifyHostProof = false;

    // Scenario 11: Remote permission revoked on Host -> blocks Remote, preserves LAN in Automatic!
    instA.host.setDeviceRemoteAccess(devIdA, false);
    reopenedRepo.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', 65431); // LAN temporarily unreachable
    const s11a = await client.setConnectionMode(hostIdA, 'automatic');
    assert.notEqual(s11a.status, 'connected');
    // Restore LAN -> Automatic uses LAN even though Remote permission was revoked!
    reopenedRepo.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', origPortA);
    const s11b = await client.connectToRememberedHost(hostIdA);
    assert.equal(s11b.smartState, 'CONNECTED_LAN');
    assert.equal(s11b.activeTransport, 'lan-direct');

    // Scenario 19 & 20: Enroll second Host B with IDENTICAL displayName -> isolated hostId, mode, and pinned identity!
    const snapB = await instB.host.enableRemoteAccess({
      confirmPublicExposure: true,
      preferredPublicPort: 443,
    });
    const hostIdB = snapB.identity!.hostId;
    const lanPortB = snapB.listeningPort!;
    assert.notEqual(hostIdA, hostIdB);

    await client.shutdown();
    client = makeClient(clientConn, proxyB.port, REMOTE_HOST_B);
    const probeB = await client.probeHost('127.0.0.1', lanPortB);
    const invB = instB.host.createInvitation({ autoApproveSingleUse: true });
    const enrolledB = await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPortB,
      expectedFingerprintSha256: probeB.observedFingerprintSha256!,
      inviteCode: invB.inviteCode,
      deviceName: 'Phase 6.4 Laptop',
    });
    assert.equal(enrolledB.status, 'connected');
    assert.equal(enrolledB.activeHost?.hostId, hostIdB);
    assert.equal(enrolledB.rememberedHosts.length, 2, 'Two Hosts with identical displayName must never merge');

    // Switch back to Host A cleanly
    const switchedA = await client.connectToRememberedHost(hostIdA);
    assert.equal(switchedA.activeHost?.hostId, hostIdA);
    assert.equal(switchedA.smartState, 'CONNECTED_LAN');

    // Scenario 13: Invalid LAN SPKI fingerprint (point Host A's LAN port at Host B's TLS listener!) -> SECURITY_BLOCKED
    reopenedRepo.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', lanPortB);
    await client.setConnectionMode(hostIdA, 'lan-only');
    const s13 = await client.connectToRememberedHost(hostIdA);
    assert.equal(s13.smartState, 'SECURITY_BLOCKED');
    assert.equal(s13.lastErrorCode, 'HOST_IDENTITY_MISMATCH');
    assert.equal(s13.failureCategory, 'security');

    // Restore Host A LAN port and test Scenario 12: Full device revocation blocks BOTH LAN and Remote!
    reopenedRepo.touchRememberedHostEndpoint(hostIdA, '127.0.0.1', origPortA);
    instA.host.setDeviceRemoteAccess(devIdA, true);
    instA.host.revokeDevice(devIdA);
    const s12 = await client.setConnectionMode(hostIdA, 'automatic');
    assert.equal(s12.smartState, 'ACCESS_REVOKED');
    assert.equal(s12.lastErrorCode, 'ACCESS_REVOKED');
    assert.equal(s12.failureCategory, 'authorization');
    assert.equal(client.smartManager.getRetryCount(), 0, 'Revoked device must not enter retry loop');
  } finally {
    await client.shutdown().catch(() => {});
    await proxyA.close().catch(() => {});
    await proxyB.close().catch(() => {});
    await instA.host.stop().catch(() => {});
    await instB.host.stop().catch(() => {});
    clientConn.close();
    instA.conn.close();
    instB.conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
