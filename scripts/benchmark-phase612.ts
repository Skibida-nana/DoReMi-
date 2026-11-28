import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { LyricsService } from '../src/main/services/lyrics-service';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import { buildRemoteTrackMediaUrl } from '../src/shared/contracts/media-protocol';

function findFfmpegPath(): string {
  const candidates = [
    process.env.DOREMI_REAL_FFMPEG_DIR
      ? path.join(process.env.DOREMI_REAL_FFMPEG_DIR, 'ffmpeg.exe')
      : null,
    'D:/Dowload/FFmpeg/ffmpeg-2026-11-23-git-05c674c913-full_build/bin/ffmpeg.exe',
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  throw new Error('FFmpeg binary not found for benchmark-phase612');
}

function makeWav(durationSec: number, sr: number, bits: 16 | 24): Buffer {
  const ch = 2;
  const bps = bits / 8;
  const frames = Math.round(sr * durationSec);
  const data = frames * ch * bps;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * bps, 28);
  buf.writeUInt16LE(ch * bps, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  let off = 44;
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000);
    for (let c = 0; c < ch; c += 1) {
      if (bits === 16) buf.writeInt16LE(v, off);
      else {
        const s24 = v << 8;
        buf[off] = s24 & 0xff;
        buf[off + 1] = (s24 >> 8) & 0xff;
        buf[off + 2] = (s24 >> 16) & 0xff;
      }
      off += bps;
    }
  }
  return buf;
}

