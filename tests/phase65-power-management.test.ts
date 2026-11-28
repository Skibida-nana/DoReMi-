import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import {
  HostPowerManager,
  type PowerPlatformAdapter,
} from '../src/main/services/connect/host-power-manager';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createMockPowerAdapter(initialOnBattery: boolean | null = false) {
  let nextId = 500;
  const active = new Map<number, 'prevent-app-suspension'>();
  const foreignActive = new Set<number>([9999]);
  let onBattery: boolean | null = initialOnBattery;
  let startCount = 0;
  let stopCount = 0;
  let handlers: {
    onSuspend: () => void;
    onResume: () => void;
    onAc: () => void;
    onBattery: () => void;
  } | null = null;

  const adapter: PowerPlatformAdapter = {
    startBlocker(type) {
      assert.equal(
        type,
        'prevent-app-suspension',
        'HostPowerManager must use prevent-app-suspension so display can turn off normally',
      );
      nextId += 1;
      startCount += 1;
      active.set(nextId, type);
      return nextId;
    },
    stopBlocker(id) {
      assert.equal(
        foreignActive.has(id),
        false,
        'HostPowerManager must never stop blockers owned by unrelated components',
      );
      if (active.has(id)) {
        stopCount += 1;
        active.delete(id);
      }
    },
    isBlockerStarted(id) {
      return active.has(id) || foreignActive.has(id);
    },
    isOnBatteryPower() {
      return onBattery;
    },
    subscribePowerEvents(h) {
      handlers = h;
      return () => {
        if (handlers === h) {
          handlers = null;
        }
      };
    },
  };

  return {
    adapter,
    getActiveCount: () => active.size,
    getStartCount: () => startCount,
    getStopCount: () => stopCount,
    isSubscribed: () => handlers !== null,
    isForeignBlockerIntact: () => foreignActive.has(9999),
    emitSuspend: () => handlers?.onSuspend(),
    emitResume: () => handlers?.onResume(),
    emitAc: () => {
      onBattery = false;
      handlers?.onAc();
    },
    emitBattery: () => {
      onBattery = true;
      handlers?.onBattery();
    },
    setBatterySupported: (val: boolean | null) => {
      onBattery = val;
    },
  };
}

