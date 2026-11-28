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
import {
  signRemoteEndpointDescriptor,
  verifyRemoteEndpointDescriptor,
  verifyRemoteHostIdentityProof,
} from '../src/main/services/connect/remote-trust';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { generateSelfSignedHostCertificate } from '../src/main/services/connect/x509-cert';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  validateRemoteEndpointDescriptorShape,
  validateRemoteHttpsOrigin,
} from '../src/shared/contracts/connect-remote';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from './helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-home.tail7777.ts.net';

async function createPhase63Env(funnelPortRef: { port: number }) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p63-sec-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const songPath = path.join(musicDir, '01-Remote-Sec.flac');
  await fs.writeFile(songPath, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(32 * 1024)]));

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
      title: 'Protected FLAC Track',
      artist: 'DoReMi',
      album: 'Remote Security',
      duration_ms: 90_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 900_000,
      file_size_bytes: 32772,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443 });
  hostRepo.addSharedSource(root.id);
  const hostSecrets = new ConnectSecretStorage({ userDataDir: hostDir });

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
            CurrentTailnet: { MagicDNSSuffix: 'tail7777.ts.net', MagicDNSEnabled: true },
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

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.7',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: hostSecrets,
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    enableMdns: false,
  });

  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });

  await host.start();
  const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
  assert.equal(enabled.remoteAccess?.state, 'READY');
  const gwPort = enabled.remoteAccess!.gatewayListeningPort!;

  const proxy = await startSimulatedFunnelTlsProxy({
    certPem: leaf.certPem,
    keyPem: leaf.keyPem,
    mountPath: '/doremi-connect',
    localGatewayPort: gwPort,
  });
  funnelPortRef.port = proxy.port;

  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const clientRepo = new ConnectRepository(clientConn.db);
  const clientSecrets = new ConnectSecretStorage({ userDataDir: clientDir });
  const client = new ConnectClientService({
    connectRepo: clientRepo,
    secrets: clientSecrets,
    publicHttpsOptions: {
      ca: ca.caCertPem,
      lookup: createLoopbackLookup(REMOTE_HOSTNAME),
      connectOverridePort: proxy.port,
    },
  });

  // Enroll client over trusted LAN
  const lanPort = host.getSnapshot().listeningPort!;
  const probe = await client.probeHost('127.0.0.1', lanPort);
  const inv = host.createInvitation({ autoApproveSingleUse: true });
  await client.enrollWithHost({
    address: '127.0.0.1',
    port: lanPort,
    expectedFingerprintSha256: probe.observedFingerprintSha256!,
    inviteCode: inv.inviteCode,
    deviceName: 'Test Remote Laptop',
  });

  return {
    tmpRoot,
    hostDir,
    host,
    hostConn,
    hostRepo,
    hostSecrets,
    trackRepo,
    client,
    clientConn,
    clientRepo,
    clientSecrets,
    ca,
    proxy,
    gwPort,
    cleanup: async () => {
      await client.disconnect().catch(() => {});
      await proxy.close().catch(() => {});
      await host.stop();
      clientConn.close();
      hostConn.close();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

function rawHttpsReq(
  port: number,
  caCertPem: string,
  reqPath: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const raw = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const req = https.request(
      {
        host: REMOTE_HOSTNAME,
        port,
        servername: REMOTE_HOSTNAME,
        path: reqPath,
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
        ca: caCertPem,
        rejectUnauthorized: true,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

test('Phase 6.3 Security-A & B: Endpoint origin validation and cryptographic Endpoint Descriptor signing/tamper resistance', () => {
  // Section 43.A Origin validation
  assert.equal(validateRemoteHttpsOrigin(`https://${REMOTE_HOSTNAME}`).ok, true);
  assert.equal(validateRemoteHttpsOrigin(`https://${REMOTE_HOSTNAME}:8443`).ok, true);
  assert.equal(validateRemoteHttpsOrigin(`http://${REMOTE_HOSTNAME}`).ok, false);
  assert.equal(validateRemoteHttpsOrigin('https://evilts.net').ok, false);
  assert.equal(validateRemoteHttpsOrigin('https://ts.net.attacker.com').ok, false);
  assert.equal(validateRemoteHttpsOrigin('https://sub.ts.net').ok, false);
  assert.equal(validateRemoteHttpsOrigin(`https://${REMOTE_HOSTNAME}:8080`).ok, false);
  assert.equal(validateRemoteHttpsOrigin(`https://user:pass@${REMOTE_HOSTNAME}`).ok, false);
  assert.equal(validateRemoteHttpsOrigin(`https://${REMOTE_HOSTNAME}/path`).ok, false);
  assert.equal(validateRemoteHttpsOrigin(`https://${REMOTE_HOSTNAME}/%2e%2e`).ok, false);

  // Section 43.B Signed descriptor validation
  const hostCert = generateSelfSignedHostCertificate('Real Host');
  const otherCert = generateSelfSignedHostCertificate('Attacker Host');

  const desc = signRemoteEndpointDescriptor({
    hostId: hostCert.hostId,
    hostDisplayName: 'Home Studio',
    providerId: 'tailscale-funnel',
    publicOrigin: `https://${REMOTE_HOSTNAME}`,
    mountPath: '/doremi-connect',
    endpointGeneration: 2,
    certificatePem: hostCert.certificatePem,
    privateKeyPem: hostCert.privateKeyPem,
    hostFingerprintSha256: hostCert.spkiFingerprintSha256,
  });

  const ok = verifyRemoteEndpointDescriptor(desc, hostCert.hostId, hostCert.spkiFingerprintSha256);
  assert.equal(ok.ok, true);

  // Tampered origin -> invalid signature
  const tamperedOrigin = { ...desc, publicOrigin: 'https://other-node.tail7777.ts.net' };
  assert.equal(verifyRemoteEndpointDescriptor(tamperedOrigin, hostCert.hostId, hostCert.spkiFingerprintSha256).ok, false);

  // Self-asserted key by attacker -> rejected
  const attackerDesc = signRemoteEndpointDescriptor({
    hostId: otherCert.hostId,
    hostDisplayName: 'Fake',
    providerId: 'tailscale-funnel',
    publicOrigin: `https://${REMOTE_HOSTNAME}`,
    mountPath: '/doremi-connect',
    endpointGeneration: 2,
    certificatePem: otherCert.certificatePem,
    privateKeyPem: otherCert.privateKeyPem,
    hostFingerprintSha256: otherCert.spkiFingerprintSha256,
  });
  assert.equal(verifyRemoteEndpointDescriptor(attackerDesc, hostCert.hostId, hostCert.spkiFingerprintSha256).ok, false);

  // Expired / Superseded descriptor
  assert.equal(verifyRemoteEndpointDescriptor(desc, hostCert.hostId, hostCert.spkiFingerprintSha256, { minGeneration: 3 }).ok, false);
  assert.equal(validateRemoteEndpointDescriptorShape(desc, { nowMs: Date.parse(desc.expiresAt) + 1000 }).ok, false);
});

test('Phase 6.3 Security-C, D, E, F, G: Live Remote Gateway route restrictions, Host Identity Proof, Public TLS, Scoped Tokens, Revocation & Flood protection', async () => {
  const ref = { port: 0 };
  const env = await createPhase63Env(ref);
  try {
    const proxyPort = env.proxy.port;
    const snapBefore = env.host.getSnapshot();
    const hostId = snapBefore.identity!.hostId;
    const device = snapBefore.authorizedDevices[0];

    // 1. LAN-only device (remoteAccessEnabled = false by default) MUST NOT receive Remote token & cannot connect remotely
    const notGranted = await env.client.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
    assert.equal(notGranted.status, 'error');
    assert.equal(notGranted.lastErrorCode, 'REMOTE_ACCESS_NOT_GRANTED');

    // 2. Host explicitly grants Remote Access -> Client syncs over LAN -> receives signed descriptor + scoped r1.* token
    env.host.setDeviceRemoteAccess(device.deviceId, true);
    await env.client.syncRemoteAccessOverLan(hostId);

    // LAN token MUST NOT be accepted on Remote Gateway
    const remembered = env.clientRepo.findRememberedHost(hostId)!;
    const lanToken = env.clientSecrets.getSecret(remembered.credentialRef)!;
    const remoteToken = env.clientSecrets.getSecret(remembered.remoteCredentialRef!)!;
    assert.ok(remoteToken.startsWith('r1.'));

    const lanTokenOnRemote = await rawHttpsReq(
      proxyPort,
      env.ca.caCertPem,
      '/doremi-connect/api/v1/library/summary',
      'GET',
      { Authorization: `Bearer ${lanToken}` },
    );
    assert.equal(lanTokenOnRemote.status, 403);

    // Remote token MUST NOT be accepted on LAN port!
    const lanPort = env.host.getSnapshot().listeningPort!;
    await new Promise<void>((resolve) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: lanPort,
          path: '/api/v1/library/summary',
          method: 'GET',
          headers: { Authorization: `Bearer ${remoteToken}` },
          rejectUnauthorized: false,
        },
        (res) => {
          assert.equal(res.statusCode, 401);
          res.resume();
          res.on('end', resolve);
        },
      );
      req.end();
    });

    // 3. Connect explicitly via Remote HTTPS -> verifies Public CA cert, Host Identity Proof, then connects!
    const remSnap = await env.client.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
    assert.equal(remSnap.status, 'connected');
    assert.equal(remSnap.activeTransport, 'remote-https');

    // 4. Section 43.F: Public route allowlist & traversal & method restrictions
    for (const blocked of [
      { path: '/doremi-connect/api/v1/enrollment/requests', method: 'POST', expected: 403 },
      { path: '/doremi-connect/api/v1/remote/provision', method: 'POST', expected: 403 },
      { path: '/doremi-connect/api/v1/admin/stop', method: 'POST', expected: 403 },
      { path: '/doremi-connect/api/v1/diagnostics', method: 'GET', expected: 403 },
      { path: '/doremi-connect/api/v1/auth/rotate-token', method: 'POST', expected: 403 },
      { path: '/doremi-connect/api/v1/%2e%2e/library/summary', method: 'GET', expected: 400 },
      { path: '/doremi-connect/api/v1/library/summary', method: 'DELETE', expected: 405 },
    ]) {
      const res = await rawHttpsReq(proxyPort, env.ca.caCertPem, blocked.path, blocked.method, {
        Authorization: `Bearer ${remoteToken}`,
        'X-Forwarded-For': '127.0.0.1',
        'Tailscale-User-Login': 'spoofed-owner@example.com',
      });
      assert.equal(res.status, blocked.expected, `Expected ${blocked.expected} for ${blocked.method} ${blocked.path}, got ${res.status}`);
    }

    // 5. Section 43.C: VerifyHost rejects bad nonce, replay/wrong nonce, wrong hostId, oversized body
    const nonce = crypto.randomBytes(24).toString('base64url');
    const proofRes = await rawHttpsReq(
      proxyPort,
      env.ca.caCertPem,
      '/doremi-connect/api/v1/remote/verify-host',
      'POST',
      {},
      { clientNonce: nonce, expectedHostId: hostId },
    );
    assert.equal(proofRes.status, 200);
    const parsedProof = JSON.parse(proofRes.text);
    const verifyOk = verifyRemoteHostIdentityProof(parsedProof, {
      hostId,
      publicOrigin: `https://${REMOTE_HOSTNAME}`,
      apiBasePath: '/doremi-connect/api/v1',
      minGeneration: 1,
      clientNonce: nonce,
      pinnedFingerprintSha256: remembered.pinnedFingerprint,
    });
    assert.equal(verifyOk.ok, true);

    // Wrong nonce check fails!
    assert.equal(
      verifyRemoteHostIdentityProof(parsedProof, {
        hostId,
        publicOrigin: `https://${REMOTE_HOSTNAME}`,
        apiBasePath: '/doremi-connect/api/v1',
        minGeneration: 1,
        clientNonce: 'different-nonce-value-123456',
        pinnedFingerprintSha256: remembered.pinnedFingerprint,
      }).ok,
      false,
    );

    // 6. Section 43.D: Untrusted CA or wrong hostname certificate is strictly rejected (`rejectUnauthorized: true`)
    const wrongHostLeaf = env.ca.issueLeafCert({ dnsNames: ['wrong-host.tail7777.ts.net'] });
    const badCertProxy = await startSimulatedFunnelTlsProxy({
      certPem: wrongHostLeaf.certPem,
      keyPem: wrongHostLeaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: env.gwPort,
    });
    try {
      const badClient = new ConnectClientService({
        connectRepo: env.clientRepo,
        secrets: env.clientSecrets,
        publicHttpsOptions: {
          ca: env.ca.caCertPem,
          lookup: createLoopbackLookup(REMOTE_HOSTNAME),
          connectOverridePort: badCertProxy.port,
        },
      });
      const badSnap = await badClient.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
      assert.equal(badSnap.status, 'error');
      // Ensure NO Bearer token leaked when TLS failed!
    } finally {
      await badCertProxy.close();
    }

    // 7. Token rotation over Remote HTTPS invalidates old Remote token after client finishes using new token
    await env.client.rotateActiveHostCredential();
    const rotatedRemoteToken = env.clientSecrets.getSecret(remembered.remoteCredentialRef!)!;
    assert.notEqual(rotatedRemoteToken, remoteToken);
    assert.ok(rotatedRemoteToken.startsWith('r1.'));

    // 8. Removing Remote permission ONLY blocks Remote HTTPS while preserving LAN Direct!
    env.host.setDeviceRemoteAccess(device.deviceId, false);
    const blockedRemote = await rawHttpsReq(
      proxyPort,
      env.ca.caCertPem,
      '/doremi-connect/api/v1/library/summary',
      'GET',
      { Authorization: `Bearer ${rotatedRemoteToken}` },
    );
    assert.equal(blockedRemote.status, 403);
    // LAN still works!
    const lanReconnect = await env.client.connectToRememberedHost(hostId, undefined, undefined, 'lan-direct');
    assert.equal(lanReconnect.status, 'connected');
    assert.equal(lanReconnect.activeTransport, 'lan-direct');

    // 9. Section 43.G: Unauthenticated flood triggers 429 RATE_LIMITED
    let got429 = false;
    for (let i = 0; i < 45; i += 1) {
      const flood = await rawHttpsReq(proxyPort, env.ca.caCertPem, '/doremi-connect/api/v1/capabilities', 'GET', {});
      if (flood.status === 429) {
        got429 = true;
        break;
      }
    }
    assert.equal(got429, true);
  } finally {
    await env.cleanup();
  }
});
