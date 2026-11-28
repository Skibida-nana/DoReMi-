import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
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
import {
  createIsolatedTestCa,
  createLoopbackLookup,
  startSimulatedFunnelTlsProxy,
} from './helpers/test-ca-https';

const REMOTE_HOSTNAME = 'doremi-handover.tail8888.ts.net';

function findFfmpegPath(): string | null {
  const candidates = [
    process.env.DOREMI_REAL_FFMPEG_DIR
      ? path.join(process.env.DOREMI_REAL_FFMPEG_DIR, 'ffmpeg.exe')
      : null,
    'D:/Dowload/FFmpeg/ffmpeg-2026-11-23-git-05c674c913-full_build/bin/ffmpeg.exe',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createToneWavBuffer(durationSec: number, sampleRate: number, bits: 16 | 24, freqHz = 440): Buffer {
  const channels = 2;
  const bytesPerSample = bits / 8;
  const frameCount = Math.round(sampleRate * durationSec);
  const dataSize = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < frameCount; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 11000);
    for (let ch = 0; ch < channels; ch += 1) {
      if (bits === 16) {
        buf.writeInt16LE(val, off);
      } else {
        const s24 = val << 8;
        buf[off] = s24 & 0xff;
        buf[off + 1] = (s24 >> 8) & 0xff;
        buf[off + 2] = (s24 >> 16) & 0xff;
      }
      off += bytesPerSample;
    }
  }
  return buf;
}

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