test('Phase 6.5 Power Management — All 22 deterministic state machine, streaming grace, battery & security scenarios', async () => {
  // Part 1: Deterministic unit state machine tests (Scenarios 1..19, 22)
  let fakeNow = 1_700_000_000_000;
  let activeStreamDevices: string[] = [];
  const authorizedDevices = new Set<string>(['dev-1', 'dev-2', 'dev-3']);
  const mock = createMockPowerAdapter(false);

  const pm = new HostPowerManager({
    inactivityGraceMs: 250,
    sessionLeaseTtlMs: 2_000,
    adapter: mock.adapter,
    nowMs: () => fakeNow,
    getActiveStreamDeviceIds: () => [...activeStreamDevices],
    isDeviceAuthorized: (id) => authorizedDevices.has(id),
  });

  // 1. Default Follow System Settings
  assert.equal(pm.getPolicy(), 'follow-system');
  assert.equal(pm.isBlockerActive(), false);
  pm.setHostState('STANDBY');
  assert.equal(pm.isBlockerActive(), false);
  assert.equal(mock.getStartCount(), 0);

  // 2. Keep Awake While Streaming without active sessions
  pm.setPolicy('keep-awake-streaming');
  assert.equal(pm.isBlockerActive(), false);
  assert.equal(mock.getStartCount(), 0);

  // 3. First valid active playback session
  activeStreamDevices = ['dev-1'];
  pm.setHostState('ACTIVE');
  pm.notifyStreamActivityChanged();
  assert.equal(pm.isBlockerActive(), true);
  assert.equal(pm.getSnapshot().blockerMode, 'prevent-app-suspension');
  assert.equal(mock.getActiveCount(), 1);
  assert.equal(mock.getStartCount(), 1);
  const firstBlockerId = pm.getOwnedBlockerId();
  assert.ok(firstBlockerId !== null);

  // 4. Multiple active playback sessions & 15. Repeated blocker acquisition prevention
  activeStreamDevices = ['dev-1', 'dev-2', 'dev-3'];
  pm.notifyStreamActivityChanged();
  pm.reconcile();
  pm.reconcile();
  assert.equal(pm.isBlockerActive(), true);
  assert.equal(mock.getActiveCount(), 1);
  assert.equal(mock.getStartCount(), 1, 'Must never acquire duplicate blockers across multiple clients');
  assert.equal(pm.getOwnedBlockerId(), firstBlockerId);
  assert.equal(pm.getSnapshot().activeStreamDeviceCount, 3);

  // 5. One of several sessions ends (blocker stays active without entering grace)
  activeStreamDevices = ['dev-2'];
  pm.notifyStreamActivityChanged();
  assert.equal(pm.isBlockerActive(), true);
  assert.equal(pm.getSnapshot().inactivityGraceActive, false);
  assert.equal(pm.getOwnedBlockerId(), firstBlockerId);

  // 6. Final session ends -> enters bounded inactivity grace
  activeStreamDevices = [];
  pm.setHostState('STANDBY');
  pm.notifyStreamActivityChanged();
  assert.equal(pm.isBlockerActive(), true, 'Blocker stays held during track-transition / pause grace');
  assert.equal(pm.getSnapshot().inactivityGraceActive, true);

  // 7. Short track transition (< graceMs) -> preserves exact same blocker without toggling
  await sleep(80);
  activeStreamDevices = ['dev-2'];
  pm.setHostState('ACTIVE');
  pm.notifyStreamActivityChanged();
  assert.equal(pm.isBlockerActive(), true);
  assert.equal(pm.getSnapshot().inactivityGraceActive, false);
  assert.equal(pm.getOwnedBlockerId(), firstBlockerId);
  assert.equal(mock.getStartCount(), 1, 'Short track transition must not toggle blocker off/on');

  // 8. Inactivity grace expiration -> releases blocker deterministically
  activeStreamDevices = [];
  pm.setHostState('STANDBY');
  pm.notifyStreamActivityChanged();
  assert.equal(pm.getSnapshot().inactivityGraceActive, true);
  await sleep(320);
  assert.equal(pm.isBlockerActive(), false, 'Blocker must release once inactivity grace expires');
  assert.equal(mock.getActiveCount(), 0);
  assert.equal(pm.getSnapshot().inactivityGraceActive, false);

  // 9. Abandoned / expired session lease expiration & 19. Invalid or obsolete session signal
  assert.equal(
    pm.recordAuthenticatedPlaybackSignal({
      deviceId: 'unknown-unauth-dev',
      sessionToken: 'tok-unauth',
      state: 'playing',
    }),
    false,
    'Unauthorized device signal must be rejected',
  );
  assert.equal(pm.isBlockerActive(), false);

  assert.equal(
    pm.recordAuthenticatedPlaybackSignal({
      deviceId: 'dev-1',
      sessionToken: 'session-new-A',
      state: 'playing',
    }),
    true,
  );
  assert.equal(pm.isBlockerActive(), true);
  // Obsolete session token cannot stop current active session-new-A
  assert.equal(
    pm.recordAuthenticatedPlaybackSignal({
      deviceId: 'dev-1',
      sessionToken: 'obsolete-session-old',
      state: 'stopped',
    }),
    false,
  );
  assert.equal(pm.isBlockerActive(), true);

  // Advance simulated clock past sessionLeaseTtlMs (2000ms) -> abandoned lease expires -> grace -> release
  fakeNow += 2_500;
  pm.reconcile();
  await sleep(320);
  assert.equal(pm.isBlockerActive(), false, 'Abandoned playback lease must expire and release blocker');

  // 10. Keep Awake While Host Is On
  pm.setPolicy('keep-awake-host-on');
  assert.equal(pm.isBlockerActive(), true, 'Keep Awake While Host Is On acquires blocker in STANDBY');
  assert.ok(pm.getSnapshot().policyWarning?.includes('tăng mức tiêu thụ điện'));

  // 12. Policy changed while Host is active -> Follow System releases immediately
  pm.setPolicy('follow-system');
  assert.equal(pm.isBlockerActive(), false);

  // 13. Policy changed while Client streams
  activeStreamDevices = ['dev-1'];
  pm.setHostState('ACTIVE');
  pm.notifyStreamActivityChanged();
  assert.equal(pm.isBlockerActive(), false, 'Follow System never blocks sleep even during active stream');
  pm.setPolicy('keep-awake-streaming');
  assert.equal(pm.isBlockerActive(), true, 'Switching to Keep Awake While Streaming mid-stream acquires immediately');
  pm.setPolicy('follow-system');
  assert.equal(pm.isBlockerActive(), false, 'Switching back to Follow System mid-stream releases immediately');

  // 11. Host disabled releases immediately
  pm.setPolicy('keep-awake-host-on');
  assert.equal(pm.isBlockerActive(), true);
  pm.setHostState('STOPPED');
  assert.equal(pm.isBlockerActive(), false, 'Host OFF must release Host-owned sleep blocker immediately');

  // 16. Repeated blocker release safety (idempotent, never touches foreign blocker 9999)
  pm.setHostState('STOPPED');
  pm.setPolicy('follow-system');
  assert.equal(mock.isForeignBlockerIntact(), true);

  // 17. Suspend event & 18. Resume event & 22. Battery-related behavior
  pm.setHostState('STANDBY');
  pm.setPolicy('keep-awake-host-on');
  assert.equal(pm.isBlockerActive(), true);
  assert.equal(pm.getSnapshot().powerSource, 'ac');
  assert.equal(pm.getSnapshot().batteryWarning, null);

  mock.emitBattery();
  assert.equal(pm.getSnapshot().powerSource, 'battery');
  assert.equal(pm.getPolicy(), 'keep-awake-host-on', 'Battery transition must not silently override user policy');
  assert.ok(pm.getSnapshot().batteryWarning !== null, 'Must surface battery warning when keeping awake on battery');

  mock.emitSuspend();
  assert.equal(pm.getSnapshot().systemSuspended, true);
  assert.ok(pm.getSnapshot().lastSuspendAt !== null);
  assert.equal(pm.isBlockerActive(), false, 'Suspend releases transient runtime blocker cleanly');

  mock.emitResume();
  assert.equal(pm.getSnapshot().systemSuspended, false);
  assert.ok(pm.getSnapshot().lastResumeAt !== null);
  assert.equal(pm.isBlockerActive(), true, 'Resume restores policy-required blocker while Host remains ON');

  mock.emitAc();
  assert.equal(pm.getSnapshot().powerSource, 'ac');
  assert.equal(pm.getSnapshot().batteryWarning, null);

  // Unavailable battery info (desktop PC) reported accurately as 'unknown'
  mock.setBatterySupported(null);
  mock.emitResume();
  assert.equal(pm.getSnapshot().powerSource, 'unknown');

  // 14. Application shutdown cleanup
  pm.dispose();
  assert.equal(pm.isBlockerActive(), false);
  assert.equal(mock.getActiveCount(), 0);
  assert.equal(mock.isSubscribed(), false);
  assert.equal(mock.isForeignBlockerIntact(), true);
});

