import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ExclusionRepository } from '../src/main/database/exclusion-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { MetadataOverrideRepository } from '../src/main/database/metadata-override-repository';
import { MIGRATIONS, runMigrations } from '../src/main/database/migrations';
import { PlaylistRepository } from '../src/main/database/playlist-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { LibraryService } from '../src/main/services/library-service';
import { StatisticsService } from '../src/main/services/statistics-service';
import { CONFIRMED_DEMO_TRACK_IDS } from '../src/shared/utils/demo-cleanup';
import {
  buildFolderHierarchy,
  compareTracksByFileName,
  compareTracksByTrackNumber,
  isTrackInsideFolder,
} from '../src/shared/utils/folder-tree';
import { naturalCompare } from '../src/shared/utils/natural-sort';
import { discoverAudioFilesInFolder } from '../src/main/services/scanner-service';

function makeSilentWavBuffer(durationSec = 1, sampleRate = 8000): Buffer {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function makeMinimalPngBuffer(): Buffer {
  // Valid PNG signature + minimal bytes (>12 bytes) for validateImageBuffer check
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
}

function createTempHarness() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-phase3-'));
  const musicDir = path.join(rootDir, 'Music');
  const userDataDir = path.join(rootDir, 'UserData');
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, 'library.db');
  const conn = openLibraryDatabase(dbPath);
  const trackRepo = new TrackRepository(conn.db);
  const rootRepo = new LibraryRootRepository(conn.db);
  const artworkRepo = new ArtworkRepository(conn.db);
  const metadataOverrideRepo = new MetadataOverrideRepository(conn.db);
  const exclusionRepo = new ExclusionRepository(conn.db);
  const playlistRepo = new PlaylistRepository(conn.db);
  const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });
  const statsService = new StatisticsService({ db: conn.db, trackRepo, artworkService });
  const libraryService = new LibraryService({
    trackRepo,
    rootRepo,
    databasePath: dbPath,
    artworkService,
    metadataOverrideRepo,
    exclusionRepo,
  });
  return {
    rootDir,
    musicDir,
    userDataDir,
    dbPath,
    conn,
    trackRepo,
    rootRepo,
    artworkService,
    playlistRepo,
    exclusionRepo,
    statsService,
    libraryService,
    cleanup: () => {
      conn.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test('Phase 3B: Fresh SQLite DB starts completely clean (0 tracks/playlists/favorites/stats) & safe demo cleanup preserves real data', () => {
  const h = createTempHarness();
  try {
    assert.equal(h.trackRepo.findAll().length, 0);
    assert.equal(h.playlistRepo.findAll().length, 0);
    assert.equal(h.playlistRepo.getFavoriteTrackIds().length, 0);
    assert.equal(h.statsService.getDashboard({ range: 'all', periodOffset: 0 }).uniqueTracksPlayed, 0);

    // Insert real user track + simulate a legacy leaked demo record, then re-verify migration cleanup logic
    h.trackRepo.upsertBatch([
      {
        original_path: path.join(h.musicDir, 'Real Song.wav'),
        normalized_path: path.join(h.musicDir, 'Real Song.wav').toLowerCase(),
        title: 'Afterlight', // Same title as demo track, MUST NEVER be deleted!
        artist: 'Real Artist',
        album: 'User Album',
        duration_ms: 120000,
        codec: 'PCM',
        container: 'WAV',
        sample_rate_hz: 44100,
        bit_depth: 16,
        bitrate_bps: 1411200,
        file_size_bytes: 123456,
        modified_at_ms: 1000,
        status: 'missing', // Missing real track with demo-like name MUST still remain untouched!
      },
    ]);
    const realTrack = h.trackRepo.findAll()[0];
    assert.ok(realTrack);

    // Seed a confirmed demo track ID + listening session and execute migration 7 cleanup step idempotently
    h.conn.db
      .prepare(
        `INSERT INTO tracks (id, original_path, normalized_path, title, artist, album, status, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
      )
      .run(
        CONFIRMED_DEMO_TRACK_IDS[0],
        'sample://afterlight-1',
        'sample://afterlight-1',
        'Demo Song',
        'Demo Artist',
        'Demo Album',
        new Date().toISOString(),
        new Date().toISOString(),
      );

    // Migrate legacy collections containing 1 demo playlist + 1 real user playlist (empty) + 1 mixed user playlist
    const migrated = h.playlistRepo.migrateLegacyCollections({
      playlists: [
        { id: 'pl-late-night', name: 'Đêm Muộn Audiophile', trackIds: [CONFIRMED_DEMO_TRACK_IDS[0]] },
        { id: 'pl-custom-1', name: 'Playlist Rỗng Thật', trackIds: [] },
        {
          id: 'pl-custom-2',
          name: 'Playlist Hỗn Hợp',
          trackIds: [CONFIRMED_DEMO_TRACK_IDS[0], realTrack.id],
        },
      ],
      favoriteIds: [CONFIRMED_DEMO_TRACK_IDS[0], 'alb-afterlight', realTrack.id],
    });

    // Simulate re-running cleanup query from migration 007
    MIGRATIONS.find((m) => m.version === 7)?.up(h.conn.db);
    runMigrations(h.conn.db);

    const remainingTracks = h.trackRepo.findAll();
    assert.equal(remainingTracks.length, 1);
    assert.equal(remainingTracks[0].id, realTrack.id);

    // Legacy demo playlist dropped, real playlists preserved (and demo track stripped from mixed playlist)
    assert.equal(migrated.playlists.length, 2);
    const emptyPl = migrated.playlists.find((p) => p.name === 'Playlist Rỗng Thật');
    const mixedPl = migrated.playlists.find((p) => p.name === 'Playlist Hỗn Hợp');
    assert.ok(emptyPl);
    assert.equal(emptyPl.trackIds.length, 0);
    assert.ok(mixedPl);
    assert.deepEqual(mixedPl.trackIds, [realTrack.id]);
    assert.deepEqual(migrated.favoriteTrackIds, [realTrack.id]);
  } finally {
    h.cleanup();
  }
});

test('Phase 3C & 3F: Playlist creation (empty = 0 tracks), duplicates, reorder, batch remove & delete integrity', async () => {
  const h = createTempHarness();
  try {
    const f1 = path.join(h.musicDir, 'track1.wav');
    const f2 = path.join(h.musicDir, 'track2.wav');
    const f3 = path.join(h.musicDir, 'track3.wav');
    fs.writeFileSync(f1, makeSilentWavBuffer(2));
    fs.writeFileSync(f2, makeSilentWavBuffer(3));
    fs.writeFileSync(f3, makeSilentWavBuffer(4));

    await h.libraryService.importFiles([f1, f2, f3]);
    const tracks = h.trackRepo.findAll();
    assert.equal(tracks.length, 3);
    const [t1, t2, t3] = tracks;

    // 1. Empty playlist MUST have strictly 0 tracks
    const emptyPl = h.playlistRepo.createPlaylist({ name: 'Trống Hoàn Toàn' });
    assert.equal(emptyPl.trackCount, 0);
    assert.deepEqual(emptyPl.trackIds, []);

    // 2. Add tracks + skip duplicate by default
    const add1 = h.playlistRepo.addTracksToPlaylist(emptyPl.id, [t1.id, t2.id, t1.id]);
    assert.equal(add1.addedCount, 2);
    assert.equal(add1.skippedDuplicateCount, 1);
    assert.deepEqual(add1.playlist.trackIds, [t1.id, t2.id]);

    // 3. Reorder entries & persist positions
    const add2 = h.playlistRepo.addTracksToPlaylist(emptyPl.id, [t3.id]);
    const [e1, e2, e3] = add2.playlist.entries;
    const reordered = h.playlistRepo.reorderPlaylistEntries(emptyPl.id, [
      e3.entryId,
      e1.entryId,
      e2.entryId,
    ]);
    assert.deepEqual(reordered.trackIds, [t3.id, t1.id, t2.id]);
    assert.deepEqual(
      reordered.entries.map((e) => e.position),
      [0, 1, 2],
    );

    // 4. Remove single entry & verify position reindex
    const afterRem = h.playlistRepo.removeEntriesFromPlaylist(emptyPl.id, [e1.entryId]);
    assert.deepEqual(afterRem.trackIds, [t3.id, t2.id]);
    assert.deepEqual(
      afterRem.entries.map((e) => e.position),
      [0, 1],
    );

    // 5. Delete playlist does NOT touch tracks or files on disk
    const del = h.playlistRepo.deletePlaylist(emptyPl.id);
    assert.equal(del.deleted, true);
    assert.equal(h.playlistRepo.findById(emptyPl.id), null);
    assert.equal(h.trackRepo.findAll().length, 3);
    assert.equal(fs.existsSync(f1), true);
  } finally {
    h.cleanup();
  }
});

test('Phase 3D & 3E: Library removal preserves disk files + stats, cleans playlists/favs, and respects exclusions on rescan', async () => {
  const h = createTempHarness();
  try {
    const f1 = path.join(h.musicDir, 'keep.wav');
    const f2 = path.join(h.musicDir, 'remove-me.wav');
    fs.writeFileSync(f1, makeSilentWavBuffer(2));
    fs.writeFileSync(f2, makeSilentWavBuffer(2));

    await h.libraryService.importFolder(h.musicDir);
    const tracks = h.trackRepo.findAll();
    const keepTrack = tracks.find((t) => t.original_path.endsWith('keep.wav'))!;
    const removeTrack = tracks.find((t) => t.original_path.endsWith('remove-me.wav'))!;

    const pl = h.playlistRepo.createPlaylist({
      name: 'Sync Playlist',
      initialTrackIds: [keepTrack.id, removeTrack.id],
    });
    h.playlistRepo.toggleFavorite(removeTrack.id);

    // Record listening session for removed track -> MUST survive library removal!
    const now = Date.now();
    h.statsService.recordListeningSession({
      sessionId: 'sess-removed-track',
      trackId: removeTrack.id,
      trackTitle: removeTrack.title,
      artist: removeTrack.artist,
      album: removeTrack.album,
      durationMs: 60000,
      startedAtMs: now - 40000,
      endedAtMs: now,
      listenedMs: 40000,
    });

    // Remove track from Library (with exclusion)
    const removal = h.libraryService.removeTracks([removeTrack.id], { addExclusion: true });
    assert.deepEqual(removal.removedTrackIds, [removeTrack.id]);
    assert.equal(removal.excludedCount, 1);

    // Physical file untouched on disk!
    assert.equal(fs.existsSync(f2), true);
    // Removed from playlists & favorites
    assert.deepEqual(h.playlistRepo.findById(pl.id)!.trackIds, [keepTrack.id]);
    assert.deepEqual(h.playlistRepo.getFavoriteTrackIds(), []);
    // Stats preserved as deleted track!
    const dash = h.statsService.getDashboard({ range: 'all', periodOffset: 0 });
    assert.equal(dash.deletedGroup.uniqueTrackCount, 1);

    // Smart Rescan MUST skip the excluded file!
    const rescan1 = await h.libraryService.rescanLibrary();
    assert.equal(rescan1.addedCount, 0);
    assert.equal(rescan1.excludedSkippedCount, 1);
    assert.equal(h.trackRepo.findAll().length, 1);

    // Re-importing explicitly clears exclusion and restores track
    const reimport = await h.libraryService.reimportExcludedTracks();
    assert.equal(reimport.reimportedCount, 1);
    assert.equal(h.trackRepo.findAll().length, 2);
  } finally {
    h.cleanup();
  }
});

test('Phase 3G: Extended metadata overrides + independent custom artwork restore without modifying disk files', async () => {
  const h = createTempHarness();
  try {
    const f1 = path.join(h.musicDir, 'song.wav');
    fs.writeFileSync(f1, makeSilentWavBuffer(2));
    const statBefore = fs.statSync(f1);

    await h.libraryService.importFiles([f1]);
    const track = h.trackRepo.findAll()[0];
    assert.ok(track);

    // Apply custom PNG artwork
    const coverPath = path.join(h.rootDir, 'custom-cover.png');
    fs.writeFileSync(coverPath, makeMinimalPngBuffer());
    const withArt = await h.artworkService.importCustomArtworkFromPath(track.id, coverPath);
    assert.equal(withArt.has_custom_artwork, true);

    // Update extended SQLite metadata fields
    const updated = h.libraryService.updateTrackMetadataOverride(track.id, {
      titleOverride: 'Tiêu Đề Tùy Chỉnh',
      artistOverride: 'Nghệ Sĩ Mới',
      albumOverride: 'Album Mới',
      genreOverride: 'Acoustic Lossless',
      yearOverride: 2025,
      albumArtistOverride: 'Album Artist Test',
      trackNumberOverride: 7,
      trackTotalOverride: 12,
      discNumberOverride: 1,
      discTotalOverride: 2,
      composerOverride: 'Nhạc sĩ A',
      lyricistOverride: 'Lời B',
      commentOverride: 'Ghi chú giữ nguyên file gốc',
    });

    assert.equal(updated.title, 'Tiêu Đề Tùy Chỉnh');
    assert.equal(updated.genre, 'Acoustic Lossless');
    assert.equal(updated.year, 2025);
    assert.equal(updated.track_number, 7);
    assert.equal(updated.composer, 'Nhạc sĩ A');
    assert.equal(updated.has_custom_artwork, true);

    // Source audio file MUST remain byte-for-byte untouched
    const statAfter = fs.statSync(f1);
    assert.equal(statAfter.size, statBefore.size);
    assert.equal(Math.round(statAfter.mtimeMs), Math.round(statBefore.mtimeMs));

    // Restoring original metadata MUST preserve custom artwork independently!
    const restoredMeta = h.libraryService.restoreTrackMetadataOriginal(track.id);
    assert.equal(restoredMeta.title, track.original_title ?? track.title);
    assert.equal(restoredMeta.genre, track.original_genre ?? null);
    assert.equal(restoredMeta.has_custom_artwork, true);

    // And removing custom artwork leaves metadata untouched
    const restoredArt = await h.artworkService.removeCustomArtwork(track.id);
    assert.equal(restoredArt.has_custom_artwork, false);
  } finally {
    h.cleanup();
  }
});

test('Phase 3H & 3I: Smart Rescan availability classification, cancellation, overlapping roots & single/folder Relink preserving Track ID', async () => {
  const h = createTempHarness();
  try {
    const parentMusic = path.join(h.rootDir, 'ParentMusic');
    const subMusic = path.join(parentMusic, 'SubFolder');
    const movedDir = path.join(h.rootDir, 'MovedMusic');
    fs.mkdirSync(subMusic, { recursive: true });
    fs.mkdirSync(movedDir, { recursive: true });

    const fKeep = path.join(parentMusic, 'keep.wav');
    const fMove = path.join(subMusic, 'lost-track.wav');
    fs.writeFileSync(fKeep, makeSilentWavBuffer(2));
    fs.writeFileSync(fMove, makeSilentWavBuffer(3));

    // Import overlapping parent and nested subfolder -> MUST not create duplicate records
    await h.libraryService.importFolder(parentMusic);
    await h.libraryService.importFolder(subMusic);
    const rescanDedup = await h.libraryService.rescanLibrary();
    assert.equal(h.trackRepo.findAll().length, 2);
    assert.equal(rescanDedup.addedCount, 0);

    // Attach playlist + override + favorite to track about to move
    const lostTrack = h.trackRepo.findAll().find((t) => t.original_path.endsWith('lost-track.wav'))!;
    h.playlistRepo.toggleFavorite(lostTrack.id);
    const pl = h.playlistRepo.createPlaylist({ name: 'Preserve Me', initialTrackIds: [lostTrack.id] });
    h.libraryService.updateTrackMetadataOverride(lostTrack.id, {
      titleOverride: 'Tên Đã Sửa Trước Khi Move',
      artistOverride: lostTrack.artist,
      albumOverride: lostTrack.album,
    });

    // Move file on disk -> rescan marks it missing cleanly without deleting record
    const newMovedPath = path.join(movedDir, 'lost-track.wav');
    fs.renameSync(fMove, newMovedPath);
    const scanAfterMove = await h.libraryService.rescanLibrary();
    assert.equal(scanAfterMove.missingMarkedCount, 1);

    const markedMissing = h.trackRepo.findById(lostTrack.id)!;
    assert.equal(markedMissing.status, 'missing');
    assert.equal(markedMissing.availability_state, 'missing');

    // Conflict protection: relinking lostTrack to fKeep path (owned by another track) MUST fail safely
    const conflictRes = await h.libraryService.relinkSingleTrack(lostTrack.id, fKeep);
    assert.equal(conflictRes.success, false);
    assert.ok(conflictRes.conflictTrackId);

    // Scan movedDir -> classifies as 'matched'
    const preview = await h.libraryService.scanRelinkFolder(movedDir);
    assert.equal(preview.totalMissingTracks, 1);
    assert.equal(preview.matchedCount, 1);
    assert.equal(preview.proposals[0].suggestedPath, newMovedPath);

    // Apply relink -> MUST preserve exact UUID, playlist, custom override, favorite!
    const applied = await h.libraryService.applyRelink([
      { trackId: lostTrack.id, newFilePath: newMovedPath },
    ]);
    assert.equal(applied.relinkedCount, 1);

    const relinkedTrack = h.trackRepo.findById(lostTrack.id)!;
    assert.equal(relinkedTrack.status, 'available');
    assert.equal(relinkedTrack.title, 'Tên Đã Sửa Trước Khi Move');
    assert.deepEqual(h.playlistRepo.findById(pl.id)!.trackIds, [lostTrack.id]);
    assert.deepEqual(h.playlistRepo.getFavoriteTrackIds(), [lostTrack.id]);

    // Test AbortSignal cancellation cleanly during discovery
    const ac = new AbortController();
    ac.abort();
    const abortedDiscovery = await discoverAudioFilesInFolder(parentMusic, { signal: ac.signal });
    assert.equal(abortedDiscovery.canceled, true);
  } finally {
    h.cleanup();
  }
});

test('Phase 3J: Natural numeric sorting & distinct folder hierarchy for same-named directories', () => {
  const sortedNames = ['Track 10.flac', 'Track 2.flac', 'Track 1.flac'].sort(naturalCompare);
  assert.deepEqual(sortedNames, ['Track 1.flac', 'Track 2.flac', 'Track 10.flac']);

  const tracks = [
    {
      id: '1',
      original_path: 'D:\\Anime\\OST\\01 Opening.flac',
      title: 'Opening',
      artist: 'A',
      trackNumber: 1,
      status: 'available',
    },
    {
      id: '2',
      original_path: 'D:\\Games\\OST\\10 Boss.flac',
      title: 'Boss',
      artist: 'B',
      trackNumber: 10,
      status: 'available',
    },
    {
      id: '3',
      original_path: 'D:\\Games\\OST\\2 Town.flac',
      title: 'Town',
      artist: 'B',
      trackNumber: 2,
      status: 'available',
    },
  ];

  const { foldersByKey } = buildFolderHierarchy(tracks);
  const ostFolders = Array.from(foldersByKey.values()).filter((f) => f.folderName === 'OST');
  // Two distinct folders named 'OST' under Anime vs Games MUST remain separate!
  assert.equal(ostFolders.length, 2);
  assert.equal(isTrackInsideFolder(tracks[0].original_path, 'd:\\games', true), false);
  assert.equal(isTrackInsideFolder(tracks[1].original_path, 'd:\\games', true), true);
  assert.equal(isTrackInsideFolder(tracks[1].original_path, 'd:\\games', false), false);

  const byFile = [tracks[1], tracks[2]].sort(compareTracksByFileName);
  assert.deepEqual(
    byFile.map((t) => t.id),
    ['3', '2'],
  );

  const byNum = [tracks[1], tracks[2]].sort(compareTracksByTrackNumber);
  assert.deepEqual(
    byNum.map((t) => t.id),
    ['3', '2'],
  );
});

test('Phase 3L: Performance sanity benchmark on 2,000 SQLite tracks & 10,000-track folder hierarchy/natural sort', () => {
  const h = createTempHarness();
  try {
    const startBatch = performance.now();
    const bulkInputs = Array.from({ length: 2000 }, (_, i) => ({
      original_path: `C:\\Music\\Folder_${i % 40}\\Track_${i + 1}.flac`,
      normalized_path: `c:\\music\\folder_${i % 40}\\track_${i + 1}.flac`,
      title: `Bài Hát Số ${i + 1}`,
      artist: `Nghệ Sĩ ${i % 50}`,
      album: `Album ${i % 80}`,
      track_number: (i % 20) + 1,
      duration_ms: 200000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 48000,
      bit_depth: 24,
      bitrate_bps: 1500000,
      file_size_bytes: 25_000_000,
      modified_at_ms: 1700000000000 + i,
      status: 'available' as const,
    }));
    h.trackRepo.upsertBatch(bulkInputs);
    const loaded = h.trackRepo.findAll();
    const sqliteElapsedMs = Math.round(performance.now() - startBatch);
    assert.equal(loaded.length, 2000);
    assert.ok(sqliteElapsedMs < 3000, `SQLite 2000-track batch took ${sqliteElapsedMs}ms`);

    const tenK = Array.from({ length: 10_000 }, (_, i) => ({
      id: String(i),
      original_path: `D:\\Archive\\Dir_${i % 100}\\Sub_${i % 10}\\Track ${(i % 50) + 1}.flac`,
      title: `Track ${(i % 50) + 1}`,
      artist: `Artist ${i % 40}`,
      trackNumber: (i % 50) + 1,
      status: 'available',
    }));
    const startHier = performance.now();
    const { foldersByKey } = buildFolderHierarchy(tenK);
    const hierElapsedMs = Math.round(performance.now() - startHier);
    assert.ok(foldersByKey.size >= 100);
    assert.ok(hierElapsedMs < 2000, `Folder hierarchy for 10k tracks took ${hierElapsedMs}ms`);
  } finally {
    h.cleanup();
  }
});
