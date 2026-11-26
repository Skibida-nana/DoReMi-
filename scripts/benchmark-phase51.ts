import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LibraryService } from '../src/main/services/library-service';
import { ProfileService } from '../src/main/services/profile-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import { PlaybackQueueController } from '../src/renderer/src/player/playback-queue';
import { extractAdaptiveArtworkThemeFromRgbaPixels } from '../src/renderer/src/utils/adaptive-artwork';
import {
  computeFocusRadialLayout,
  computeUnifiedVinylPlacement,
} from '../src/renderer/src/utils/focus-radial-layout';
import { computeQueueWindowSlice } from '../src/renderer/src/utils/queue-virtualization';
import {
  compareUnicodeText,
  getActiveLyricIndex,
  matchesVietnameseQuery,
} from '../src/renderer/src/utils/vietnamese-search';
import {
  findActiveLyricGroupIndex,
  groupTimedLyricLines,
  parseLrcContent,
} from '../src/shared/utils/lyrics-parser';
import { naturalCompare } from '../src/shared/utils/natural-sort';

function formatMs(ms: number): string {
  return Number(ms.toFixed(2)).toString();
}

function mb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function seedTracksAndArtwork(
  dbPath: string,
  userDataDir: string,
  count: number,
  seedArtworkFiles: boolean,
): { dbConn: ReturnType<typeof openLibraryDatabase>; trackIds: string[] } {
  const dbConn = openLibraryDatabase(dbPath);
  const db = dbConn.db;

  const cacheDir = path.join(userDataDir, 'artwork-cache');
  const thumbDir = path.join(userDataDir, 'artwork-thumbs');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const sharedHash = 'benchhash000111222333';
  const sharedCacheFile = `${sharedHash}.jpg`;
  if (seedArtworkFiles) {
    fs.writeFileSync(path.join(cacheDir, sharedCacheFile), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fs.writeFileSync(
      path.join(thumbDir, `${sharedHash}.thumb.jpg`),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  }

  const insertTrack = db.prepare(`
    INSERT INTO tracks (
      id, original_path, normalized_path, title, artist, album, genre, year,
      album_artist, track_number, duration_ms, codec, container, sample_rate_hz,
      bit_depth, bitrate_bps, file_size_bytes, modified_at_ms, status,
      availability_state, metadata_version, added_at, updated_at
    ) VALUES (
      @id, @original_path, @normalized_path, @title, @artist, @album, @genre, @year,
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

  const artists = [
    'Đen Vâu',
    'Ngọt',
    'Trịnh Công Sơn',
    'Yorushika (ヨルシカ)',
    '宇多田ヒカル',
    'Pink Floyd',
    'Miles Davis',
    'Daft Punk',
  ];
  const now = new Date().toISOString();
  const trackIds: string[] = [];

  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) {
      const id = crypto.randomUUID();
      trackIds.push(id);
      const artist = artists[i % artists.length];
      const album = `Album ${String(Math.floor(i / 12) + 1).padStart(4, '0')} - Ký ức`;
      const origPath = `C:\\MusicBench\\Dir${Math.floor(i / 250)}\\Track_${String(i).padStart(5, '0')}.flac`;
      insertTrack.run({
        id,
        original_path: origPath,
        normalized_path: origPath.toLowerCase(),
        title: `Bài hát số ${i + 1} - Ánh Trăng Mùa Thu`,
        artist,
        album,
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
  });

  tx(count);
  return { dbConn, trackIds };
}

async function runBenchmarks() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-bench-51-'));
  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    platform: `${process.platform} ${process.arch}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCores: os.cpus().length,
    totalRamGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
  };

  try {
    // 1. Startup DB & ProfileService benchmark
    const coldDbPath = path.join(tempRoot, 'startup-cold.db');
    const coldUserDir = path.join(tempRoot, 'startup-user');
    fs.mkdirSync(coldUserDir, { recursive: true });

    const tOpenCold0 = performance.now();
    const coldConn = openLibraryDatabase(coldDbPath);
    const tOpenCold1 = performance.now();
    coldConn.close();

    const tOpenWarm0 = performance.now();
    const warmConn = openLibraryDatabase(coldDbPath);
    const tOpenWarm1 = performance.now();

    const profileSvc = new ProfileService({ db: warmConn.db, userDataDir: coldUserDir });
    profileSvc.getProfile();
    profileSvc.getPreferences();

    const tProf0 = performance.now();
    for (let i = 0; i < 200; i += 1) {
      profileSvc.getProfile();
      profileSvc.getPreferences();
    }
    const tProf1 = performance.now();
    warmConn.close();

    results.startup = {
      coldDbOpenAndMigrateMs: Number(formatMs(tOpenCold1 - tOpenCold0)),
      warmDbOpenMs: Number(formatMs(tOpenWarm1 - tOpenWarm0)),
      profileAndPrefs200CallsMs: Number(formatMs(tProf1 - tProf0)),
    };

    // 2. Database & Library Scale Benchmarks (100 .. 50,000)
    const libraryScaleMetrics: Array<Record<string, number>> = [];
    for (const count of [100, 1000, 5000, 10000, 50000]) {
      const scaleDir = path.join(tempRoot, `scale-${count}`);
      fs.mkdirSync(scaleDir, { recursive: true });
      const dbPath = path.join(scaleDir, 'library.db');
      const { dbConn } = seedTracksAndArtwork(dbPath, scaleDir, count, true);

      const trackRepo = new TrackRepository(dbConn.db);
      const rootRepo = new LibraryRootRepository(dbConn.db);
      const artworkRepo = new ArtworkRepository(dbConn.db);
      const artworkSvc = new ArtworkService({
        trackRepo,
        artworkRepo,
        userDataDir: scaleDir,
      });
      const libSvc = new LibraryService({
        trackRepo,
        rootRepo,
        databasePath: dbPath,
        artworkService: artworkSvc,
      });

      const memBefore = process.memoryUsage();
      const tFind0 = performance.now();
      const rawTracks = trackRepo.findAll();
      const tFind1 = performance.now();

      const tEnrich0 = performance.now();
      const enrichedTracks = artworkSvc.enrichTracks(rawTracks);
      const tEnrich1 = performance.now();

      const tSnap0 = performance.now();
      const snap = libSvc.getSnapshot();
      const tSnap1 = performance.now();
      const memAfter = process.memoryUsage();

      // Search & Sort on the loaded rawTracks
      const tSearch0 = performance.now();
      const matched = snap.tracks.filter(
        (t) =>
          matchesVietnameseQuery(t.title, 'anh trang') ||
          matchesVietnameseQuery(t.artist, 'den vau') ||
          matchesVietnameseQuery(t.album, 'ky uc'),
      );
      const tSearch1 = performance.now();

      const tSort0 = performance.now();
      const sorted = [...rawTracks].sort((a, b) => naturalCompare(a.title, b.title));
      const tSort1 = performance.now();

      libraryScaleMetrics.push({
        count,
        findAllMs: Number(formatMs(tFind1 - tFind0)),
        enrichTracksMs: Number(formatMs(tEnrich1 - tEnrich0)),
        getSnapshotMs: Number(formatMs(tSnap1 - tSnap0)),
        vietnameseSearchMs: Number(formatMs(tSearch1 - tSearch0)),
        searchMatches: matched.length,
        naturalSortMs: Number(formatMs(tSort1 - tSort0)),
        sortedCount: sorted.length,
        heapDeltaMb: mb(Math.max(0, memAfter.heapUsed - memBefore.heapUsed)),
        rssMb: mb(memAfter.rss),
        enrichedCount: enrichedTracks.length,
      });

      dbConn.close();
      fs.rmSync(scaleDir, { recursive: true, force: true });
    }
    results.libraryScale = libraryScaleMetrics;

    // 3. Incremental Rescan Benchmark (real 1,000 stub FLAC files on temp disk)
    const scanDir = path.join(tempRoot, 'scan-bench');
    const scanMusicDir = path.join(scanDir, 'music');
    fs.mkdirSync(scanMusicDir, { recursive: true });
    const scanDbPath = path.join(scanDir, 'library.db');
    const scanDbConn = openLibraryDatabase(scanDbPath);
    const scanTrackRepo = new TrackRepository(scanDbConn.db);
    const scanRootRepo = new LibraryRootRepository(scanDbConn.db);
    const scanArtRepo = new ArtworkRepository(scanDbConn.db);
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

    const scanFileCount = 1000;
    const nowIso = new Date().toISOString();
    const rootNorm = scanMusicDir.toLowerCase();
    scanRootRepo.upsertRoot(scanMusicDir, rootNorm);
    const insScanTrack = scanDbConn.db.prepare(`
      INSERT INTO tracks (
        id, original_path, normalized_path, title, artist, album,
        duration_ms, codec, container, sample_rate_hz, bit_depth,
        bitrate_bps, file_size_bytes, modified_at_ms, status,
        availability_state, metadata_version, added_at, updated_at
      ) VALUES (
        @id, @original_path, @normalized_path, @title, 'Bench Artist', 'Bench Album',
        180000, 'FLAC', 'FLAC', 44100, 16, 900000, @size, @mtime, 'available',
        'available', 2, @now, @now
      )
    `);
    const seedScanTx = scanDbConn.db.transaction(() => {
      for (let i = 0; i < scanFileCount; i += 1) {
        const subDir = path.join(scanMusicDir, `Album_${Math.floor(i / 20)}`);
        fs.mkdirSync(subDir, { recursive: true });
        const fp = path.join(subDir, `track_${i}.flac`);
        fs.writeFileSync(fp, Buffer.from('fLaC\x80\x00\x00\x22'));
        const st = fs.statSync(fp);
        insScanTrack.run({
          id: crypto.randomUUID(),
          original_path: fp,
          normalized_path: fp.toLowerCase(),
          title: `Scan Track ${i}`,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          now: nowIso,
        });
      }
    });
    seedScanTx();

    const tRescan0 = performance.now();
    const rescanSummary = await scanLibSvc.rescanLibrary();
    const tRescan1 = performance.now();
    const tRescanSteady0 = performance.now();
    const rescanSteadySummary = await scanLibSvc.rescanLibrary();
    const tRescanSteady1 = performance.now();
    scanDbConn.close();

    results.incrementalRescan1000 = {
      scannedCount: rescanSummary.scannedCount,
      addedCount: rescanSummary.addedCount,
      updatedCount: rescanSummary.updatedCount,
      missingMarkedCount: rescanSummary.missingMarkedCount,
      durationMs: Number(formatMs(tRescan1 - tRescan0)),
    };
    results.incrementalRescanSteady1000 = {
      scannedCount: rescanSteadySummary.scannedCount,
      addedCount: rescanSteadySummary.addedCount,
      updatedCount: rescanSteadySummary.updatedCount,
      skippedCount: rescanSteadySummary.skippedCount,
      durationMs: Number(formatMs(tRescanSteady1 - tRescanSteady0)),
    };

    // 4. Playback Queue Benchmark (100 .. 5,000 tracks)
    const queueScaleMetrics: Array<Record<string, number>> = [];
    for (const qCount of [100, 500, 1000, 5000]) {
      const ids = Array.from({ length: qCount }, (_, i) => `track-${i}`);
      const qCtrl = new PlaybackQueueController();
      const mem0 = process.memoryUsage().heapUsed;
      const tStart0 = performance.now();
      qCtrl.startContext({
        context: { contextId: `ctx-${qCount}`, label: 'Bench', kind: 'playlist', trackIds: ids },
        startIndex: Math.floor(qCount / 2),
        shuffle: false,
      });
      const tStart1 = performance.now();

      const tShuf0 = performance.now();
      qCtrl.setShuffle(true);
      const tShuf1 = performance.now();

      const tUnshuf0 = performance.now();
      qCtrl.setShuffle(false);
      const tUnshuf1 = performance.now();

      const tNext0 = performance.now();
      for (let k = 0; k < 50; k += 1) {
        qCtrl.advanceManualNext();
      }
      const tNext1 = performance.now();
      const mem1 = process.memoryUsage().heapUsed;

      queueScaleMetrics.push({
        count: qCount,
        startContextMs: Number(formatMs(tStart1 - tStart0)),
        shuffleOnMs: Number(formatMs(tShuf1 - tShuf0)),
        shuffleOffRestoreMs: Number(formatMs(tUnshuf1 - tUnshuf0)),
        next50Ms: Number(formatMs(tNext1 - tNext0)),
        heapDeltaMb: mb(Math.max(0, mem1 - mem0)),
      });
    }
    results.playbackQueue = queueScaleMetrics;

    // 5. Lyrics, Adaptive Artwork Pixels, Focus Radial Layout & Queue Virtualization
    const sampleLrc = Array.from({ length: 120 }, (_, i) => {
      const m = String(Math.floor((i * 2) / 60)).padStart(2, '0');
      const s = String((i * 2) % 60).padStart(2, '0');
      return `[${m}:${s}.25]Dòng lời bài hát thứ ${i + 1} - Tiếng Việt có dấu\n[${m}:${s}.25]Lyric translation line ${i + 1}`;
    }).join('\n');

    const tParse0 = performance.now();
    let parsedLrc = parseLrcContent(sampleLrc);
    let groupedLrc = groupTimedLyricLines(parsedLrc.lines);
    for (let i = 0; i < 99; i += 1) {
      parsedLrc = parseLrcContent(sampleLrc);
      groupedLrc = groupTimedLyricLines(parsedLrc.lines);
    }
    const tParse1 = performance.now();

    const tLookup0 = performance.now();
    let activeIdxSum = 0;
    for (let i = 0; i < 10000; i += 1) {
      const sec = (i % 240) + 0.3;
      activeIdxSum += findActiveLyricGroupIndex(groupedLrc, sec);
      activeIdxSum += getActiveLyricIndex(parsedLrc.lines, sec);
    }
    const tLookup1 = performance.now();

    const rgba64 = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < rgba64.length; i += 4) {
      rgba64[i] = (i * 13) % 255;
      rgba64[i + 1] = (i * 29) % 255;
      rgba64[i + 2] = (i * 47) % 255;
      rgba64[i + 3] = 255;
    }
    const tArt0 = performance.now();
    for (let i = 0; i < 200; i += 1) {
      extractAdaptiveArtworkThemeFromRgbaPixels(rgba64, {
        artworkKey: `bench-art-${i % 10}`,
        themeMode: i % 2 === 0 ? 'dark' : 'light',
        dynamicAlbumColors: true,
        sampleWidth: 64,
        sampleHeight: 64,
      });
    }
    const tArt1 = performance.now();

    const tLayout0 = performance.now();
    const vinylPlacement = computeUnifiedVinylPlacement({
      viewportWidth: 1440,
      viewportHeight: 900,
      isFocusMode: true,
    });
    for (let i = 0; i < 5000; i += 1) {
      computeFocusRadialLayout({
        viewportWidth: 1440,
        viewportHeight: 900,
        placement: vinylPlacement,
      });
      computeQueueWindowSlice({
        totalItems: 5000,
        itemHeightPx: 58,
        scrollOffsetPx: (i * 17) % 250000,
        viewportHeightPx: 620,
      });
    }
    const tLayout1 = performance.now();

    const unicodeItems = ['Đêm Nay', 'Anh Yêu Em', 'Ánh Trăng', 'ヨルシカ', 'Zebra', 'Bình Yên'];
    const tUnicode0 = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      [...unicodeItems].sort(compareUnicodeText);
    }
    const tUnicode1 = performance.now();

    results.uiAlgorithms = {
      parseAndGroupLrc120x100Ms: Number(formatMs(tParse1 - tParse0)),
      lyricActiveLookup10kMs: Number(formatMs(tLookup1 - tLookup0)),
      activeIdxGuard: activeIdxSum,
      adaptiveArtwork64x64x200Ms: Number(formatMs(tArt1 - tArt0)),
      focusRadialAndQueueVirtual5kMs: Number(formatMs(tLayout1 - tLayout0)),
      unicodeSort2kMs: Number(formatMs(tUnicode1 - tUnicode0)),
    };

    // 6. Codec Manager cold vs warm discovery + isolation check
    const codecUserDir = path.join(tempRoot, 'codec-user');
    fs.mkdirSync(codecUserDir, { recursive: true });
    const codecMgr = new CodecManager({ userDataDir: codecUserDir });
    const tCodecCold0 = performance.now();
    await codecMgr.getInventory();
    const tCodecCold1 = performance.now();
    const tCodecWarm0 = performance.now();
    await codecMgr.getInventory();
    const tCodecWarm1 = performance.now();

    results.codecDiscovery = {
      coldInventoryMs: Number(formatMs(tCodecCold1 - tCodecCold0)),
      warmInventoryMs: Number(formatMs(tCodecWarm1 - tCodecWarm0)),
    };

    console.log(JSON.stringify(results, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void runBenchmarks().catch((err) => {
  console.error(err);
  process.exit(1);
});
