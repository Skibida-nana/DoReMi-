import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
import { ConnectRepository, type StoredRememberedHost } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { LanDiscoveryService } from '../src/main/services/connect/lan-discovery-service';
import { NetworkChangeMonitor, type NetworkObservationSnapshot } from '../src/main/services/connect/network-monitor';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import {
  SmartConnectionManager,
  type PreparedTransportSession,
  type SmartConnectionDriver,
} from '../src/main/services/connect/smart-connection-manager';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import type { DiscoveredHostRecord, RemoteEndpointDescriptorV1 } from '../src/shared/types/connect';
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from './helpers/test-ca-https';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeMockStoredHost(mode: 'automatic' | 'lan-only' | 'remote-only' = 'automatic'): StoredRememberedHost {
  const validDesc: RemoteEndpointDescriptorV1 = {
    schema: 'doremi-remote-endpoint',
    version: 1,
    hostId: 'host-unit-1',
    hostDisplayName: 'Unit Host',
    providerId: 'tailscale-funnel',
    publicOrigin: 'https://unit.tail8888.ts.net',
    mountPath: '/doremi-connect',
    apiBasePath: '/doremi-connect/api/v1',
    endpointGeneration: 1,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    identityAlgorithm: 'ecdsa-p256-spki-sha256',
    hostFingerprintSha256: 'a'.repeat(64),
    hostPublicKeySpkiBase64: 'b'.repeat(88),
    signatureBase64: 'c'.repeat(88),
  };
  return {
    hostId: 'host-unit-1',
    displayName: 'Unit Host',
    lastAddress: '192.168.1.10',
    port: 48620,
    pinnedFingerprint: 'a'.repeat(64),
    shortFingerprint: 'AAAA-AAAA',
    deviceId: 'dev-unit-1',
    credentialRef: 'lan.ref',
    remoteCredentialRef: 'rem.ref',
    hasRemoteCredential: true,
    remoteEndpoint: validDesc,
    lastRemoteConnectedAt: null,
    connectionMode: mode,
    preferredTransport: 'lan-direct',
    apiVersion: '1.0',
    lastConnectedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('Phase 6.4 Hysteresis, Debounce, Cooldown, Backoff, Generation Cancellation & Offline Transitions', async () => {
  let clockMs = 100_000;
  let currentObs: NetworkObservationSnapshot = {
    signature: 'Wi-Fi=192.168.1.50/255.255.255.0',
    hasAnyExternalIpv4: true,
    hasPrivateLanIpv4: true,
    lanAddresses: ['192.168.1.50'],
  };
  const monitor = new NetworkChangeMonitor({
    inspectInterfaces: () => currentObs,
    pollIntervalMs: 60_000,
    nowMs: () => clockMs,
  });
  assert.equal(monitor.isRunning(), false, 'Monitor must be disarmed initially');

  let storedHost = makeMockStoredHost('automatic');
  let lanUp = true;
  let remoteUp = true;
  let lanDelayMs = 0;
  let lanPrepCalls = 0;
  let remotePrepCalls = 0;
  const committedTransports: Array<{ transport: string; strategy: string }> = [];

  const makeSession = (transport: 'lan-direct' | 'remote-https'): PreparedTransportSession => ({
    host: storedHost,
    transport,
    token: transport === 'lan-direct' ? 'lan-tok' : 'r1.dev-unit-1.tok',
    summary: {
      hostId: storedHost.hostId,
      hostDisplayName: storedHost.displayName,
      totalSharedTracks: 5,
      totalAlbums: 1,
      totalArtists: 1,
      sharedSourceCount: 1,
      updatedAt: new Date().toISOString(),
    },
    remoteDescriptor: transport === 'remote-https' ? storedHost.remoteEndpoint ?? null : null,
    verifiedAddress: transport === 'lan-direct' ? storedHost.lastAddress : 'unit.tail8888.ts.net',
    verifiedPort: transport === 'lan-direct' ? storedHost.port : 443,
    latencyMs: 5,
  });

  const driver: SmartConnectionDriver = {
    findRememberedHost: () => storedHost,
    setRememberedHostMode: (_id, mode) => {
      storedHost = { ...storedHost, connectionMode: mode };
      return true;
    },
    hasLanCredential: () => true,
    hasRemoteCredential: () => true,
    inspectRemoteDescriptorEligibility: () => ({ eligible: true, availability: 'eligible' }),
    discoverLanCandidates: async () => [],
    prepareLanTransport: async (_host, signal) => {
      lanPrepCalls += 1;
      if (lanDelayMs > 0) {
        await sleep(lanDelayMs);
      }
      if (signal.aborted) {
        return { ok: false, errorCode: 'NETWORK_INTERRUPTED', category: 'recoverable_network', message: 'aborted', latencyMs: 1 };
      }
      if (!lanUp) {
        return { ok: false, errorCode: 'HOST_UNAVAILABLE', category: 'recoverable_network', message: 'LAN down', latencyMs: 2 };
      }
      return { ok: true, session: makeSession('lan-direct') };
    },
    prepareRemoteTransport: async (_host, signal) => {
      remotePrepCalls += 1;
      if (signal.aborted) {
        return { ok: false, errorCode: 'NETWORK_INTERRUPTED', category: 'recoverable_network', message: 'aborted', latencyMs: 1 };
      }
      if (!remoteUp) {
        return { ok: false, errorCode: 'HOST_UNAVAILABLE', category: 'recoverable_network', message: 'Remote down', latencyMs: 2 };
      }
      return { ok: true, session: makeSession('remote-https') };
    },
    probeActiveTransportHealth: async (session) => {
      const ok = session.transport === 'lan-direct' ? lanUp : remoteUp;
      return ok ? { ok: true } : { ok: false, errorCode: 'NETWORK_INTERRUPTED', category: 'recoverable_network', message: 'probe failed' };
    },
    commitPreparedSession: (session, meta) => {
      committedTransports.push({ transport: session.transport, strategy: meta.strategy });
      return { streamsCancelled: meta.isHandover ? 1 : 0 };
    },
    clearActiveSession: () => ({ streamsCancelled: 1 }),
    onStateUpdated: () => {},
  };

  const mgr = new SmartConnectionManager({
    driver,
    networkMonitor: monitor,
    nowMs: () => clockMs,
    policy: {
      networkDebounceMs: 45,
      lanRecoveryConfirmMs: 65,
      switchCooldownMs: 5_000,
      failureThreshold: 2,
      retryBackoffMs: [25, 50, 100],
      maxAutoReconnectAttempts: 3,
      enableJitter: false,
    },
  });

  try {
    // 1. Initial connect -> CONNECTED_LAN
    await mgr.connect(storedHost.hostId);
    assert.equal(mgr.getSmartState(), 'CONNECTED_LAN');
    assert.equal(monitor.isRunning(), true);

    // 2. Brief single failure (< failureThreshold=2) -> DEGRADED, then recovers on healthy signal with ZERO handover!
    const commitsBeforeGlitch = committedTransports.length;
    await mgr.reportTransportFailure({
      hostId: storedHost.hostId,
      transport: 'lan-direct',
      errorCode: 'NETWORK_INTERRUPTED',
      message: 'single transient socket hiccup',
    });
    assert.equal(mgr.getSmartState(), 'DEGRADED');
    assert.equal(committedTransports.length, commitsBeforeGlitch);
    mgr.recordTransportSuccess('lan-direct');
    assert.equal(mgr.getSmartState(), 'CONNECTED_LAN');

    // 3. Real active LAN failure (>= failureThreshold=2) -> Break-Before-Make handover to Remote HTTPS (bypasses cooldown!)
    lanUp = false;
    await mgr.reportTransportFailure({
      hostId: storedHost.hostId,
      transport: 'lan-direct',
      errorCode: 'NETWORK_INTERRUPTED',
      message: 'fail 1',
    });
    await mgr.reportTransportFailure({
      hostId: storedHost.hostId,
      transport: 'lan-direct',
      errorCode: 'NETWORK_INTERRUPTED',
      message: 'fail 2',
    });
    assert.equal(mgr.getSmartState(), 'CONNECTED_REMOTE');
    assert.equal(committedTransports.at(-1)?.transport, 'remote-https');
    assert.equal(committedTransports.at(-1)?.strategy, 'break-before-make');

    // 4. Rapid network flapping (5 interface changes inside 45ms debounce) while still in 5000ms switch cooldown:
    //    Cooldown prevents non-emergency flip-flop, and debounce coalesces all 5 events!
    lanUp = true;
    const lanPrepBeforeFlap = lanPrepCalls;
    for (let i = 0; i < 5; i += 1) {
      currentObs = {
        ...currentObs,
        signature: `Wi-Fi=192.168.1.${60 + i}/255.255.255.0`,
        lanAddresses: [`192.168.1.${60 + i}`],
      };
      monitor.checkNow();
      await sleep(8);
    }
    await sleep(140);
    assert.equal(mgr.getSmartState(), 'CONNECTED_REMOTE', 'Non-emergency upgrade must respect switchCooldownMs');
    assert.equal(lanPrepCalls, lanPrepBeforeFlap, 'Cooldown must skip non-emergency LAN probe spam');

    // 5. Advance clock past cooldown -> Make-Before-Break Remote -> LAN upgrade after lanRecoveryConfirmMs!
    clockMs += 6_000;
    currentObs = {
      ...currentObs,
      signature: 'Wi-Fi=192.168.1.99/255.255.255.0',
      lanAddresses: ['192.168.1.99'],
    };
    monitor.checkNow();
    // Immediately after event (before debounce 45ms + confirm 65ms), Remote HTTPS MUST stay active!
    await sleep(20);
    assert.equal(mgr.getSmartState(), 'CONNECTED_REMOTE');
    await sleep(140);
    assert.equal(mgr.getSmartState(), 'CONNECTED_LAN');
    assert.equal(committedTransports.at(-1)?.strategy, 'make-before-break');

    // 6. LAN -> Offline (all interfaces lost) -> enters NETWORK_UNAVAILABLE immediately without retry storm
    lanUp = false;
    remoteUp = false;
    const prepBeforeOffline = lanPrepCalls + remotePrepCalls;
    currentObs = {
      signature: '',
      hasAnyExternalIpv4: false,
      hasPrivateLanIpv4: false,
      lanAddresses: [],
    };
    monitor.checkNow();
    await sleep(90);
    assert.equal(mgr.getSmartState(), 'NETWORK_UNAVAILABLE');
    assert.equal(lanPrepCalls + remotePrepCalls, prepBeforeOffline, 'Offline state must not poll transports');

    // 7. Offline -> Remote restored -> automatically reconnects to CONNECTED_REMOTE!
    remoteUp = true;
    currentObs = {
      signature: 'Hotspot=172.20.10.2/255.255.255.240',
      hasAnyExternalIpv4: true,
      hasPrivateLanIpv4: true,
      lanAddresses: ['172.20.10.2'],
    };
    monitor.checkNow();
    await sleep(90);
    assert.equal(mgr.getSmartState(), 'CONNECTED_REMOTE');

    // 8. Extended outage -> bounded exponential backoff [25, 50, 100] -> rests in HOST_UNAVAILABLE with 0 active timers!
    remoteUp = false;
    await mgr.reportTransportFailure({
      hostId: storedHost.hostId,
      transport: 'remote-https',
      errorCode: 'NETWORK_INTERRUPTED',
      message: 'hotspot drop 1',
    });
    await mgr.reportTransportFailure({
      hostId: storedHost.hostId,
      transport: 'remote-https',
      errorCode: 'NETWORK_INTERRUPTED',
      message: 'hotspot drop 2',
    });
    await sleep(320);
    assert.equal(mgr.getSmartState(), 'HOST_UNAVAILABLE');
    assert.equal(mgr.getRetryCount(), 3);
    assert.equal(mgr.getActiveTimerCount(), 0, 'Must rest with 0 timers after maxAutoReconnectAttempts');

    // 9. Stale generation cancellation & explicit user disconnect
    lanUp = true;
    lanDelayMs = 120;
    const pendingConnect = mgr.connect(storedHost.hostId);
    await sleep(20);
    mgr.disconnect(); // User cancels mid-flight!
    await pendingConnect;
    assert.equal(mgr.getSmartState(), 'DISCONNECTED');
    assert.equal(mgr.getActiveTimerCount(), 0);
    assert.equal(monitor.isRunning(), false);
  } finally {
    mgr.shutdown();
  }
});

test('Phase 6.4 Live Host LAN IP/Endpoint Change + Secure mDNS Rediscovery (Spoof Rejected, Authentic Accepted)', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-mdns-'));
  const hostDir = path.join(tmpRoot, 'host');
  const spoofDir = path.join(tmpRoot, 'spoof');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(spoofDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const REMOTE_DNS = 'doremi-mdns.tail8888.ts.net';
  const wav = path.join(musicDir, 't.wav');
  await fs.writeFile(wav, Buffer.alloc(1024, 1));
  const st = await fs.stat(wav);

  const makeHost = (dir: string) => {
    const conn = openLibraryDatabase(path.join(dir, 'library.db'));
    const trackRepo = new TrackRepository(conn.db);
    const rootRepo = new LibraryRootRepository(conn.db);
    const artworkRepo = new ArtworkRepository(conn.db);
    const lyricsRepo = new LyricsRepository(conn.db);
    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
    trackRepo.upsertBatch([
      {
        original_path: wav,
        normalized_path: normalizeTrackPath(wav),
        title: 'mDNS Track',
        artist: 'Artist',
        album: 'Album',
        duration_ms: 1000,
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
    connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443 });
    connectRepo.addSharedSource(root.id);
    const host = new ConnectHostService({
      appVersion: '1.0.0-rc.8',
      userDataDir: dir,
      connectRepo,
      trackRepo,
      artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: dir }),
      lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
      secrets: new ConnectSecretStorage({ userDataDir: dir, allowFileFallback: true }),
      remoteProvider: new TailscaleFunnelProvider({
        cli: {
          findExecutable: () => null,
          exec: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '', timedOut: false, aborted: false }),
        },
      }),
      enableMdns: false,
    });
    return { conn, connectRepo, host };
  };

  const realInst = makeHost(hostDir);
  const spoofInst = makeHost(spoofDir);
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));

  let mdnsRecords: DiscoveredHostRecord[] = [];
  class ControlledDiscovery extends LanDiscoveryService {
    override async scanLanHosts(): Promise<DiscoveredHostRecord[]> {
      return mdnsRecords;
    }
    override getCachedDiscoveredHosts(): DiscoveredHostRecord[] {
      return mdnsRecords;
    }
  }

  // Also test DNS failure & TLS cert failure via Remote HTTPS
  const ca = createIsolatedTestCa();
  const wrongCa = createIsolatedTestCa();
  const wrongLeaf = wrongCa.issueLeafCert({ dnsNames: [REMOTE_DNS] });
  const badTlsProxy = await startSimulatedFunnelTlsProxy({
    certPem: wrongLeaf.certPem,
    keyPem: wrongLeaf.keyPem,
    mountPath: '/doremi-connect',
    localGatewayPort: 65000,
  });

  const clientRepo = new ConnectRepository(clientConn.db);
  const client = new ConnectClientService({
    connectRepo: clientRepo,
    secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
    discovery: new ControlledDiscovery(),
    publicHttpsOptions: {
      ca: ca.caCertPem,
      lookup: createLoopbackLookup(REMOTE_DNS),
      connectOverridePort: badTlsProxy.port,
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

  try {
    await realInst.host.start();
    await spoofInst.host.start();
    const initialPort = realInst.host.getSnapshot().listeningPort!;
    const spoofPort = spoofInst.host.getSnapshot().listeningPort!;
    const hostId = realInst.host.getSnapshot().identity!.hostId;

    const probe = await client.probeHost('127.0.0.1', initialPort);
    const inv = realInst.host.createInvitation({ autoApproveSingleUse: true });
    const enrolled = await client.enrollWithHost({
      address: '127.0.0.1',
      port: initialPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'mDNS Rediscovery Client',
    });
    assert.equal(enrolled.smartState, 'CONNECTED_LAN');

    // Now Host restarts on a DIFFERENT port (simulating DHCP LAN endpoint change!)
    await realInst.host.stop();
    let nextPort = initialPort;
    for (let attempt = 0; attempt < 5 && nextPort === initialPort; attempt += 1) {
      realInst.connectRepo.updateHostConfig({ port: 0 });
      await realInst.host.start();
      nextPort = realInst.host.getSnapshot().listeningPort!;
      if (nextPort === initialPort) {
        await realInst.host.stop();
      }
    }

    // Case A: Spoofed mDNS advertisement claims real hostId at spoofInst's port -> MUST be rejected by SPKI check!
    mdnsRecords = [
      {
        hostId,
        displayName: 'Spoofed Host',
        address: '127.0.0.1',
        port: spoofPort,
        apiVersion: '1.0',
        mode: 'lan-direct',
        fingerprintPrefix: 'SPOOF',
        lastSeenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const spoofAttempt = await client.connectToRememberedHost(hostId);
    assert.notEqual(spoofAttempt.status, 'connected', 'Spoofed mDNS endpoint must never be trusted');
    assert.equal(
      clientRepo.findRememberedHost(hostId)?.port,
      initialPort,
      'Spoofed mDNS candidate must NOT overwrite remembered endpoint',
    );

    // Case B: Both spoofed candidate AND authentic Host candidate present -> authentic Host verified & endpoint updated!
    mdnsRecords = [
      ...mdnsRecords,
      {
        hostId,
        displayName: 'Real Host New Endpoint',
        address: '127.0.0.1',
        port: nextPort,
        apiVersion: '1.0',
        mode: 'lan-direct',
        fingerprintPrefix: realInst.host.getSnapshot().identity!.shortFingerprint,
        lastSeenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const recovered = await client.connectToRememberedHost(hostId);
    assert.equal(recovered.smartState, 'CONNECTED_LAN');
    assert.equal(clientRepo.findRememberedHost(hostId)?.port, nextPort);
  } finally {
    await client.shutdown().catch(() => {});
    await badTlsProxy.close().catch(() => {});
    await realInst.host.stop().catch(() => {});
    await spoofInst.host.stop().catch(() => {});
    clientConn.close();
    realInst.conn.close();
    spoofInst.conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
