import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openLibraryDatabase } from '../src/main/database/connection';
import {
  createDatabaseSnapshotBackup,
  verifyDatabaseIntegrity,
} from '../src/main/database/integrity';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LibraryService } from '../src/main/services/library-service';
import { ProfileService } from '../src/main/services/profile-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import { PlaybackQueueController } from '../src/renderer/src/player/playback-queue';
import { computeQueueWindowSlice } from '../src/renderer/src/utils/queue-virtualization';
import {
  matchesVietnameseQuery,
  normalizeVietnameseText,
} from '../src/renderer/src/utils/vietnamese-search';
import { naturalCompare } from '../src/shared/utils/natural-sort';

function fmt(n: number): number {
  return Number(n.toFixed(2));
}

function mb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function maybeGc(): void {
  const maybeGlobalGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGlobalGc === 'function') {
    maybeGlobalGc();
  }
}

function seedTracks(dbPath: string, userDataDir: string, count: number) {
  const dbConn = openLibraryDatabase(dbPath);
  const db = dbConn.db;
  const cacheDir = path.join(userDataDir, 'artwork-cache');
  const thumbDir = path.join(userDataDir, 'artwork-thumbs');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const sharedHash = 'p52hash000111222';
  const sharedCacheFile = `${sharedHash}.jpg`;
  fs.writeFileSync(path.join(cacheDir, sharedCacheFile), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(thumbDir, `${sharedHash}.thumb.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const insertTrack = db.prepare(`
    INSERT INTO tracks (
      id, original_path, normalized_path, file_name, title, artist, album, genre, year,
      album_artist, track_number, duration_ms, codec, container, sample_rate_hz,
      bit_depth, bitrate_bps, file_size_bytes, modified_at_ms, status,
      availability_state, metadata_version, added_at, updated_at
    ) VALUES (
      @id, @original_path, @normalized_path, @file_name, @title, @artist, @album, @genre, @year,
      @album_artist, @track_number, @duration_ms, @codec, @container, @sample_rate_hz,
      @bit_depth, @bitrate_bps, @file_size_bytes, @modified_at_ms, 'available',
      'available', 2, @now, @now
    )
  `);

  const insertArtwork = db.prepare(`
    INSERT INTO track_artwork (
      track_id, embedded_cache_file, embedded_mime, embedded_hash, source_mtime_ms, updated_at
    ) VALUES (
      @track_id, @embedded_cache_file, 'image/jpeg', @embedded_hash, @mtime_ms, @now
    )
  `);

  const artists = ['Đen Vâu', 'Ngọt', 'Trịnh Công Sơn', 'Yorushika', '宇多田ヒカル', 'Pink Floyd', 'Miles Davis', 'Daft Punk'];
  const now = new Date().toISOString();

  db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) {
      const id = crypto.randomUUID();
      const artist = artists[i % artists.length];
      const fileName = `Track_${String(i).padStart(5, '0')}.flac`;
      const origPath = `C:\\MusicP52\\Dir${Math.floor(i / 250)}\\${fileName}`;
      insertTrack.run({
        id,
        original_path: origPath,
        normalized_path: origPath.toLowerCase(),
        file_name: fileName,
        title: `Bài hát số ${i + 1} - Ánh Trăng Mùa Thu`,
        artist,
        album: `Album ${String(Math.floor(i / 12) + 1).padStart(4, '0')} - Ký ức`,
        genre: i % 3 === 0 ? 'Lossless Acoustic' : 'Jazz',
        year: 2015 + (i % 10),
        album_artist: artist,
        track_number: (i % 12) + 1,
        duration_ms: 215000 + (i % 60) * 1000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: i % 4 === 0 ? 96000 : 44100,
        bit_depth: i % 4 === 0 ? 24 : 16,
        bitrate_bps: i % 4 === 0 ? 2800000 : 950000,
        file_size_bytes: 32_000_000 + i * 1024,
        modified_at_ms: 1700000000000 + i,
        now,
      });

      if (i % 2 === 0) {
        insertArtwork.run({
          track_id: id,
          embedded_cache_file: sharedCacheFile,
          embedded_hash: sharedHash,
          mtime_ms: 1700000000000 + i,
          now,
        });
      }
    }
  })(count);

  return dbConn;
}

async function run(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-p52-stress-'));
  const output: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    electronVersion: process.versions.electron ?? null,
    nodeVersion: process.version,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCores: os.cpus().length,
    totalRamGb: fmt(os.totalmem() / 1024 ** 3),
  };

  try {
    // 1. Cold & Warm Startup + Profile + Codec Lazy Inventory
    const bootDir = path.join(tempRoot, 'boot');
    fs.mkdirSync(bootDir, { recursive: true });
    const bootDb = path.join(bootDir, 'library.db');

    const tCold0 = performance.now();
    const coldConn = openLibraryDatabase(bootDb);
    const tCold1 = performance.now();
    coldConn.close();

    const tWarm0 = performance.now();
    const warmConn = openLibraryDatabase(bootDb);
    const tWarm1 = performance.now();
    const integrity = verifyDatabaseIntegrity(warmConn.db);

    const profileSvc = new ProfileService({ db: warmConn.db, userDataDir: bootDir });
    const tProf0 = performance.now();
    for (let i = 0; i < 200; i += 1) {
      profileSvc.getProfile();
      profileSvc.getPreferences();
    }
    const tProf1 = performance.now();
    warmConn.close();

    const codecManager = new CodecManager({
      userDataDir: bootDir,
      allowStandardFoobarPaths: false,
      allowSystemPathLookup: false,
    });
    const tCodec0 = performance.now();
    await codecManager.getInventory();
    const tCodec1 = performance.now();
    const tCodecWarm0 = performance.now();
    await codecManager.getInventory();
    const tCodecWarm1 = performance.now();

    output.startup = {
      coldOpenMigrateIntegrityMs: fmt(tCold1 - tCold0),
      warmOpenIntegrityMs: fmt(tWarm1 - tWarm0),
      initialIntegrityOk: integrity.ok,
      profile200CallsMs: fmt(tProf1 - tProf0),
      codecLazyColdMs: fmt(tCodec1 - tCodec0),
      codecWarmMs: fmt(tCodecWarm1 - tCodecWarm0),
    };

    // 2. Vietnamese Search LRU Cache Footprint (65,536 vs 16,384 entries check)
    maybeGc();
    const heapPreCache = process.memoryUsage().heapUsed;
    const tCacheCold0 = performance.now();
    for (let i = 0; i < 50_000; i += 1) {
      normalizeVietnameseText(`Bài hát Tiếng Việt số ${i} - Đường Xưa Lối Cũ`);
    }
    const tCacheCold1 = performance.now();
    const heapPostCache = process.memoryUsage().heapUsed;

    const tCacheWarm0 = performance.now();
    for (let i = 0; i < 50_000; i += 1) {
      normalizeVietnameseText(`Bài hát Tiếng Việt số ${i} - Đường Xưa Lối Cũ`);
    }
    const tCacheWarm1 = performance.now();
    output.vietnameseCacheAudit = {
      configuredMaxEntries: 65_536,
      entriesPopulated: 50_000,
      cold50kMs: fmt(tCacheCold1 - tCacheCold0),
      warmCacheHit50kMs: fmt(tCacheWarm1 - tCacheWarm0),
      speedupRatio: fmt((tCacheCold1 - tCacheCold0) / Math.max(0.01, tCacheWarm1 - tCacheWarm0)),
      approxHeapDeltaMb: mb(Math.max(0, heapPostCache - heapPreCache)),
    };

    // 3. Large Library Matrix (100 .. 50,000) + Online Backup & Integrity on 10,000 tracks
    const scaleRows: Array<Record<string, number | boolean>> = [];
    for (const count of [100, 1000, 5000, 10000, 50000]) {
      const sDir = path.join(tempRoot, `scale-${count}`);
      fs.mkdirSync(sDir, { recursive: true });
      const dbPath = path.join(sDir, 'library.db');
      const conn = seedTracks(dbPath, sDir, count);
      const trackRepo = new TrackRepository(conn.db);
      const rootRepo = new LibraryRootRepository(conn.db);
      const artRepo = new ArtworkRepository(conn.db);
      const artSvc = new ArtworkService({ trackRepo, artworkRepo: artRepo, userDataDir: sDir });
      const libSvc = new LibraryService({ trackRepo, rootRepo, databasePath: dbPath, artworkService: artSvc });

      maybeGc();
      const memBefore = process.memoryUsage();
      const tFind0 = performance.now();
      const raw = trackRepo.findAll();
      const tFind1 = performance.now();

      const tEnrich0 = performance.now();
      const enriched = artSvc.enrichTracks(raw);
      const tEnrich1 = performance.now();

      const tSnap0 = performance.now();
      const snap = libSvc.getSnapshot();
      const tSnap1 = performance.now();

      const tSearch0 = performance.now();
      const hits = snap.tracks.filter(
        (t) =>
          matchesVietnameseQuery(t.title, 'anh trang') ||
          matchesVietnameseQuery(t.artist, 'den vau'),
      ).length;
      const tSearch1 = performance.now();

      const tSort0 = performance.now();
      const sorted = [...raw].sort((a, b) => naturalCompare(a.title, b.title)).length;
      const tSort1 = performance.now();
      const memAfter = process.memoryUsage();

      let backupMs = 0;
      let integrityMs = 0;
      if (count === 10000) {
        const ti0 = performance.now();
        const rep = verifyDatabaseIntegrity(conn.db);
        const ti1 = performance.now();
        integrityMs = fmt(ti1 - ti0);

        const tb0 = performance.now();
        const bk = await createDatabaseSnapshotBackup(conn.db, path.join(sDir, 'snapshot-10k.db'));
        const tb1 = performance.now();
        backupMs = fmt(tb1 - tb0);
        if (!rep.ok || !bk.integrity.ok) {
          throw new Error('10k integrity/backup failed during benchmark');
        }
      }

      scaleRows.push({
        count,
        findAllMs: fmt(tFind1 - tFind0),
        enrichTracksMs: fmt(tEnrich1 - tEnrich0),
        getSnapshotMs: fmt(tSnap1 - tSnap0),
        vietnameseSearchMs: fmt(tSearch1 - tSearch0),
        naturalSortMs: fmt(tSort1 - tSort0),
        hits,
        sorted,
        enriched: enriched.length,
        heapDeltaMb: mb(Math.max(0, memAfter.heapUsed - memBefore.heapUsed)),
        rssMb: mb(memAfter.rss),
        ...(count === 10000 ? { integrityMs, onlineBackupMs: backupMs } : {}),
      });

      conn.close();
      fs.rmSync(sDir, { recursive: true, force: true });
    }
    output.libraryScale = scaleRows;

    // 4. Steady-State Rescan vs Backfill + fs.stat Concurrency Sweep (2, 4, 8, 16)
    const scanDir = path.join(tempRoot, 'rescan-sweep');
    const scanMusicDir = path.join(scanDir, 'music');
    fs.mkdirSync(scanMusicDir, { recursive: true });
    const scanDbPath = path.join(scanDir, 'library.db');
    const scanConn = openLibraryDatabase(scanDbPath);
    const scanTrackRepo = new TrackRepository(scanConn.db);
    const scanRootRepo = new LibraryRootRepository(scanConn.db);
    const scanArtRepo = new ArtworkRepository(scanConn.db);
    const scanArtSvc = new ArtworkService({
      trackRepo: scanTrackRepo,
      artworkRepo: scanArtRepo,
      userDataDir: scanDir,
    });
    const scanLibSvc = new LibraryService({
      trackRepo: scanTrackRepo,
      rootRepo: scanRootRepo,
      databasePath: scanDbPath,
      artworkService: scanArtSvc,
    });

    const scanFilePaths: string[] = [];
    const nowIso = new Date().toISOString();
    scanRootRepo.upsertRoot(scanMusicDir, scanMusicDir.toLowerCase());
    const insScan = scanConn.db.prepare(`
      INSERT INTO tracks (
        id, original_path, normalized_path, file_name, title, artist, album,
        duration_ms, codec, container, sample_rate_hz, bit_depth,
        bitrate_bps, file_size_bytes, modified_at_ms, status,
        availability_state, metadata_version, added_at, updated_at
      ) VALUES (
        @id, @original_path, @normalized_path, @file_name, @title, 'Artist', 'Album',
        180000, 'FLAC', 'FLAC', 44100, 16, 900000, @size, @mtime, 'available',
        'available', 2, @now, @now
      )
    `);

    scanConn.db.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        const subDir = path.join(scanMusicDir, `Album_${Math.floor(i / 20)}`);
        fs.mkdirSync(subDir, { recursive: true });
        const fileName = `track_${i}.flac`;
        const fp = path.join(subDir, fileName);
        fs.writeFileSync(fp, Buffer.from('fLaC\x80\x00\x00\x22'));
        scanFilePaths.push(fp);
        const st = fs.statSync(fp);
        insScan.run({
          id: crypto.randomUUID(),
          original_path: fp,
          normalized_path: fp.toLowerCase(),
          file_name: fileName,
          title: `Track ${i}`,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          now: nowIso,
        });
      }
    })();

    // Steady-state rescan (file_name already populated -> fast skip!)
    const tSteady1_0 = performance.now();
    const steadyRes1 = await scanLibSvc.rescanLibrary();
    const tSteady1_1 = performance.now();

    // Force file_name = NULL to simulate legacy backfill rescan
    scanConn.db.exec('UPDATE tracks SET file_name = NULL');
    const tBackfill0 = performance.now();
    const backfillRes = await scanLibSvc.rescanLibrary();
    const tBackfill1 = performance.now();

    // Steady-state again after backfill
    const tSteady2_0 = performance.now();
    const steadyRes2 = await scanLibSvc.rescanLibrary();
    const tSteady2_1 = performance.now();

    // Concurrency sweep on 1,000 real files fs.stat
    const statSweep: Record<string, number> = {};
    for (const conc of [2, 4, 8, 16]) {
      const ts0 = performance.now();
      for (let start = 0; start < scanFilePaths.length; start += conc) {
        const slice = scanFilePaths.slice(start, start + conc);
        await Promise.all(slice.map((p) => fsPromises.stat(p)));
      }
      const ts1 = performance.now();
      statSweep[`concurrency_${conc}`] = fmt(ts1 - ts0);
    }

    scanConn.close();
    output.rescanAndConcurrency = {
      steadyStateBeforeBackfillMs: fmt(tSteady1_1 - tSteady1_0),
      steadyBeforeUpdated: steadyRes1.updatedCount,
      steadyBeforeSkipped: steadyRes1.skippedCount,
      legacyBackfillRescanMs: fmt(tBackfill1 - tBackfill0),
      backfillUpdated: backfillRes.updatedCount,
      steadyStateAfterBackfillMs: fmt(tSteady2_1 - tSteady2_0),
      steadyAfterUpdated: steadyRes2.updatedCount,
      steadyAfterSkipped: steadyRes2.skippedCount,
      statSweepMs: statSweep,
    };

    // 5. Multi-Iteration Soak / Memory Stability Loop (30 iterations)
    maybeGc();
    const soakMemStart = process.memoryUsage();
    const tSoak0 = performance.now();
    const trackIds5k = Array.from({ length: 5000 }, (_, i) => `soak-${i}`);
    const queue = new PlaybackQueueController();

    for (let iter = 0; iter < 30; iter += 1) {
      queue.startContext({
        context: { contextId: `soak-${iter}`, label: 'Soak', kind: 'library', trackIds: trackIds5k },
        startIndex: (iter * 137) % trackIds5k.length,
        shuffle: false,
      });
      queue.setShuffle(true);
      for (let step = 0; step < 50; step += 1) {
        queue.advanceManualNext();
      }
      queue.setShuffle(false);
      for (const size of [0, 79, 80, 81, 500, 5000, 50000]) {
        computeQueueWindowSlice({
          totalItems: size,
          itemHeightPx: 56,
          scrollOffsetPx: (iter * 913) % Math.max(100, size * 56),
          viewportHeightPx: 720,
        });
      }
    }
    const tSoak1 = performance.now();
    maybeGc();
    const soakMemEnd = process.memoryUsage();
    output.soakLoop30x = {
      iterations: 30,
      queueSize: 5000,
      totalDurationMs: fmt(tSoak1 - tSoak0),
      heapBeforeMb: mb(soakMemStart.heapUsed),
      heapAfterMb: mb(soakMemEnd.heapUsed),
      rssBeforeMb: mb(soakMemStart.rss),
      rssAfterMb: mb(soakMemEnd.rss),
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