test('Phase 6.4 Chromium E2E Playback Handover: FLAC, ALAC "Có Thể (102112 Version)", ALAC 24/48, WAV, AAC, Hi-Res FLAC, User Intent, Search/Queue/Stats & Source Consistency', async (t) => {
  const ffmpeg = findFfmpegPath();
  if (!ffmpeg) {
    t.skip('ffmpeg binary not available for Phase 6.4 playback handover fixtures');
    return;
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p64-handover-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  const localClientMusicDir = path.join(tmpRoot, 'local-client-music');
  await Promise.all([
    fs.mkdir(hostDir, { recursive: true }),
    fs.mkdir(clientDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(localClientMusicDir, { recursive: true }),
  ]);

  const wav16 = path.join(musicDir, '01-wav-16.wav');
  const wav24 = path.join(musicDir, '02-wav-24-48.wav');
  const wav96 = path.join(musicDir, '03-wav-24-96.wav');
  const flac16 = path.join(musicDir, '04-flac-16.flac');
  const flacHiRes = path.join(musicDir, '05-flac-24-96.flac');
  const aacM4a = path.join(musicDir, '06-aac.m4a');
  const alacCoThe = path.join(musicDir, '07-co-the-102112.m4a');
  const alac24Eof = path.join(musicDir, '08-alac-24-48-eof.m4a');
  const mutableWav = path.join(musicDir, '09-mutable-source.wav');
  const localWav = path.join(localClientMusicDir, 'local-song.wav');

  await fs.writeFile(wav16, createToneWavBuffer(10, 44100, 16, 440));
  await fs.writeFile(wav24, createToneWavBuffer(10, 48000, 24, 523));
  await fs.writeFile(wav96, createToneWavBuffer(8, 96000, 24, 659));
  await fs.writeFile(mutableWav, createToneWavBuffer(6, 44100, 16, 330));
  await fs.writeFile(localWav, createToneWavBuffer(6, 44100, 16, 392));

  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav16, '-c:a', 'flac', flac16]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav96, '-c:a', 'flac', flacHiRes]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav16, '-c:a', 'aac', '-b:a', '192k', aacM4a]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav16, '-c:a', 'alac', '-movflags', '+faststart', alacCoThe]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', wav24, '-c:a', 'alac', alac24Eof]);
  await fs.writeFile(
    path.join(musicDir, '04-flac-16.lrc'),
    '[00:01.00] Handover Lyric Line One\n[00:04.00] Handover Lyric Line Two\n',
    'utf8',
  );

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  const defs = [
    { p: flac16, title: 'FLAC_16_44', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16, dur: 10000 },
    { p: alacCoThe, title: 'Có Thể (102112 Version)', codec: 'ALAC', container: 'M4A', sr: 44100, bits: 16, dur: 10000 },
    { p: alac24Eof, title: 'ALAC_24_48_EOF', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24, dur: 10000 },
    { p: wav16, title: 'WAV_16_44', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16, dur: 10000 },
    { p: aacM4a, title: 'AAC_M4A', codec: 'AAC', container: 'M4A', sr: 44100, bits: null, dur: 10000 },
    { p: flacHiRes, title: 'HIRES_FLAC_24_96', codec: 'FLAC', container: 'FLAC', sr: 96000, bits: 24, dur: 8000 },
    { p: mutableWav, title: 'MUTABLE_SOURCE', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16, dur: 6000 },
  ];

  const rows = [];
  for (const d of defs) {
    const st = await fs.stat(d.p);
    rows.push({
      original_path: d.p,
      normalized_path: normalizeTrackPath(d.p),
      title: d.title,
      artist: 'DoReMi Phase 6.4',
      album: 'Handover Verification Suite',
      duration_ms: d.dur,
      codec: d.codec,
      container: d.container,
      sample_rate_hz: d.sr,
      bit_depth: d.bits,
      bitrate_bps: 1_200_000,
      file_size_bytes: st.size,
      modified_at_ms: Math.round(st.mtimeMs),
      status: 'available' as const,
    });
  }
  trackRepo.upsertBatch(rows);

  // Controllable TCP gate in front of LAN HTTPS server so child process can toggle LAN up/down while keeping Remote Gateway alive!
  const netMod = await import('node:net');
  let lanGateOpen = true;
  const activeLanSockets = new Set<import('node:net').Socket>();
  let realLanPort = 0;

  const lanGateServer = netMod.createServer((clientSock) => {
    if (!lanGateOpen) {
      clientSock.destroy();
      return;
    }
    activeLanSockets.add(clientSock);
    const upstream = netMod.connect(realLanPort, '127.0.0.1');
    clientSock.pipe(upstream);
    upstream.pipe(clientSock);
    const cleanup = () => {
      activeLanSockets.delete(clientSock);
      clientSock.destroy();
      upstream.destroy();
    };
    clientSock.on('error', cleanup);
    upstream.on('error', cleanup);
    clientSock.on('close', cleanup);
    upstream.on('close', cleanup);
  });
  await new Promise<void>((r) => lanGateServer.listen(0, '127.0.0.1', r));
  const gatedLanPort = (lanGateServer.address() as { port: number }).port;

  // Small local HTTP control server so Chromium driver can toggle LAN gate & mutate/unshare source files deterministically
  const ctrlServer = http.createServer(async (req, res) => {
    const u = req.url || '/';
    if (u === '/lan-off') {
      lanGateOpen = false;
      for (const s of activeLanSockets) s.destroy();
      activeLanSockets.clear();
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (u === '/lan-on') {
      lanGateOpen = true;
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (u === '/mutate-source') {
      const nextBuf = createToneWavBuffer(7, 44100, 16, 880);
      await fs.writeFile(mutableWav, nextBuf);
      const nextSt = await fs.stat(mutableWav);
      const existing = trackRepo.findAll().find((x) => x.title === 'MUTABLE_SOURCE')!;
      trackRepo.upsertBatch([
        {
          original_path: existing.original_path,
          normalized_path: existing.normalized_path,
          title: existing.title,
          artist: existing.artist,
          album: existing.album,
          duration_ms: 7000,
          codec: 'PCM',
          container: 'WAV',
          sample_rate_hz: 44100,
          bit_depth: 16,
          bitrate_bps: 1411200,
          file_size_bytes: nextSt.size,
          modified_at_ms: Math.round(nextSt.mtimeMs) + 5000,
          status: 'available',
        },
      ]);
      res.writeHead(200);
      res.end('mutated');
      return;
    }
    if (u === '/delete-mutable') {
      const existing = trackRepo.findAll().find((x) => x.title === 'MUTABLE_SOURCE');
      if (existing) {
        hostConn.db.prepare('DELETE FROM tracks WHERE id = ?').run(existing.id);
      }
      res.writeHead(200);
      res.end('deleted');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => ctrlServer.listen(0, '127.0.0.1', r));
  const ctrlPort = (ctrlServer.address() as { port: number }).port;

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

  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });
  let proxy: { port: number; close(): Promise<void> } | null = null;
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  let clientConnClosed = false;
  let prepClientRef: ConnectClientService | null = null;

  try {
    await host.start();
    realLanPort = host.getSnapshot().listeningPort!;
    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    proxy = await startSimulatedFunnelTlsProxy({
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: enabled.remoteAccess!.gatewayListeningPort!,
    });

    // Insert 1 local track into Client's own SQLite DB to test switching from Remote Playback -> Local Playback!
    const clientTrackRepo = new TrackRepository(clientConn.db);
    const localSt = await fs.stat(localWav);
    clientTrackRepo.upsertBatch([
      {
        original_path: localWav,
        normalized_path: normalizeTrackPath(localWav),
        title: 'LOCAL_CLIENT_SONG',
        artist: 'Local Artist',
        album: 'Local Album',
        duration_ms: 6000,
        codec: 'PCM',
        container: 'WAV',
        sample_rate_hz: 44100,
        bit_depth: 16,
        bitrate_bps: 1411200,
        file_size_bytes: localSt.size,
        modified_at_ms: Math.round(localSt.mtimeMs),
        status: 'available',
      },
    ]);
    const localTrackRecord = clientTrackRepo.findAll()[0];

    const prepClient = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir, allowFileFallback: true }),
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: proxy.port,
      },
    });

    prepClientRef = prepClient;
    const hostId = enabled.identity!.hostId;
    const probe = await prepClient.probeHost('127.0.0.1', gatedLanPort);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await prepClient.enrollWithHost({
      address: '127.0.0.1',
      port: gatedLanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Chromium Handover Client',
    });
    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await prepClient.syncRemoteAccessOverLan(hostId);

    // Also test source-consistency check directly on ConnectClientService before spawning Chromium
    const mutableDto = (await prepClient.listRemoteTracks({ limit: 20 })).items.find(
      (x) => x.title === 'MUTABLE_SOURCE',
    )!;
    const consistentBefore = await prepClient.verifyTrackSourceConsistency({
      hostId,
      trackId: mutableDto.trackId,
      expectedFileSize: mutableDto.fileSizeBytes,
      expectedSourceRevision: mutableDto.sourceRevision,
    });
    assert.equal(consistentBefore.ok, true);
    assert.equal(consistentBefore.sourceConsistent, true);

    await fetch(`http://127.0.0.1:${ctrlPort}/mutate-source`);
    const consistentAfterMutate = await prepClient.verifyTrackSourceConsistency({
      hostId,
      trackId: mutableDto.trackId,
      expectedFileSize: mutableDto.fileSizeBytes,
      expectedSourceRevision: mutableDto.sourceRevision,
    });
    assert.equal(consistentAfterMutate.ok, true);
    assert.equal(consistentAfterMutate.sourceConsistent, false, 'Must detect file size / mtime source revision change');

    await fetch(`http://127.0.0.1:${ctrlPort}/delete-mutable`);
    const afterDelete = await prepClient.verifyTrackSourceConsistency({
      hostId,
      trackId: mutableDto.trackId,
    });
    assert.equal(afterDelete.missingOrUnshared, true, 'Missing/unshared track must be classified cleanly');

    await prepClient.shutdown();
    prepClientRef = null;
    clientConn.close();
    clientConnClosed = true;

    // Bundle Renderer harness (real AudioEngine + ConnectStore) and Electron Main driver
    const rendererEntryTs = path.join(tmpRoot, 'renderer-harness.ts');
    const rendererBundleJs = path.join(tmpRoot, 'renderer-harness.js');
    const mainDriverTs = path.join(tmpRoot, 'main-driver.ts');
    const mainDriverCjs = path.join(tmpRoot, 'main-driver.cjs');
    const outJson = path.join(tmpRoot, 'handover-e2e-results.json');

    const rendererCode = `
import { getAudioEngine } from ${JSON.stringify(path.resolve('src/renderer/src/player/audio-engine.ts'))};
import { ConnectStore } from ${JSON.stringify(path.resolve('src/renderer/src/stores/connect-store-core.ts'))};
import { isRemoteTrackId, parseRemoteTrackId } from ${JSON.stringify(path.resolve('src/shared/contracts/connect-api.ts'))};
import { buildRemoteTrackMediaUrl } from ${JSON.stringify(path.resolve('src/shared/contracts/media-protocol.ts'))};

const sessions: Array<{ sessionId: string; trackId: string; totalPlayedSeconds: number; completed: boolean }> = [];
const engine = getAudioEngine({
  verifyTrack: async (trackId) => ({ trackId, exists: true, status: 'available' }),
  onSessionCheckpoint: (s) => {
    const idx = sessions.findIndex((x) => x.sessionId === s.sessionId);
    const rec = { sessionId: s.sessionId, trackId: s.trackId, totalPlayedSeconds: s.totalPlayedSeconds, completed: Boolean(s.completed) };
    if (idx >= 0) sessions[idx] = rec;
    else sessions.push(rec);
  },
});

const api = (window as any).testBridge;
const store = new ConnectStore({
  getApi: () => api,
  queueController: engine.queueController,
  playbackActions: {
    playQueueEntry: (entry) => engine.playQueueEntry(entry, { fromAutoAdvance: false }),
    getPlaybackState: () => engine.getPlaybackState(),
    pauseSilently: () => engine.pauseSilently(),
    setRemoteHandoverPendingPredicate: (fn) => engine.setRemoteHandoverPendingPredicate(fn),
    recoverCurrentTrackTransport: (opts) => engine.recoverCurrentTrackTransport(opts),
  },
});

engine.setExternalTrackResolver({
  ownsTrackId: (id) => isRemoteTrackId(id),
  getTrack: (id) => store.getRemoteTrackRecord(id),
  resolveMediaUrl: (id) => {
    const p = parseRemoteTrackId(id)!;
    return buildRemoteTrackMediaUrl(p.hostId, p.trackId);
  },
  isTrackPlayable: (id) => store.isRemoteTrackPlayable(id),
  resolveRemoteDiagnosticHint: (id) => store.resolveRemoteFailureHintForTrack(id),
});

(window as any).__harness = { engine, store, sessions };
`;
    await fs.writeFile(rendererEntryTs, rendererCode, 'utf8');

    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [rendererEntryTs],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: rendererBundleJs,
      loader: { '.ts': 'ts' },
    });

    const preloadPath = path.join(tmpRoot, 'preload.cjs');
    await fs.writeFile(
      preloadPath,
      `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('testBridge', {
  connectGetHostSnapshot: () => ipcRenderer.invoke('p64:host-snap'),
  connectGetClientSnapshot: () => ipcRenderer.invoke('p64:client-snap'),
  connectGetClientDiagnostics: () => ipcRenderer.invoke('p64:client-diag'),
  connectToRememberedHost: (h, a, p, m) => ipcRenderer.invoke('p64:connect', h, a, p, m),
  connectSetConnectionMode: (h, m) => ipcRenderer.invoke('p64:set-mode', h, m),
  connectManualReconnect: () => ipcRenderer.invoke('p64:manual-reconnect'),
  connectNotifyNetworkHint: (hint) => ipcRenderer.invoke('p64:net-hint', hint),
  connectVerifyTrackSource: (p) => ipcRenderer.invoke('p64:verify-src', p),
  connectRecordHandoverOutcome: (p) => ipcRenderer.invoke('p64:rec-ho', p),
  connectListRemoteTracks: (o) => ipcRenderer.invoke('p64:tracks', o),
  connectListRemoteAlbums: (o) => ipcRenderer.invoke('p64:albums', o),
  connectListRemoteArtists: (o) => ipcRenderer.invoke('p64:artists', o),
  connectGetRemoteLyrics: (h, t) => ipcRenderer.invoke('p64:lyrics', h, t),
  onConnectClientStateChanged: (cb) => {
    const fn = (_e, snap) => cb(snap);
    ipcRenderer.on('p64:client-changed', fn);
    return () => ipcRenderer.removeListener('p64:client-changed', fn);
  },
  ctrl: (cmd) => ipcRenderer.invoke('p64:ctrl', cmd),
});
`,
      'utf8',
    );

    const mainDriverCode = `
import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openLibraryDatabase } from ${JSON.stringify(path.resolve('src/main/database/connection.ts'))};
import { TrackRepository } from ${JSON.stringify(path.resolve('src/main/database/track-repository.ts'))};
import { ConnectRepository } from ${JSON.stringify(path.resolve('src/main/services/connect/connect-repository.ts'))};
import { ConnectSecretStorage } from ${JSON.stringify(path.resolve('src/main/services/connect/secret-storage.ts'))};
import { ConnectClientService } from ${JSON.stringify(path.resolve('src/main/services/connect/connect-client.ts'))};
import { registerAudioProtocolHandler, registerPrivilegedAudioScheme } from ${JSON.stringify(path.resolve('src/main/services/audio-protocol.ts'))};
import { createLoopbackLookup } from ${JSON.stringify(path.resolve('tests/helpers/test-ca-https.ts'))};

app.setPath('userData', ${JSON.stringify(path.join(tmpRoot, 'electron-userdata'))});
registerPrivilegedAudioScheme();

app.whenReady().then(async () => {
  try {
    const conn = openLibraryDatabase(${JSON.stringify(path.join(clientDir, 'library.db'))});
    const trackRepo = new TrackRepository(conn.db);
    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(conn.db),
      secrets: new ConnectSecretStorage({ userDataDir: ${JSON.stringify(clientDir)}, allowFileFallback: true }),
      publicHttpsOptions: {
        ca: ${JSON.stringify(ca.caCertPem)},
        lookup: createLoopbackLookup(${JSON.stringify(REMOTE_HOSTNAME)}),
        connectOverridePort: ${proxy.port},
      },
      smartPolicy: {
        networkDebounceMs: 30,
        lanRecoveryConfirmMs: 50,
        switchCooldownMs: 20,
        failureThreshold: 1,
        retryBackoffMs: [40, 80],
        maxAutoReconnectAttempts: 3,
        enableJitter: false,
      },
    });

    registerAudioProtocolHandler({ trackRepo, connectClientService: client });

    let win: BrowserWindow | null = null;
    client.subscribe((snap) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('p64:client-changed', snap);
      }
    });

    ipcMain.handle('p64:host-snap', () => ({ state: 'STOPPED', activeInvitation: null }));
    ipcMain.handle('p64:client-snap', () => client.getSnapshot());
    ipcMain.handle('p64:client-diag', () => client.getClientDiagnosticsSnapshot());
    ipcMain.handle('p64:connect', (_e, h, a, p, m) => client.connectToRememberedHost(h, a, p, m));
    ipcMain.handle('p64:set-mode', (_e, h, m) => client.setConnectionMode(h, m));
    ipcMain.handle('p64:manual-reconnect', () => client.manualReconnect());
    ipcMain.handle('p64:net-hint', (_e, hint) => { client.notifyNetworkHint(hint); return { ok: true }; });
    ipcMain.handle('p64:verify-src', (_e, p) => client.verifyTrackSourceConsistency(p));
    ipcMain.handle('p64:rec-ho', (_e, p) => { client.recordHandoverPlaybackOutcome(p); return { ok: true }; });
    ipcMain.handle('p64:tracks', (_e, o) => client.listRemoteTracks(o));
    ipcMain.handle('p64:albums', (_e, o) => client.listRemoteAlbums(o));
    ipcMain.handle('p64:artists', (_e, o) => client.listRemoteArtists(o));
    ipcMain.handle('p64:lyrics', (_e, h, t) => client.getRemoteLyrics(h, t));
    ipcMain.handle('p64:ctrl', async (_e, cmd) => {
      await fetch('http://127.0.0.1:${ctrlPort}/' + cmd);
      if (cmd === 'lan-off') {
        await client.smartManager.reportTransportFailure({
          hostId: ${JSON.stringify(hostId)},
          transport: 'lan-direct',
          errorCode: 'NETWORK_INTERRUPTED',
          message: 'Simulated LAN drop',
          immediate: true,
        });
      } else if (cmd === 'lan-on') {
        client.notifyNetworkHint('online');
      }
      return true;
    });

    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      if (details.resourceType === 'mainFrame') {
        cb({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': ["default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:;"],
          },
        });
        return;
      }
      cb({ responseHeaders: details.responseHeaders });
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: ${JSON.stringify(preloadPath)},
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const bundleSrc = await fs.readFile(${JSON.stringify(rendererBundleJs)}, 'utf8');
    const htmlPath = path.join(${JSON.stringify(tmpRoot)}, 'handover.html');
    await fs.writeFile(htmlPath, '<!doctype html><html><body><script>' + bundleSrc + '</script></body></html>', 'utf8');
    await win.loadFile(htmlPath);

    const testPayloadJson = JSON.stringify({
      localTrack: ${JSON.stringify(localTrackRecord)},
      hostId: ${JSON.stringify(hostId)},
    });
    const report = await win.webContents.executeJavaScript(
      'window.__testPayload = ' + testPayloadJson + ';' + \`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitUntil = async (pred, timeoutMs = 8000) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (pred()) return true;
            await sleep(25);
          }
          return false;
        };
        const { engine, store, sessions } = window.__harness;
        const localTrack = window.__testPayload.localTrack;
        const hostId = window.__testPayload.hostId;
        engine.syncTrackCatalog([localTrack]);

        await store.initialize();
        await store.connectToRememberedHost(hostId);
        await store.loadRemoteLibrary({ forceRefresh: true });

        // Configure Volume, Shuffle, Repeat, EQ, ReplayGain to prove 100% state preservation across handovers
        engine.setVolume(0.72);
        engine.setShuffle(true);
        engine.setRepeatMode('all');
        const dspBefore = engine.getAudioLabSettings();
        engine.setAudioLabSettings({ ...dspBefore, enabled: true });
        await engine.ensureDspReady();

        const allTracks = store.getSnapshot().remoteTracks;
        const byTitle = (t) => allTracks.find((x) => x.title === t);

        // Set an active search filter ("Có Thể") to verify Phase 6.1.3 search preservation across handover!
        await store.searchRemoteLibrary('Có Thể');
        const searchCountBefore = store.getSnapshot().remoteTracks.length;
        // Restore full list to queue all tracks, then re-apply search while playing!
        await store.clearRemoteSearch();

        const handoverMetrics = [];

        async function verifyHandoverOnTrack(title) {
          const dto = byTitle(title);
          await store.playRemoteTrack(dto);
          const compositeId = 'remote::' + hostId + '::' + dto.trackId;
          const started = await waitUntil(() => {
            const pb = engine.getPlaybackState();
            return pb.currentTrackId === compositeId && pb.status === 'playing' && pb.currentTimeSeconds >= 0.35;
          }, 8000);
          if (!started) throw new Error('Track failed initial LAN start: ' + title);

          await engine.seek(2.1);
          await sleep(160);
          const posBeforeLanDrop = engine.getPlaybackState().currentTimeSeconds;
          const t0 = performance.now();

          // Trigger LAN -> Remote Break-Before-Make handover!
          const seqBeforeDrop = store.getSnapshot().clientSnapshot?.handoverSignal?.handoverSeq ?? 0;
          await window.testBridge.ctrl('lan-off');
          const switchedRemote = await waitUntil(() => {
            const snap = store.getSnapshot().clientSnapshot;
            const pb = engine.getPlaybackState();
            return (
              snap?.activeTransport === 'remote-https' &&
              (snap?.handoverSignal?.handoverSeq ?? 0) > seqBeforeDrop &&
              !store.isExecutingPlaybackHandover() &&
              pb.status === 'playing' &&
              pb.currentTimeSeconds >= posBeforeLanDrop - 0.5
            );
          }, 8000);
          const lanToRemoteMs = Math.round(performance.now() - t0);
          await sleep(180);
          const posAfterRemote = engine.getPlaybackState().currentTimeSeconds;
          if (!switchedRemote || engine.getPlaybackState().status !== 'playing' || posAfterRemote <= posBeforeLanDrop - 0.6) {
            throw new Error(title + ' LAN->Remote handover failed: status=' + engine.getPlaybackState().status + ' pos=' + posAfterRemote);
          }

          // Trigger Remote -> LAN Make-Before-Break handover!
          const seqBeforeLanReturn = store.getSnapshot().clientSnapshot?.handoverSignal?.handoverSeq ?? 0;
          const posBeforeLanReturn = engine.getPlaybackState().currentTimeSeconds;
          const t1 = performance.now();
          await window.testBridge.ctrl('lan-on');
          const switchedLan = await waitUntil(() => {
            const snap = store.getSnapshot().clientSnapshot;
            const pb = engine.getPlaybackState();
            return (
              snap?.activeTransport === 'lan-direct' &&
              (snap?.handoverSignal?.handoverSeq ?? 0) > seqBeforeLanReturn &&
              !store.isExecutingPlaybackHandover() &&
              pb.status === 'playing'
            );
          }, 8000);
          const remoteToLanMs = Math.round(performance.now() - t1);
          await sleep(180);
          const posAfterLan = engine.getPlaybackState().currentTimeSeconds;
          if (!switchedLan || engine.getPlaybackState().status !== 'playing' || posAfterLan < posBeforeLanReturn - 0.6) {
            throw new Error(title + ' Remote->LAN handover failed: status=' + engine.getPlaybackState().status + ' pos=' + posAfterLan);
          }

          handoverMetrics.push({
            title,
            lanToRemoteMs,
            remoteToLanMs,
            posBeforeLanDrop,
            posAfterRemote,
            posBeforeLanReturn,
            posAfterLan,
          });
        }

        // 1. Verify handover across FLAC, ALAC "Có Thể (102112 Version)", ALAC 24/48 EOF, WAV, AAC, Hi-Res FLAC!
        for (const title of [
          'FLAC_16_44',
          'Có Thể (102112 Version)',
          'ALAC_24_48_EOF',
          'WAV_16_44',
          'AAC_M4A',
          'HIRES_FLAC_24_96',
        ]) {
          await verifyHandoverOnTrack(title);
        }

        // 2. Verify Remote Library Search preservation across handover
        await store.searchRemoteLibrary('Có Thể');
        const flacDto = byTitle('FLAC_16_44');
        await store.playRemoteTrack(flacDto);
        await waitUntil(() => engine.getPlaybackState().status === 'playing', 5000);

        // 3. Verify User PAUSE intent preserved across handover (paused stays paused!)
        await engine.seek(3.2);
        await sleep(100);
        engine.pause();
        const pausedTime = engine.getPlaybackState().currentTimeSeconds;
        await window.testBridge.ctrl('lan-off');
        await waitUntil(() => store.getSnapshot().clientSnapshot?.activeTransport === 'remote-https', 6000);
        await sleep(200);
        const pbWhilePaused = engine.getPlaybackState();
        const pausePreserved = pbWhilePaused.status === 'paused' && Math.abs(pbWhilePaused.currentTimeSeconds - pausedTime) < 0.6;

        // Resume over Remote HTTPS, Seek, Next, Previous, Lyrics!
        await engine.resume();
        const resumedOk = await waitUntil(() => engine.getPlaybackState().status === 'playing' && engine.getPlaybackState().currentTimeSeconds > pausedTime, 5000);
        const lyrics = await window.testBridge.connectGetRemoteLyrics(hostId, flacDto.trackId);

        // Restore LAN & verify controls preserved
        await window.testBridge.ctrl('lan-on');
        await waitUntil(() => store.getSnapshot().clientSnapshot?.activeTransport === 'lan-direct', 6000);

        const pbFinal = engine.getPlaybackState();
        const ctrlFinal = engine.getPlaybackControls();
        const controlsPreserved =
          Math.abs(pbFinal.volume - 0.72) < 0.01 &&
          ctrlFinal.shuffleEnabled === true &&
          ctrlFinal.repeatMode === 'all' &&
          engine.getAudioLabSettings().enabled === true;

        const searchPreserved =
          store.getSnapshot().remoteSearchQuery === 'Có Thể' &&
          store.getSnapshot().remoteTracks.length === searchCountBefore &&
          searchCountBefore === 1;

        // 4. Switch cleanly to Local Playback!
        await engine.play(localTrack.id);
        const localPlayed = await waitUntil(
          () => engine.getPlaybackState().currentTrackId === localTrack.id && engine.getPlaybackState().status === 'playing',
          5000,
        );
        engine.stop('user-stop');

        return {
          handoverMetrics,
          pausePreserved,
          resumedOk,
          controlsPreserved,
          searchPreserved,
          lyricsLines: lyrics.timedLines.length,
          localPlayed,
          sessions,
        };
      })()
    \`,
    );

    const diag = client.getClientDiagnosticsSnapshot();
    await fs.writeFile(${JSON.stringify(outJson)}, JSON.stringify({ report, diag }, null, 2), 'utf8');
    win.destroy();
    await client.shutdown();
    conn.close();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
`;
    await fs.writeFile(mainDriverTs, mainDriverCode, 'utf8');
    await esbuild.build({
      entryPoints: [mainDriverTs],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      banner: {
        js: `try{module.paths.unshift(${JSON.stringify(path.join(process.cwd(), 'node_modules').replace(/\\/g, '/'))});}catch{}`,
      },
      outfile: mainDriverCjs,
      external: ['electron', 'better-sqlite3', '@mgz-dev/alac', 'music-metadata'],
      loader: { '.ts': 'ts' },
    });

    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const proc = spawn(
        path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
        [mainDriverCjs],
        { cwd: process.cwd(), env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      proc.stderr?.on('data', (c) => {
        stderr += Buffer.isBuffer(c) ? c.toString('utf8') : String(c);
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new Error(`Phase 6.4 Chromium Handover E2E timed out after 60s. stderr=${stderr}`));
      }, 60_000);
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code, stderr });
      });
    });

    assert.equal(child.status, 0, `Phase 6.4 Chromium Handover E2E failed (${child.status}): ${child.stderr}`);
    const parsed = JSON.parse(await fs.readFile(outJson, 'utf8')) as {
      report: {
        handoverMetrics: Array<{
          title: string;
          lanToRemoteMs: number;
          remoteToLanMs: number;
        }>;
        pausePreserved: boolean;
        resumedOk: boolean;
        controlsPreserved: boolean;
        searchPreserved: boolean;
        lyricsLines: number;
        localPlayed: boolean;
        sessions: Array<{ sessionId: string; trackId: string }>;
      };
      diag: {
        smartConnection: {
          recentHandovers: Array<{ outcome: string; positionErrorSec: number | null }>;
        };
      };
    };

    assert.equal(parsed.report.handoverMetrics.length, 6);
    assert.equal(parsed.report.pausePreserved, true, 'Paused track must stay paused across handover');
    assert.equal(parsed.report.resumedOk, true, 'Resuming after paused handover must succeed');
    assert.equal(parsed.report.controlsPreserved, true, 'Volume/Shuffle/Repeat/EQ must remain intact across handovers');
    assert.equal(parsed.report.searchPreserved, true, 'Remote Library search state must remain intact across handovers');
    assert.ok(parsed.report.lyricsLines >= 2, 'Remote Lyrics must remain retrievable across handovers');
    assert.equal(parsed.report.localPlayed, true, 'Switching back to Local Playback must succeed cleanly');
    assert.ok(parsed.diag.smartConnection.recentHandovers.length >= 12);
    assert.ok(
      parsed.diag.smartConnection.recentHandovers.every((h) => h.outcome === 'completed'),
      'All recorded handovers must complete cleanly',
    );
    // Verify zero duplicate session IDs for any single continuous track play
    const uniqueSessionIds = new Set(parsed.report.sessions.map((s) => s.sessionId));
    assert.equal(uniqueSessionIds.size, parsed.report.sessions.length);
  } finally {
    await prepClientRef?.shutdown().catch(() => {});
    if (!clientConnClosed) {
      try {
        clientConn.close();
      } catch {
        // ignore
      }
    }
    for (const s of activeLanSockets) s.destroy();
    await new Promise<void>((r) => lanGateServer.close(() => r()));
    await new Promise<void>((r) => ctrlServer.close(() => r()));
    await proxy?.close().catch(() => {});
    await host.stop().catch(() => {});
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
