import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { AlacStreamManager } from '../src/main/services/alac-decoder';
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

const REMOTE_HOSTNAME = 'doremi-home.tail8888.ts.net';

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

function createToneWavBuffer(durationSec: number, sampleRate: number, bits: 16 | 24): Buffer {
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
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
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

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

test('Phase 6.3 Remote HTTPS E2E: Original-byte FLAC/WAV/ALAC/AAC/MP3/OGG/Opus transport, ALAC PCM parity & Chromium playback', async (t) => {
  const ffmpeg = findFfmpegPath();
  if (!ffmpeg) {
    t.skip('ffmpeg binary not available for Remote HTTPS audio fixture synthesis');
    return;
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p63-e2e-'));
  const hostDir = path.join(tmpRoot, 'host');
  const clientDir = path.join(tmpRoot, 'client');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const w16 = path.join(musicDir, '01-wav-16.wav');
  const w24 = path.join(musicDir, '02-wav-24-48.wav');
  const w96 = path.join(musicDir, '03-wav-24-96.wav');
  const flac = path.join(musicDir, '04-flac-16.flac');
  const flac24_96 = path.join(musicDir, '05-flac-24-96.flac');
  const mp3 = path.join(musicDir, '06-mp3.mp3');
  const aac = path.join(musicDir, '07-aac-eof.m4a');
  const ogg = path.join(musicDir, '08-vorbis.ogg');
  const opus = path.join(musicDir, '09-opus.opus');
  const alac16 = path.join(musicDir, '10-alac-16.m4a');
  const alac24 = path.join(musicDir, '11-alac-24-48.m4a');
  const alacEof = path.join(musicDir, '12-alac-eof.m4a');

  await fs.writeFile(w16, createToneWavBuffer(8, 44100, 16));
  await fs.writeFile(w24, createToneWavBuffer(8, 48000, 24));
  await fs.writeFile(w96, createToneWavBuffer(4, 96000, 24));
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w16, '-c:a', 'flac', flac]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w96, '-c:a', 'flac', flac24_96]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w16, '-c:a', 'libmp3lame', '-b:a', '192k', mp3]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w16, '-c:a', 'aac', '-b:a', '192k', aac]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w16, '-c:a', 'libvorbis', '-q:a', '4', ogg]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w24, '-c:a', 'libopus', '-b:a', '128k', opus]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w16, '-c:a', 'alac', '-movflags', '+faststart', alac16]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w24, '-c:a', 'alac', '-movflags', '+faststart', alac24]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', w24, '-c:a', 'alac', alacEof]);

  await fs.writeFile(path.join(musicDir, '04-flac-16.lrc'), '[00:01.00] Remote Lyrics Line\n', 'utf8');

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  const defs = [
    { p: w16, title: 'WAV16', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16 },
    { p: flac, title: 'FLAC16', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
    { p: flac24_96, title: 'FLAC24_96', codec: 'FLAC', container: 'FLAC', sr: 96000, bits: 24 },
    { p: mp3, title: 'MP3', codec: 'MP3', container: 'MP3', sr: 44100, bits: null },
    { p: aac, title: 'AAC', codec: 'AAC', container: 'M4A', sr: 44100, bits: null },
    { p: ogg, title: 'OGG', codec: 'VORBIS', container: 'OGG', sr: 44100, bits: null },
    { p: opus, title: 'OPUS', codec: 'OPUS', container: 'OPUS', sr: 48000, bits: null },
    { p: alac16, title: 'ALAC16', codec: 'ALAC', container: 'M4A', sr: 44100, bits: 16 },
    { p: alac24, title: 'ALAC24_48', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
    { p: alacEof, title: 'ALAC_EOF', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
  ];
  const rows = [];
  for (const d of defs) {
    const st = await fs.stat(d.p);
    rows.push({
      original_path: d.p,
      normalized_path: normalizeTrackPath(d.p),
      title: d.title,
      artist: 'Remote E2E',
      album: 'Phase 6.3 Album',
      duration_ms: d.title === 'FLAC24_96' ? 4000 : 8000,
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
  const tracks = trackRepo.findAll();

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, remotePublicPort: 443 });
  hostRepo.addSharedSource(root.id);
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.7',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir }),
    remoteProvider: new TailscaleFunnelProvider({ cli: createMockFunnelCli() }),
    enableMdns: false,
  });

  const ca = createIsolatedTestCa();
  const leaf = ca.issueLeafCert({ dnsNames: [REMOTE_HOSTNAME] });

  let proxy: { port: number; close(): Promise<void> } | null = null;
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));

  try {
    await host.start();
    const enabled = await host.enableRemoteAccess({ confirmPublicExposure: true, preferredPublicPort: 443 });
    assert.equal(enabled.remoteAccess?.state, 'READY');
    proxy = await startSimulatedFunnelTlsProxy({
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      mountPath: '/doremi-connect',
      localGatewayPort: enabled.remoteAccess!.gatewayListeningPort!,
    });

    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
      publicHttpsOptions: {
        ca: ca.caCertPem,
        lookup: createLoopbackLookup(REMOTE_HOSTNAME),
        connectOverridePort: proxy.port,
      },
    });

    const lanPort = host.getSnapshot().listeningPort!;
    const hostId = enabled.identity!.hostId;
    const probe = await client.probeHost('127.0.0.1', lanPort);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: lanPort,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Remote Playback Client',
    });

    const devId = host.getSnapshot().authorizedDevices[0].deviceId;
    host.setDeviceRemoteAccess(devId, true);
    await client.syncRemoteAccessOverLan(hostId);

    // Explicitly switch to Remote HTTPS!
    const remSnap = await client.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
    assert.equal(remSnap.status, 'connected');
    assert.equal(remSnap.activeTransport, 'remote-https');

    const page = await client.listRemoteTracks({ limit: 50 });
    assert.equal(page.items.length, defs.length);

    // 1. Original-byte integrity over Remote HTTPS (FLAC 24/96 & WAV)
    for (const checkDef of [
      { title: 'FLAC16', srcPath: flac },
      { title: 'FLAC24_96', srcPath: flac24_96 },
      { title: 'WAV16', srcPath: w16 },
    ]) {
      const dto = tracks.find((x) => x.title === checkDef.title)!;
      const url = buildRemoteTrackMediaUrl(hostId, dto.id);
      const resp = await client.resolveRemoteTrackMediaResponse(new Request(url));
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('x-doremi-transfer-mode'), 'direct-original');
      const streamed = Buffer.from(await resp.arrayBuffer());
      const disk = await fs.readFile(checkDef.srcPath);
      assert.equal(sha256(streamed), sha256(disk), `${checkDef.title} bytes must match disk byte-for-byte over Remote HTTPS`);
    }

    // 2. Lyrics retrieval over Remote HTTPS (sidecarPath stripped)
    const flacTrack = tracks.find((x) => x.title === 'FLAC16')!;
    const lyrics = await client.getRemoteLyrics(hostId, flacTrack.id);
    assert.equal(lyrics.source, 'sidecar');
    assert.equal(lyrics.sidecarPath, null);
    assert.ok(lyrics.timedLines.length > 0);

    // 3. ALAC 16-bit & 24-bit Range WASM bit-exact PCM parity over Remote HTTPS
    const localAlac = new AlacStreamManager({ maxOpenTracks: 2 });
    for (const item of [
      { title: 'ALAC16', filePath: alac16 },
      { title: 'ALAC24_48', filePath: alac24 },
      { title: 'ALAC_EOF', filePath: alacEof },
    ]) {
      const dto = tracks.find((x) => x.title === item.title)!;
      const localResp = await localAlac.resolveAlacWavResponse(
        new Request(`lossless-media://track/${dto.id}`),
        item.filePath,
        {},
      );
      assert.ok(localResp && localResp.status === 200, `${item.title}: local ALAC must resolve`);
      const remoteResp = await client.resolveRemoteTrackMediaResponse(
        new Request(buildRemoteTrackMediaUrl(hostId, dto.id)),
      );
      assert.equal(remoteResp.status, 200);
      assert.equal(remoteResp.headers.get('content-type'), 'audio/wav');
      const localWav = Buffer.from(await localResp.arrayBuffer());
      const remoteWav = Buffer.from(await remoteResp.arrayBuffer());
      assert.equal(sha256(remoteWav), sha256(localWav), `${item.title} Remote HTTPS WAV PCM parity mismatch`);

      // Partial 206 seek range
      const seekResp = await client.resolveRemoteTrackMediaResponse(
        new Request(buildRemoteTrackMediaUrl(hostId, dto.id), {
          headers: { Range: 'bytes=65536-131071' },
        }),
      );
      assert.equal(seekResp.status, 206);
      const seekSlice = Buffer.from(await seekResp.arrayBuffer());
      assert.equal(sha256(seekSlice), sha256(localWav.subarray(65536, 131072)));
    }
    localAlac.dispose();

    // 4. Real Chromium <audio> + AudioContext Remote HTTPS E2E playback child check across codecs
    await client.disconnect();
    const outJson = path.join(tmpRoot, 'remote-e2e-chromium.json');
    const driverTs = path.join(tmpRoot, 'remote-e2e-driver.ts');
    const driverCjs = path.join(tmpRoot, 'remote-e2e-driver.cjs');
    const selectedTitles = ['WAV16', 'FLAC16', 'FLAC24_96', 'MP3', 'AAC', 'OGG', 'OPUS', 'ALAC16', 'ALAC24_48'];
    const urlMap = Object.fromEntries(
      selectedTitles.map((title) => {
        const dto = tracks.find((x) => x.title === title)!;
        return [title, buildRemoteTrackMediaUrl(hostId, dto.id)];
      }),
    );

    const driverCode = `
import { app, BrowserWindow, session } from 'electron';
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
    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(conn.db),
      secrets: new ConnectSecretStorage({ userDataDir: ${JSON.stringify(clientDir)}, allowFileFallback: true }),
      publicHttpsOptions: {
        ca: ${JSON.stringify(ca.caCertPem)},
        lookup: createLoopbackLookup(${JSON.stringify(REMOTE_HOSTNAME)}),
        connectOverridePort: ${proxy.port},
      },
    });
    const snap = await client.connectToRememberedHost(${JSON.stringify(hostId)}, undefined, undefined, 'remote-https');
    if (snap.status !== 'connected' || snap.activeTransport !== 'remote-https') {
      throw new Error('Failed remote-https connect in Chromium child: ' + snap.lastError);
    }
    await client.listRemoteTracks({ limit: 50 });
    registerAudioProtocolHandler({ trackRepo: new TrackRepository(conn.db), connectClientService: client });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': ["default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:;"],
          },
        });
        return;
      }
      callback({ responseHeaders: details.responseHeaders });
    });

    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const htmlPath = path.join(${JSON.stringify(tmpRoot)}, 're2e.html');
    await fs.writeFile(htmlPath, '<!doctype html><html><body></body></html>', 'utf8');
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript(\`
      window.__a = new Audio();
      window.__a.crossOrigin = 'anonymous';
      window.__a.preload = 'metadata';
      window.__ctx = new AudioContext();
      window.__src = window.__ctx.createMediaElementSource(window.__a);
      window.__src.connect(window.__ctx.destination);
      true;
    \`);

    const urlMap = ${JSON.stringify(urlMap)};
    const results = [];
    for (const [title, mediaUrl] of Object.entries(urlMap)) {
      const res = await win.webContents.executeJavaScript(\`
        new Promise((resolve) => {
          const a = window.__a;
          const ctx = window.__ctx;
          const done = (ok, detail) => {
            clearTimeout(timer);
            a.oncanplay = null;
            a.onerror = null;
            resolve({ ok, detail: detail + (a.error ? ' code=' + a.error.code + ' ' + a.error.message : '') });
          };
          const timer = setTimeout(() => done(false, 'TIMEOUT'), 8000);
          a.onerror = () => done(false, 'MEDIA_ERROR');
          let ran = false;
          a.oncanplay = async () => {
            if (ran) return;
            ran = true;
            try {
              if (ctx.state === 'suspended') await ctx.resume();
              await a.play();
              setTimeout(() => {
                a.currentTime = 2.0;
                setTimeout(() => {
                  const ok = !a.paused && a.currentTime >= 1.8 && a.duration > 3.0;
                  done(ok, ok ? 'REMOTE_PLAY_SEEK_OK t=' + a.currentTime.toFixed(2) : 'BAD_TIME t=' + a.currentTime);
                }, 250);
              }, 200);
            } catch (e) {
              done(false, 'EXC:' + String(e));
            }
          };
          a.src = \${JSON.stringify(mediaUrl)};
          a.load();
        })
      \`);
      results.push({ title, ok: res.ok, detail: res.detail });
    }
    await fs.writeFile(${JSON.stringify(outJson)}, JSON.stringify({ results, diag: client.getClientDiagnosticsSnapshot() }, null, 2));
    win.destroy();
    await client.disconnect();
    conn.close();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
`;
    await fs.writeFile(driverTs, driverCode, 'utf8');
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [driverTs],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      banner: {
        js: `try{module.paths.unshift(${JSON.stringify(path.join(process.cwd(), 'node_modules').replace(/\\/g, '/'))});}catch{}`,
      },
      outfile: driverCjs,
      external: ['electron', 'better-sqlite3', '@mgz-dev/alac', 'music-metadata'],
      loader: { '.ts': 'ts' },
    });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const proc = spawn(
        path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
        [driverCjs],
        { cwd: process.cwd(), env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      proc.stderr?.on('data', (chunk) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new Error(`Chromium Remote HTTPS E2E timed out after 45s. stderr=${stderr}`));
      }, 45_000);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code, stderr });
      });
    });
    assert.equal(child.status, 0, `Chromium Remote HTTPS E2E exited ${child.status}: ${child.stderr}`);
    const parsedOut = JSON.parse(await fs.readFile(outJson, 'utf8')) as {
      results: Array<{ title: string; ok: boolean; detail: string }>;
      diag: { activeTransport: string | null; recentTraces: Array<{ transport?: string }> };
    };
    for (const r of parsedOut.results) {
      assert.equal(r.ok, true, `Chromium Remote HTTPS playback failed for ${r.title}: ${r.detail}`);
    }
    assert.ok(parsedOut.diag.recentTraces.some((tr) => tr.transport === 'remote-https'));

    // 5. Disable Remote Access cleanly closes Gateway & terminates Remote while preserving LAN Direct!
    await client.connectToRememberedHost(hostId, undefined, undefined, 'remote-https');
    const afterDisable = await host.disableRemoteAccess();
    assert.equal(afterDisable.remoteAccess?.state, 'DISABLED');
    assert.equal(afterDisable.remoteAccess?.gatewayListeningPort, null);
    assert.equal(afterDisable.state, 'STANDBY');

    const disabledStreamResp = await client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, flacTrack.id)),
    );
    assert.ok(disabledStreamResp.status >= 400);

    // Reconnecting over explicit LAN still works cleanly!
    const lanBack = await client.connectToRememberedHost(hostId, undefined, undefined, 'lan-direct');
    assert.equal(lanBack.status, 'connected');
    assert.equal(lanBack.activeTransport, 'lan-direct');
    await client.disconnect();
  } finally {
    await proxy?.close().catch(() => {});
    await host.stop();
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
