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
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import {
  findOfficialWindowsTailscaleExecutable,
  inspectServeConfigPorts,
  isSupportedTailscaleVersion,
  parseTailscaleSemver,
  SafeTailscaleCliExecutor,
  sanitizeTailscaleText,
  type TailscaleCliExecResult,
  type TailscaleCommandExecutor,
} from '../src/main/services/connect/tailscale-cli';
import { TailscaleFunnelProvider } from '../src/main/services/connect/tailscale-funnel-provider';
import { normalizeTrackPath } from '../src/main/services/path-utils';

class MockTailscaleCli implements TailscaleCommandExecutor {
  exePath: string | null = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  calls: string[][] = [];
  handler: (args: readonly string[]) => Promise<TailscaleCliExecResult>;

  constructor(handler: (args: readonly string[]) => Promise<TailscaleCliExecResult>) {
    this.handler = handler;
  }

  findExecutable(): string | null {
    return this.exePath;
  }

  async exec(args: readonly string[]): Promise<TailscaleCliExecResult> {
    this.calls.push([...args]);
    return this.handler(args);
  }
}

function okExec(stdout: string): TailscaleCliExecResult {
  return { ok: true, exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false };
}

function errExec(stderr: string, extra?: Partial<TailscaleCliExecResult>): TailscaleCliExecResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr,
    timedOut: false,
    aborted: false,
    ...extra,
  };
}

const VALID_DNS = 'doremi-home.tail9999.ts.net';

function makeStatusJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    BackendState: 'Running',
    Self: {
      DNSName: `${VALID_DNS}.`,
      Capabilities: ['https://tailscale.com/cap/funnel'],
    },
    CurrentTailnet: {
      MagicDNSSuffix: 'tail9999.ts.net',
      MagicDNSEnabled: true,
    },
    CertDomains: [VALID_DNS],
    ...overrides,
  });
}

test('Phase 6.3 Provider-1: Safe Tailscale CLI path finder, sanitization, version check, and arg injection guards', async () => {
  assert.equal(
    findOfficialWindowsTailscaleExecutable((p) => p.toLowerCase().endsWith('\\tailscale\\tailscale.exe')),
    findOfficialWindowsTailscaleExecutable((p) => p.toLowerCase().endsWith('\\tailscale\\tailscale.exe')),
  );
  assert.equal(findOfficialWindowsTailscaleExecutable(() => false), null);

  assert.equal(
    sanitizeTailscaleText('Visit https://login.tailscale.com/a/123?secret=xyz tskey-auth-abc'),
    'Visit [redacted-url] [redacted-secret]',
  );

  assert.equal(isSupportedTailscaleVersion(parseTailscaleSemver('{"majorMinorPatch":"1.76.1"}')), true);
  assert.equal(isSupportedTailscaleVersion(parseTailscaleSemver('1.51.9')), false);
  assert.equal(isSupportedTailscaleVersion(parseTailscaleSemver('garbled output')), false);

  const safeExec = new SafeTailscaleCliExecutor({ findExecutable: () => 'C:\\Program Files\\Tailscale\\tailscale.exe' });
  const badArg = await safeExec.exec(['status', 'bad\narg']);
  assert.equal(badArg.ok, false);
  assert.equal(badArg.errorCode, 'INVALID_ARGS');
});

test('Phase 6.3 Provider-2: Tailscale detection matrix (missing, old version, service down, login required, MagicDNS/HTTPS, Funnel permission, malformed JSON, timeout)', async () => {
  // 1. Not installed
  const cli = new MockTailscaleCli(async () => okExec('{}'));
  cli.exePath = null;
  const provider = new TailscaleFunnelProvider({ cli });
  assert.equal((await provider.detectStatus()).detectionStatus, 'not_installed');

  // 2. Unsupported CLI version
  cli.exePath = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  cli.handler = async (args) =>
    args[0] === 'version' ? okExec('1.40.0') : okExec(makeStatusJson());
  assert.equal((await provider.detectStatus()).detectionStatus, 'unsupported_version');

  // 3. Status command timeout
  cli.handler = async (args) =>
    args[0] === 'version'
      ? okExec('{"majorMinorPatch":"1.76.0"}')
      : errExec('timeout', { timedOut: true, errorCode: 'TIMEOUT' });
  assert.equal((await provider.detectStatus()).detectionStatus, 'service_unavailable');

  // 4. Service stopped / unavailable
  cli.handler = async (args) =>
    args[0] === 'version'
      ? okExec('{"majorMinorPatch":"1.76.0"}')
      : errExec('failed to connect to local tailscaled service not running');
  assert.equal((await provider.detectStatus()).detectionStatus, 'stopped');

  // 5. Malformed status JSON
  cli.handler = async (args) =>
    args[0] === 'version' ? okExec('{"majorMinorPatch":"1.76.0"}') : okExec('{bad json');
  assert.equal((await provider.detectStatus()).detectionStatus, 'service_unavailable');

  // 6. NeedsLogin
  cli.handler = async (args) =>
    args[0] === 'version'
      ? okExec('{"majorMinorPatch":"1.76.0"}')
      : okExec(makeStatusJson({ BackendState: 'NeedsLogin' }));
  assert.equal((await provider.detectStatus()).detectionStatus, 'login_required');

  // 7. Missing HTTPS certificates / MagicDNS
  cli.handler = async (args) =>
    args[0] === 'version'
      ? okExec('{"majorMinorPatch":"1.76.0"}')
      : okExec(makeStatusJson({ CertDomains: [] }));
  assert.equal((await provider.detectStatus()).detectionStatus, 'magicdns_or_https_missing');

  // 8. Missing Funnel capability / ACL denied
  cli.handler = async (args) =>
    args[0] === 'version'
      ? okExec('{"majorMinorPatch":"1.76.0"}')
      : okExec(makeStatusJson({ Self: { DNSName: `${VALID_DNS}.`, Capabilities: [] } }));
  assert.equal((await provider.detectStatus()).detectionStatus, 'funnel_permission_denied');
});

