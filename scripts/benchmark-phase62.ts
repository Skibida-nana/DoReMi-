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
import {
  PAIRING_PAYLOAD_MAX_BYTES,
  parseAndValidatePairingPayload,
} from '../src/shared/contracts/connect-pairing';

async function measure(label: string, fn: () => Promise<void>) {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  await fn();
  const elapsedMs = Math.max(0.1, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  const cpuPct = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * logicalCpus)) * 100;
  return {
    label,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    cpuPercentOfLogicalCapacity: Number(cpuPct.toFixed(2)),
    rssMbBefore: Number((memBefore.rss / (1024 * 1024)).toFixed(2)),
    rssMbAfter: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMbAfter: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p62-bench-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  const clientDir = path.join(tmpRoot, 'clientdata');
  const musicDir = path.join(tmpRoot, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const songPath = path.join(musicDir, 'Bench62-4MB.flac');
  await fs.writeFile(songPath, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(4 * 1024 * 1024)]));

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
      title: 'Bench Security Track',
      artist: 'Bench Artist',
      album: 'Phase 6.2 Bench',
      duration_ms: 180_000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 44100,
      bit_depth: 16,
      bitrate_bps: 900_000,
      file_size_bytes: 4 * 1024 * 1024 + 4,
      modified_at_ms: Date.now(),
      status: 'available',
    },
  ]);

  const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });
  const lyricsService = new LyricsService({ trackRepo, lyricsRepo });
  const connectRepo = new ConnectRepository(conn.db);
  const secrets = new ConnectSecretStorage({ userDataDir });
  connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
  connectRepo.addSharedSource(root.id);

  const host = new ConnectHostService({
    appVersion: '1.0.0-rc.6',
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService,
    lyricsService,
    secrets,
    enableMdns: false,
  });

  const clientSecrets = new ConnectSecretStorage({ userDataDir: clientDir });
  const clientConn = openLibraryDatabase(path.join(clientDir, 'client.db'));
  const clientRepo = new ConnectRepository(clientConn.db);
  const client = new ConnectClientService({ connectRepo: clientRepo, secrets: clientSecrets });

  const results: Array<Record<string, unknown>> = [];

  try {
    await host.start();
    let payloadStr = '';

    results.push(
      await measure('1_qr_invitation_and_svg_generation_x10', async () => {
        for (let i = 0; i < 10; i += 1) {
          const inv = host.createInvitation({ autoApproveSingleUse: true });
          payloadStr = inv.pairingPayload;
          if (Buffer.byteLength(payloadStr, 'utf8') > PAIRING_PAYLOAD_MAX_BYTES) {
            throw new Error('Payload exceeded 2048 B');
          }
        }
      }),
    );

    results.push(
      await measure('2_pairing_payload_parse_validate_x500', async () => {
        for (let i = 0; i < 500; i += 1) {
          const res = parseAndValidatePairingPayload(payloadStr);
          if (!res.ok) throw new Error(res.message);
        }
      }),
    );

    results.push(
      await measure('3_qr_payload_enroll_and_connect', async () => {
        const snap = await client.enrollFromPairingPayload({
          rawPayload: payloadStr,
          deviceName: 'Bench Client',
        });
        if (snap.status !== 'connected') {
          throw new Error(`Expected connected, got ${snap.status}`);
        }
      }),
    );

    results.push(
      await measure('4_credential_rotation_x5', async () => {
        for (let i = 0; i < 5; i += 1) {
          await client.rotateActiveHostCredential();
        }
      }),
    );

    results.push(
      await measure('5_rate_limit_auth_flood_20_attempts', async () => {
        const port = host.getSnapshot().listeningPort!;
        for (let i = 0; i < 20; i += 1) {
          await new Promise<void>((resolve) => {
            const req = https.request(
              {
                host: '127.0.0.1',
                port,
                path: '/api/v1/library/summary',
                method: 'GET',
                headers: { Authorization: 'Bearer 00000000-0000-4000-8000-000000000000.bad' },
                rejectUnauthorized: false,
                agent: false,
              },
              (res) => {
                res.resume();
                res.on('end', resolve);
              },
            );
            req.on('error', () => resolve());
            req.end();
          });
        }
      }),
    );

    const outDir = path.join(process.cwd(), 'qa', 'logs');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, 'phase62-benchmark-latest.json');
    const summary = {
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      logicalCpus: os.cpus().length,
      scenarios: results,
    };
    await fs.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.disconnect().catch(() => {});
    clientConn.close();
    await host.stop();
    conn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