test('Phase 6.5 Power Integration — Persistence, revoked device immediate release, unauthorized HTTP power request rejection & fail-closed Remote resume', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p65-pwr-int-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);

  const flacPath = path.join(musicDir, 'PowerTest.flac');
  const flacBytes = Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(512 * 1024)]);
  await fs.writeFile(flacPath, flacBytes);
  const stat = await fs.stat(flacPath);

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  trackRepo.upsertBatch([
    {
      original_path: flacPath,
      normalized_path: normalizeTrackPath(flacPath),
      title: 'Power Integration FLAC',
      artist: 'DoReMi',
      album: 'Phase 6.5',
      duration_ms: 60_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44_100,
      bit_depth: 16,
      bitrate_bps: 750_000,
      file_size_bytes: flacBytes.length,
      modified_at_ms: Math.round(stat.mtimeMs),
      status: 'available',
    },
  ]);
  const track = trackRepo.findAll()[0];

  let funnelHealthy = true;
  let routeTarget = '';
  const mockCli = {
    findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe',
    async exec(args: readonly string[]) {
      if (args[0] === 'version') {
        return { ok: true, exitCode: 0, stdout: '{"majorMinorPatch":"1.104.7"}', stderr: '', timedOut: false, aborted: false };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: funnelHealthy ? 'Running' : 'Stopped',
            Self: { DNSName: 'doremi-pwr.tail6500.ts.net.', Capabilities: ['https://tailscale.com/cap/funnel'] },
            CurrentTailnet: { MagicDNSSuffix: 'tail6500.ts.net', MagicDNSEnabled: true },
            CertDomains: ['doremi-pwr.tail6500.ts.net'],
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
          stdout:
            funnelHealthy && routeTarget
              ? JSON.stringify({
                  Web: {
                    'doremi-pwr.tail6500.ts.net:443': {
                      Handlers: { '/doremi-connect': { Proxy: routeTarget } },
                    },
                  },
                  AllowFunnel: { 'doremi-pwr.tail6500.ts.net:443': true },
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
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
  hostRepo.addSharedSource(root.id);

  const mockPwr = createMockPowerAdapter(false);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.9',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir, allowFileFallback: true }),
    remoteProvider: new TailscaleFunnelProvider({ cli: mockCli }),
    powerAdapter: mockPwr.adapter,
    powerInactivityGraceMs: 400,
    enableMdns: false,
  });

  const client = new ConnectClientService({
    connectRepo: new ConnectRepository(clientConn.db),
    secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
  });

  try {
    // Policy persistence across ConnectRepository reads (SQLite schema v10 preserved!)
    const migVersion = hostConn.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    assert.equal(migVersion.v, 10, 'SQLite schema must remain v10 without destructive migration');

    host.setPowerPolicy('keep-awake-streaming');
    assert.equal(hostRepo.getHostConfig().powerPolicy, 'keep-awake-streaming');

    const snap = await host.start();
    const port = snap.listeningPort!;
    const hostId = snap.identity!.hostId;
    assert.equal(snap.power?.blockerActive, false, 'No active stream yet -> blocker off');

    // Scenario 21: Unauthorized power-related request rejected with 401 and zero blocker side-effects
    const probe = await client.probeHost('127.0.0.1', port);
    const unauthStatus = await new Promise<number>((resolve, reject) => {
      import('node:https').then(({ default: https }) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/v1/playback/session',
            method: 'POST',
            rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ sessionToken: 'spoof', state: 'playing' }));
      }).catch(reject);
    });
    assert.equal(unauthStatus, 401);
    assert.equal(host.getSnapshot().power?.blockerActive, false);

    // Pair Client & start an open stream -> blocker activates -> revoke device mid-stream -> immediate blocker release!
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Power Test Laptop',
    });
    const deviceId = host.getSnapshot().authorizedDevices[0].deviceId;

    const streamUrl = buildRemoteTrackMediaUrl(hostId, track.id);
    const resp = await client.resolveRemoteTrackMediaResponse(
      new Request(streamUrl, { headers: { Range: 'bytes=0-262143' } }),
    );
    const reader = resp.body!.getReader();
    await reader.read(); // Pull first chunk; stream stays open in backpressure
    assert.equal(host.getSnapshot().power?.blockerActive, true, 'Active stream acquires blocker');

    // Scenario 20: Revoked device session releases blocker IMMEDIATELY without waiting for 400ms grace
    host.revokeDevice(deviceId);
    assert.equal(
      host.getSnapshot().power?.blockerActive,
      false,
      'Revoking the only streaming device must release sleep blocker immediately',
    );
    await reader.cancel().catch(() => {});
    await client.disconnect();

    // Public Remote Access safety across Suspend/Resume:
    // 1) When Remote Access is DISABLED, resume NEVER enables Funnel!
    assert.equal(host.getSnapshot().remoteAccess?.state, 'DISABLED');
    await host.handleSystemSuspend();
    await host.handleSystemResume();
    assert.equal(host.getSnapshot().remoteAccess?.state, 'DISABLED');
    assert.equal(routeTarget, '');

    // 2) When Remote Access is READY in this session, if Tailscale/Funnel breaks during sleep, resume FAILS CLOSED!
    const enabled = await host.enableRemoteAccess({
      confirmPublicExposure: true,
      preferredPublicPort: 443,
    });
    assert.equal(enabled.remoteAccess?.state, 'READY');
    funnelHealthy = false;
    await host.handleSystemSuspend();
    await host.handleSystemResume();
    const afterBrokenResume = host.getSnapshot();
    assert.equal(
      afterBrokenResume.remoteAccess?.state,
      'ERROR',
      'Broken Funnel route on resume must fail closed to ERROR',
    );
    assert.equal(afterBrokenResume.remoteAccess?.gatewayListeningPort, null);
  } finally {
    await client.shutdown().catch(() => {});
    await host.dispose().catch(() => {});
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});