test('Phase 6.3 Provider-3: Route conflict protection refuses overwriting private Serve/unrelated routes and cleans up ONLY owned routes', async () => {
  let funnelCfg: Record<string, unknown> = {
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${VALID_DNS}:443`]: {
        Handlers: {
          '/other-app': { Proxy: 'http://127.0.0.1:9000' },
        },
      },
    },
    AllowFunnel: {
      // Existing private Serve on :443! Must NOT enable Funnel on :443!
      [`${VALID_DNS}:443`]: false,
    },
  };

  const cli = new MockTailscaleCli(async (args) => {
    if (args[0] === 'version') return okExec('{"majorMinorPatch":"1.78.0"}');
    if (args[0] === 'status') return okExec(makeStatusJson());
    if (args[0] === 'funnel' && args[1] === 'status') return okExec(JSON.stringify(funnelCfg));
    if (args[0] === 'funnel' && args[1] === '--bg') {
      const portFlag = args.find((a) => a.startsWith('--https='))!;
      const pathFlag = args.find((a) => a.startsWith('--set-path='))!;
      const target = args[args.length - 1];
      const port = portFlag.split('=')[1];
      const mount = pathFlag.split('=')[1];
      const key = `${VALID_DNS}:${port}`;
      funnelCfg = {
        ...funnelCfg,
        Web: {
          ...(funnelCfg.Web as Record<string, unknown>),
          [key]: { Handlers: { [mount]: { Proxy: target } } },
        },
        AllowFunnel: {
          ...(funnelCfg.AllowFunnel as Record<string, unknown>),
          [key]: true,
        },
      };
      return okExec('');
    }
    if (args[0] === 'funnel' && args.includes('off')) {
      const portFlag = args.find((a) => a.startsWith('--https='))!;
      const pathFlag = args.find((a) => a.startsWith('--set-path='))!;
      const port = portFlag.split('=')[1];
      const mount = pathFlag.split('=')[1];
      const key = `${VALID_DNS}:${port}`;
      const web = { ...(funnelCfg.Web as Record<string, unknown>) };
      const cur = (web[key] as { Handlers: Record<string, unknown> } | undefined)?.Handlers ?? {};
      delete cur[mount];
      web[key] = { Handlers: cur };
      funnelCfg = { ...funnelCfg, Web: web };
      return okExec('');
    }
    return okExec('');
  });

  const provider = new TailscaleFunnelProvider({ cli });
  // Port 443 has private Serve route -> detectStatus marks route_conflict for preferred 443, while 8443/10000 available
  const status443 = await provider.detectStatus({ preferredPort: 443 });
  assert.equal(status443.detectionStatus, 'route_conflict');
  assert.deepEqual(status443.availablePublicPorts, [8443, 10000]);

  // Port 8443 succeeds cleanly without touching port 443!
  const act = await provider.activateRoute({
    localGatewayPort: 51234,
    preferredPublicPort: 8443,
    mountPath: '/doremi-connect',
  });
  assert.equal(act.ok, true);
  if (act.ok) {
    assert.equal(act.publicEndpointUrl, `https://${VALID_DNS}:8443/doremi-connect`);
    // Private 443 route remains untouched!
    const inspected443 = inspectServeConfigPorts(JSON.stringify(funnelCfg), VALID_DNS)[443];
    assert.equal(inspected443.handlers['/other-app']?.proxy, 'http://127.0.0.1:9000');

    // Verify deactivation sends targeted `--set-path=/doremi-connect off`, NEVER `funnel reset`!
    const deact = await provider.deactivateOwnedRoute(act.ownedRoute);
    assert.equal(deact.ok, true);
    assert.equal(cli.calls.some((c) => c.includes('reset')), false);
    const inspectedAfter = inspectServeConfigPorts(JSON.stringify(funnelCfg), VALID_DNS);
    assert.equal(inspectedAfter[443].handlers['/other-app']?.proxy, 'http://127.0.0.1:9000');
    assert.equal(inspectedAfter[8443].handlers['/doremi-connect'], undefined);
  }
});

