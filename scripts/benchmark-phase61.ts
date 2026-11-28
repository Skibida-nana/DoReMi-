import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
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
import { normalizeTrackPath } from '../src/main/services/path-utils';

function streamLoopback(port: number, trackId: string, token: string, range?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/stream/${trackId}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(range ? { Range: range } : {}),
        },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
        });
        res.on('end', () => resolve(bytes));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function sampleScenario(label: string, fn: () => Promise<void>) {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  await fn();
  const elapsedMs = Math.max(1, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const cpuPct = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * logicalCpus)) * 100;
  return {
    label,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    cpuPercentOfLogicalCapacity: Number(cpuPct.toFixed(2)),
    rssMbBefore: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
    rssMbAfter: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMbAfter: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p61-bench-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  // 8 MB synthetic FLAC fixture
  const fixtureBytes = Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(8 * 1024 * 1024)]);
  const songPath = path.join(musicDir, 'Bench-8MB.flac');
  await fs.writeFile(songPath, fixtureBytes);

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
      title: 'Bench FLAC',
      artist: 'Bench',
      album: 'Bench',
      duration_ms: 240_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 1_000_000,
      file_size_bytes: fixtureBytes.length,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);
  const track = trackRepo.findAll()[0];
  const connectRepo = new ConnectRepository(conn.db);
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.2',
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir }),
    lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
    secrets: new ConnectSecretStorage({ userDataDir }),
    enableMdns: false,
  });
  host.addSharedSource(root.id);

  // Enroll 3 distinct client devices
  const tokens: string[] = [];
  const snap = await host.start();
  const port = snap.listeningPort!;
  for (let i = 1; i <= 3; i += 1) {
    const cDir = path.join(tmpRoot, `c-${i}`);
    const cDb = openLibraryDatabase(path.join(cDir, 'c.db'));
    const cSec = new ConnectSecretStorage({ userDataDir: cDir });
    const cSvc = new ConnectClientService({
      connectRepo: new ConnectRepository(cDb.db),
      secrets: cSec,
    });
    const probe = await cSvc.probeHost('127.0.0.1', port);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await cSvc.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: `Bench Client ${i}`,
    });
    tokens.push(cSec.getSecret(`client.host.${snap.identity!.hostId}.token`)!);
    await cSvc.disconnect();
    cDb.close();
  }
  await host.stop();

  const results: unknown[] = [];

  results.push(
    await sampleScenario('Host OFF (baseline idle 500ms)', async () => {
      await new Promise((r) => setTimeout(r, 500));
    }),
  );

  await host.start();
  const activePort = host.getSnapshot().listeningPort!;

  results.push(
    await sampleScenario('Host STANDBY (idle 500ms)', async () => {
      await new Promise((r) => setTimeout(r, 500));
    }),
  );

  results.push(
    await sampleScenario('1 Client 8MB FLAC loopback stream', async () => {
      const bytes = await streamLoopback(activePort, track.id, tokens[0]);
      if (bytes !== fixtureBytes.length) throw new Error(`Expected ${fixtureBytes.length}, got ${bytes}`);
    }),
  );

  results.push(
    await sampleScenario('3 Simultaneous Clients 8MB FLAC loopback stream', async () => {
      const sizes = await Promise.all(
        tokens.map((tok) => streamLoopback(activePort, track.id, tok)),
      );
      if (sizes.some((s) => s !== fixtureBytes.length)) {
        throw new Error('Mismatch in 3-client stream bytes');
      }
    }),
  );

  results.push(
    await sampleScenario('Rapid Range Seeking (20 partial requests)', async () => {
      for (let i = 0; i < 20; i += 1) {
        const start = i * 262144;
        await streamLoopback(activePort, track.id, tokens[0], `bytes=${start}-${start + 65535}`);
      }
    }),
  );

  results.push(
    await sampleScenario('Repeated Host ON/OFF (10 cycles)', async () => {
      for (let i = 0; i < 10; i += 1) {
        await host.stop();
        await host.start();
      }
    }),
  );

  await host.stop();

  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)),
    },
    methodology:
      'In-process Electron-Node loopback HTTPS TLS streaming of 8 MB synthetic FLAC fixture with process.cpuUsage() normalized to logical CPU count and process.memoryUsage() RSS/Heap.',
    scenarios: results,
    finalHostState: host.getSnapshot().state,
  };

  console.log(JSON.stringify(report, null, 2));

  conn.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

void main();