async function measure(label: string, fn: () => Promise<number>) {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  const bytes = await fn();
  const elapsedMs = Math.max(0.5, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const cpus = Math.max(1, os.cpus().length || 1);
  const cpuPercent = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * cpus)) * 100;
  return {
    label,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    bytesDelivered: bytes,
    cpuPercentLogical: Number(cpuPercent.toFixed(2)),
    rssMbBefore: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
    rssMbAfter: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMbAfter: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

async function consumeResponseBytes(resp: Response): Promise<number> {
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const ab = await resp.arrayBuffer();
  return ab.byteLength;
}

async function main() {
  const ffmpeg = findFfmpegPath();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p612-bench-'));
  const musicDir = path.join(tmpRoot, 'music');
  const hostDir = path.join(tmpRoot, 'host-ud');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(hostDir, { recursive: true });

  const w16 = path.join(musicDir, 'bench-16.wav');
  const w2496 = path.join(musicDir, 'bench-24-96.wav');
  const flac16 = path.join(musicDir, 'bench-16.flac');
  const flac2496 = path.join(musicDir, 'bench-24-96.flac');
  const aac = path.join(musicDir, 'bench-aac.m4a');
  const alac16 = path.join(musicDir, 'bench-alac16.m4a');
  const alac24 = path.join(musicDir, 'bench-alac24.m4a');
  const alacEof = path.join(musicDir, 'bench-alac-eof.m4a');

  await fs.writeFile(w16, makeWav(12, 44100, 16));
  await fs.writeFile(w2496, makeWav(8, 96000, 24));
  execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'flac', flac16], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', w2496, '-c:a', 'flac', flac2496], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'aac', '-b:a', '192k', aac], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'alac', '-movflags', '+faststart', alac16], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', w2496, '-c:a', 'alac', '-sample_fmt', 's32p', '-ar', '48000', '-movflags', '+faststart', alac24], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', w2496, '-c:a', 'alac', '-sample_fmt', 's32p', '-ar', '48000', alacEof], { stdio: 'ignore' });

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const trackRepo = new TrackRepository(hostConn.db);
  const rootRepo = new LibraryRootRepository(hostConn.db);
  const artworkRepo = new ArtworkRepository(hostConn.db);
  const lyricsRepo = new LyricsRepository(hostConn.db);
  const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

  const defs = [
    { p: w16, title: 'WAV_16', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16 },
    { p: flac16, title: 'FLAC_16', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
    { p: flac2496, title: 'FLAC_24_96', codec: 'FLAC', container: 'FLAC', sr: 96000, bits: 24 },
    { p: aac, title: 'AAC_EOF', codec: 'AAC', container: 'M4A', sr: 44100, bits: null },
    { p: alac16, title: 'ALAC_16', codec: 'ALAC', container: 'M4A', sr: 44100, bits: 16 },
    { p: alac24, title: 'ALAC_24_48', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
    { p: alacEof, title: 'ALAC_EOF', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
  ];
  const rows = [];
  for (const d of defs) {
    const st = await fs.stat(d.p);
    rows.push({
      original_path: d.p,
      normalized_path: normalizeTrackPath(d.p),
      title: d.title,
      artist: 'Bench',
      album: 'Bench',
      duration_ms: 10000,
      codec: d.codec,
      container: d.container,
      sample_rate_hz: d.sr,
      bit_depth: d.bits,
      bitrate_bps: 1_500_000,
      file_size_bytes: st.size,
      modified_at_ms: Math.round(st.mtimeMs),
      status: 'available' as const,
    });
  }
  trackRepo.upsertBatch(rows);
  const tracks = trackRepo.findAll();

  const hostRepo = new ConnectRepository(hostConn.db);
  hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });
  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.4',
    userDataDir: hostDir,
    connectRepo: hostRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir: hostDir }),
    enableMdns: false,
  });
  host.addSharedSource(root.id);

  const scenarios: unknown[] = [];
  scenarios.push(
    await measure('host_off_idle_500ms', async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 0;
    }),
  );

  const snap = await host.start();
  const port = snap.listeningPort!;
  const hostId = snap.identity!.hostId;

  scenarios.push(
    await measure('host_standby_idle_500ms', async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 0;
    }),
  );

  const clients: ConnectClientService[] = [];
  const clientDbs: Array<{ close: () => void }> = [];
  for (let i = 1; i <= 3; i += 1) {
    const cDir = path.join(tmpRoot, `client-${i}`);
    await fs.mkdir(cDir, { recursive: true });
    const dbConn = openLibraryDatabase(path.join(cDir, 'library.db'));
    clientDbs.push(dbConn);
    const cli = new ConnectClientService({
      connectRepo: new ConnectRepository(dbConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: cDir }),
    });
    const probe = await cli.probeHost('127.0.0.1', port);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await cli.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: `BenchClient-${i}`,
    });
    await cli.listRemoteTracks({ limit: 50 });
    clients.push(cli);
  }

  for (const title of ['WAV_16', 'FLAC_16', 'FLAC_24_96', 'AAC_EOF', 'ALAC_16', 'ALAC_24_48', 'ALAC_EOF']) {
    const t = tracks.find((x) => x.title === title)!;
    scenarios.push(
      await measure(`stream_full_${title}`, async () =>
        consumeResponseBytes(
          await clients[0].resolveRemoteTrackMediaResponse(
            new Request(buildRemoteTrackMediaUrl(hostId, t.id)),
          ),
        ),
      ),
    );
  }

  const alac24Track = tracks.find((x) => x.title === 'ALAC_24_48')!;
  scenarios.push(
    await measure('alac_24_48_seek_range', async () =>
      consumeResponseBytes(
        await clients[0].resolveRemoteTrackMediaResponse(
          new Request(buildRemoteTrackMediaUrl(hostId, alac24Track.id), {
            headers: { Range: 'bytes=524288-589823' },
          }),
        ),
      ),
    ),
  );

  // 3 simultaneous clients (FLAC + WAV + ALAC)
  const tWav = tracks.find((x) => x.title === 'WAV_16')!;
  const tFlac = tracks.find((x) => x.title === 'FLAC_24_96')!;
  scenarios.push(
    await measure('concurrent_3_clients_mixed_formats', async () => {
      const sizes = await Promise.all([
        consumeResponseBytes(await clients[0].resolveRemoteTrackMediaResponse(new Request(buildRemoteTrackMediaUrl(hostId, tFlac.id)))),
        consumeResponseBytes(await clients[1].resolveRemoteTrackMediaResponse(new Request(buildRemoteTrackMediaUrl(hostId, tWav.id)))),
        consumeResponseBytes(await clients[2].resolveRemoteTrackMediaResponse(new Request(buildRemoteTrackMediaUrl(hostId, alac24Track.id)))),
      ]);
      return sizes.reduce((a, b) => a + b, 0);
    }),
  );

  // Stability soak: 30 rapid track switches + 15 Host start/stop cycles
  scenarios.push(
    await measure('soak_30_track_switches', async () => {
      let total = 0;
      for (let i = 0; i < 30; i += 1) {
        const t = tracks[i % tracks.length];
        total += await consumeResponseBytes(
          await clients[0].resolveRemoteTrackMediaResponse(
            new Request(buildRemoteTrackMediaUrl(hostId, t.id), {
              headers: { Range: 'bytes=0-32767' },
            }),
          ),
        );
      }
      return total;
    }),
  );

  scenarios.push(
    await measure('soak_15_host_toggles', async () => {
      for (let i = 0; i < 15; i += 1) {
        await host.stop();
        await host.start();
      }
      return 0;
    }),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      totalRamGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
    },
    scenarios,
  };

  await fs.mkdir(path.join(process.cwd(), 'qa', 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'qa', 'logs', 'phase612-benchmark-latest.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));

  for (const c of clients) await c.disconnect();
  await host.stop();
  for (const db of clientDbs) db.close();
  hostConn.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

void main();