test('Phase 6.3 Provider-4: Host Remote Access lifecycle, pre-exposure security gate, cleanup failure closes gateway, and stale route reconciliation on restart', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p63-prov-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });
  const songPath = path.join(musicDir, '01-Test.flac');
  await fs.writeFile(songPath, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(16 * 1024)]));

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
      title: 'Remote Song',
      artist: 'DoReMi',
      album: 'Funnel',
      duration_ms: 60_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 900_000,
      file_size_bytes: 16388,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);

  const connectRepo = new ConnectRepository(conn.db);
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
  connectRepo.addSharedSource(root.id);
  const secrets = new ConnectSecretStorage({ userDataDir });

  let failOffCommand = false;
  let routeActive = false;
  let lastTarget = '';
  const cli = new MockTailscaleCli(async (args) => {
    if (args[0] === 'version') return okExec('{"majorMinorPatch":"1.78.0"}');
    if (args[0] === 'status') return okExec(makeStatusJson());
    if (args[0] === 'funnel' && args[1] === 'status') {
      if (!routeActive) return okExec('{}');
      return okExec(
        JSON.stringify({
          Web: { [`${VALID_DNS}:443`]: { Handlers: { '/doremi-connect': { Proxy: lastTarget } } } },
          AllowFunnel: { [`${VALID_DNS}:443`]: true },
        }),
      );
    }
    if (args[0] === 'funnel' && args[1] === '--bg') {
      routeActive = true;
      lastTarget = args[args.length - 1];
      return okExec('');
    }
    if (args[0] === 'funnel' && args.includes('off')) {
      if (failOffCommand) return errExec('daemon temporarily unavailable');
      routeActive = false;
      return okExec('');
    }
    return okExec('');
  });

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.7',
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets,
    remoteProvider: new TailscaleFunnelProvider({ cli }),
    enableMdns: false,
  });

  try {
    // 1. Host OFF -> enabling Remote Access is blocked cleanly
    const offAttempt = await host.enableRemoteAccess({ confirmPublicExposure: true });
    assert.equal(offAttempt.remoteAccess?.state, 'ERROR');
    assert.equal(offAttempt.remoteAccess?.gatewayListeningPort, null);

    // 2. Host ON -> Remote Access stays DISABLED by default
    const started = await host.start();
    assert.equal(started.state, 'STANDBY');
    assert.equal(started.remoteAccess?.state, 'DISABLED');
    assert.equal(started.remoteAccess?.gatewayListeningPort, null);

    // 3. Attempting enable without user acknowledgment fails pre-exposure gate (`SECURITY_BLOCKED`)
    const noAck = await host.enableRemoteAccess({ confirmPublicExposure: false });
    assert.equal(noAck.remoteAccess?.state, 'SECURITY_BLOCKED');

    // 4. Enable with confirmation activates Gateway on 127.0.0.1 + signed descriptor
    const enabled = await host.enableRemoteAccess({
      confirmPublicExposure: true,
      preferredPublicPort: 443,
    });
    assert.equal(enabled.remoteAccess?.state, 'READY');
    assert.ok(enabled.remoteAccess?.gatewayListeningPort);
    assert.equal(enabled.remoteAccess?.publicEndpointUrl, `https://${VALID_DNS}/doremi-connect`);
    assert.ok(enabled.remoteAccess?.activeDescriptor?.signatureBase64);

    // 5. Simulate Funnel cleanup failure on disable -> Gateway MUST still close + staleRouteWarning surfaced!
    failOffCommand = true;
    const disabledWithFail = await host.disableRemoteAccess();
    assert.equal(disabledWithFail.remoteAccess?.state, 'DISABLED');
    assert.equal(disabledWithFail.remoteAccess?.gatewayListeningPort, null);
    assert.ok(disabledWithFail.remoteAccess?.staleRouteWarning);
    // LAN Direct remains alive!
    assert.equal(disabledWithFail.state, 'STANDBY');

    // 6. Simulate crash recovery: restart Host with persisted stale route in SQLite -> startup reconciles cleanly & stays DISABLED!
    failOffCommand = false;
    await host.stop();
    const restartedHost = new ConnectHostService({
      appVersion: '1.0.0-rc.7',
      userDataDir,
      connectRepo,
      trackRepo,
      artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir }),
      lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
      secrets,
      remoteProvider: new TailscaleFunnelProvider({ cli }),
      enableMdns: false,
    });
    const restartedSnap = await restartedHost.start();
    assert.equal(restartedSnap.remoteAccess?.state, 'DISABLED');
    assert.equal(routeActive, false, 'Stale owned Funnel route must be cleaned up on restart');
    assert.equal(connectRepo.getOwnedRemoteRoute(), null);
    await restartedHost.stop();
  } finally {
    await host.stop();
    conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
